import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { Redis } from "ioredis";
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
