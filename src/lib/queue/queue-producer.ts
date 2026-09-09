import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { Redis } from "ioredis";
import { dispatchCaptureCells } from "../capture/dispatch-cells.js";
import type { PlannedRun } from "../capture/plan-run.js";
import { signQueueJobPayload, type TenantScopedPayload } from "./envelope.js";
import { buildQueue, enqueueJob, type PriorityVariant } from "./queue-factory.js";
import { QUEUE_TOPOLOGY, type QueueTopologyEntry } from "./topology.js";
import type { QueueName } from "./handlers.js";
import type { RotatingSigningKeys } from "./signing.js";

// STORY-043 — the producer side of the queue, in the API process.
//
// worker.ts builds queues to CONSUME from; nothing built one to produce to,
// so no request path could enqueue anything. topology.ts has always named
// `POST /projects` as `crawl.discover`'s producer — this is the seam that
// makes that line true rather than aspirational.
//
// One Redis connection for every queue, and a Queue object built lazily per
// name and cached. BullMQ opens a connection per Queue when given connection
// OPTIONS; given an existing client it reuses it. An API process that
// produced to eight queues would otherwise hold eight connections to say
// almost nothing, and connection count is the first thing that bites a
// pooled Redis.

export const QUEUE_PRODUCER_CONNECTION = Symbol("QUEUE_PRODUCER_CONNECTION");
export const QUEUE_PRODUCER_PREFIX = Symbol("QUEUE_PRODUCER_PREFIX");
export const QUEUE_PRODUCER_SIGNING_KEYS = Symbol("QUEUE_PRODUCER_SIGNING_KEYS");

const TOPOLOGY_BY_NAME = new Map<string, QueueTopologyEntry>(QUEUE_TOPOLOGY.map((entry) => [entry.name, entry]));

export interface EnqueueTenantJobOptions {
  readonly idempotencyKey: string;
  readonly priorityVariant?: PriorityVariant;
}

/** A queue name that is not in the topology — a typo, or a name removed from §4. */
export class UnknownQueueError extends Error {
  constructor(name: string) {
    super(`no topology entry for queue "${name}"`);
    this.name = "UnknownQueueError";
  }
}

@Injectable()
export class QueueProducer implements OnModuleDestroy {
  private readonly logger = new Logger(QueueProducer.name);
  private readonly queues = new Map<string, Queue>();

  constructor(
    @Inject(QUEUE_PRODUCER_CONNECTION) private readonly connection: Redis,
    @Inject(QUEUE_PRODUCER_PREFIX) private readonly prefix: string,
    @Inject(QUEUE_PRODUCER_SIGNING_KEYS) private readonly keys: RotatingSigningKeys,
  ) {}

  /**
   * Signs a tenant-scoped payload with the CURRENT key and enqueues it.
   *
   * `kid` travels in the payload so a worker running through a key rotation
   * can verify with the previous key — the producer never needs to know which
   * key a given consumer holds.
   */
  async enqueueTenantJob<P extends Record<string, unknown>>(
    name: QueueName,
    workspaceId: string,
    payload: P,
    options: EnqueueTenantJobOptions,
  ): Promise<Job> {
    const entry = TOPOLOGY_BY_NAME.get(name);
    if (entry === undefined) throw new UnknownQueueError(name);

    const signed: TenantScopedPayload = { ...payload, workspaceId, kid: this.keys.current.kid };
    const envelope = signQueueJobPayload(signed, this.keys.current.key);

    return enqueueJob(this.queueFor(entry), entry, envelope, {
      idempotencyKey: options.idempotencyKey,
      ...(options.priorityVariant !== undefined ? { priorityVariant: options.priorityVariant } : {}),
    });
  }

  /**
   * STORY-034 — the BATCH producer, and the place a planned run gets SIGNED.
   *
   * `dispatchCaptureCells` builds one `addBulk` with per-cell jitter and the
   * deduplication identity `enqueueJob` would have given each job, and it
   * takes a raw `Queue` because STORY-032 had no producer to hand. It
   * therefore enqueued `cell.payload` VERBATIM — unsigned — and
   * `createJobProcessor` runs `verify(tenantJob)` as its first executable
   * statement. Every one of those cells would have been rejected by the first
   * capture handler to exist. Nothing caught it because no handler existed.
   *
   * Signing here rather than in `plan-run.ts` keeps the key where the other
   * producer already holds it: planning happens inside a database
   * transaction and has no business holding an HMAC key.
   */
  async dispatchPlannedCells(name: QueueName, plan: PlannedRun): Promise<Job[]> {
    const entry = TOPOLOGY_BY_NAME.get(name);
    if (entry === undefined) throw new UnknownQueueError(name);

    return dispatchCaptureCells(
      this.queueFor(entry),
      entry,
      plan.cells.map((cell) => ({
        ...cell,
        payload: signQueueJobPayload(
          { ...(cell.payload as Record<string, unknown>), kid: this.keys.current.kid } as TenantScopedPayload,
          this.keys.current.key,
        ),
      })),
      { cadence: plan.cadence },
    );
  }

  /**
   * STORY-034 AC5 — remove the jobs a cancelled run left waiting.
   *
   * "Cancellation DRAINS QUEUED CELLS and marks the run cancelled; IN-FLIGHT
   * CELLS COMPLETE rather than being abandoned mid-write." That distinction
   * is the whole method: only `waiting` and `delayed` jobs are removed.
   * BullMQ's own `job.remove()` refuses a job that is active, and this does
   * not try to force one — the story's note says why. "Draining rather than
   * killing in-flight cells avoids a half-written fact set, which the
   * application-enforced integrity would then report as an orphan."
   *
   * Returns how many were removed, so a caller can report a drain that found
   * nothing differently from one it never ran.
   */
  async drainWaiting(name: QueueName, matches: (data: unknown) => boolean): Promise<number> {
    const entry = TOPOLOGY_BY_NAME.get(name);
    if (entry === undefined) throw new UnknownQueueError(name);

    const queue = this.queueFor(entry);
    const jobs = await queue.getJobs(["waiting", "delayed", "prioritized", "wait"]);
    let removed = 0;
    for (const job of jobs) {
      if (!matches(job.data)) continue;
      // Best-effort per job. A job that became active between the read above
      // and this call throws, and that is the CORRECT outcome — it is now
      // in-flight and must be allowed to finish. Failing the whole cancel
      // because one cell started would leave the run marked running.
      try {
        await job.remove();
        removed += 1;
      } catch (error) {
        this.logger.debug(`drain skipped job ${String(job.id)} on ${name}: ${String(error)}`);
      }
    }
    return removed;
  }

  private queueFor(entry: QueueTopologyEntry): Queue {
    const existing = this.queues.get(entry.name);
    if (existing) return existing;
    const queue = buildQueue(entry, { connection: this.connection, prefix: this.prefix });
    this.queues.set(entry.name, queue);
    return queue;
  }

  /**
   * Closes every queue built, but NOT the shared connection.
   *
   * The connection is a provider this class was given, not one it created, so
   * closing it here would tear down something another provider may still hold
   * — the ownership rule that keeps shutdown order from mattering.
   */
  async onModuleDestroy(): Promise<void> {
    for (const [name, queue] of this.queues) {
      await queue.close().catch((error: unknown) => {
        this.logger.warn(`failed to close producer queue "${name}": ${String(error)}`);
      });
    }
    this.queues.clear();
  }
}
