import { Logger } from "@nestjs/common";
import { Queue, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import { incrementCounter } from "../telemetry/metrics.js";
import type { QueueTopologyEntry } from "./topology.js";

const logger = new Logger("dead-letter-queue");

// STORY-030 Phase B — system-architecture.md §4 "DLQ policy": "Failed jobs
// land in `{queue}.dlq` with the full payload and last error. Depth > 50 for
// 10 minutes pages on-call. DLQ jobs are replayable from `AdminModule` with
// a new idempotency suffix." Admin replay (AC7) is a separate, later story
// (needs AdminModule) — this file only builds the DLQ queue itself, the
// terminal-failure handler that writes into it, and the depth-paging
// mechanism.

export function dlqQueueName(queueName: QueueTopologyEntry["name"]): string {
  return queueName + ".dlq";
}

export const dlqEntrySchema = z
  .object({
    queue: z.string().min(1),
    jobId: z.string().min(1),
    /** The original job's enqueue-time idempotency key (BullMQ's `deduplicationId`) — AC7 replay derives its new suffix from this. Optional so a pre-existing DLQ entry recorded before this field existed still parses. */
    idempotencyKey: z.string().min(1).optional(),
    /** The exact original job payload, byte-identical — never re-derived or summarized. */
    payload: z.unknown(),
    error: z
      .object({
        name: z.string(),
        message: z.string(),
        stack: z.string().optional(),
      })
      .strict(),
    attemptsMade: z.number().int().nonnegative(),
    failedAt: z.string().datetime({ offset: true }),
    /** Set once AdminService.replayDeadLetterJob (AC7) has replayed this entry — a DLQ entry is replayed at most once; absent means never replayed. */
    replayedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type DlqEntry = z.infer<typeof dlqEntrySchema>;

export interface BuildDlqQueueOptions {
  readonly connection: Redis;
  readonly prefix: string;
}

/** The `{queue}.dlq` queue is pure storage — nothing ever runs a Worker against it; only an explicit admin replay (AdminModule, a later story) moves an entry back out. */
export function buildDlqQueue(entry: QueueTopologyEntry, options: BuildDlqQueueOptions): Queue {
  return new Queue(dlqQueueName(entry.name), {
    connection: options.connection,
    prefix: options.prefix,
  });
}

/**
 * A job processor's contract is `Promise<T>` — nothing stops it throwing a
 * bare string or plain object instead of an `Error`, and BullMQ's own
 * Worker passes whatever was thrown straight through to the "failed" event
 * with no `instanceof Error` normalization of its own. Fails closed: every
 * throw, of any shape, becomes a usable `{name, message, stack?}` — never
 * `undefined` fields that would make the DLQ write itself throw (dropping
 * the very entry the DLQ exists to preserve).
 */
function normalizeThrown(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  }
  if (typeof error === "string") {
    return { name: "NonErrorThrow", message: error };
  }
  try {
    return { name: "NonErrorThrow", message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { name: "NonErrorThrow", message: String(error) };
  }
}

function toDlqEntry(entry: QueueTopologyEntry, job: Job, error: unknown): DlqEntry {
  return dlqEntrySchema.parse({
    queue: entry.name,
    jobId: String(job.id),
    ...(job.deduplicationId ? { idempotencyKey: job.deduplicationId } : {}),
    payload: job.data,
    error: normalizeThrown(error),
    attemptsMade: job.attemptsMade,
    failedAt: new Date().toISOString(),
  });
}

/**
 * Writes `job`'s full original payload and last error into `entry`'s DLQ
 * queue. Added with `attempts: 1` and no backoff — a DLQ entry is a
 * terminal record, never itself retried by a worker. `error` is `unknown`,
 * not `Error` — see normalizeThrown above.
 */
export async function recordDeadLetter(dlqQueue: Queue, entry: QueueTopologyEntry, job: Job, error: unknown): Promise<void> {
  const dlqEntry = toDlqEntry(entry, job, error);
  await dlqQueue.add(dlqQueueName(entry.name), dlqEntry, { attempts: 1 });
}

/**
 * Answers the one question the dead-letter handler needs: will BullMQ run
 * this job again?
 *
 * ⚠ PHRASED AS "WILL IT CERTAINLY COME BACK", NOT "IS IT TERMINAL", AND THE
 * DIRECTION IS THE POINT. The two ways to be wrong here are not symmetric: a
 * spurious DLQ entry is a duplicate an operator dismisses, while a missing one
 * is silent data loss on the queue whose entire purpose is to not be silent.
 * So this returns true only when two independent signals AGREE the job is
 * coming back, and everything else — including whatever BullMQ grows next — is
 * treated as terminal and recorded.
 *
 * ⚠ THE ATTEMPT COUNT ALONE IS NOT THE QUESTION, AND BELIEVING IT WAS COST THE
 * AUDIT-CHAIN TAMPER ALARM ITS ONLY OUTPUT. `Job.shouldRetryJob` (bullmq
 * 6.2.0, job.js:448) reads
 *
 *     this.attemptsMade + 1 < this.opts.attempts &&
 *       !(err instanceof UnrecoverableError || err.name == 'UnrecoverableError')
 *
 * and then maps a backoff delay of `-1` to "do not retry". That is THREE ways
 * to be terminal on the FIRST attempt, every one of them invisible to a
 * counter:
 *   1. `UnrecoverableError` by instance — what `audit-verify.handler.ts:129`
 *      throws on a detected tamper, chosen deliberately to get ONE entry a day;
 *   2. `UnrecoverableError` by NAME — duck-typed, and the only one of the two
 *      that survives a serialization boundary;
 *   3. a backoff strategy returning `-1` — which `worker-factory.ts`'s
 *      `adaptBackoffStrategy` returns BY DESIGN once the retry ladder is spent.
 * Measured against a real Valkey: each produces a single `failed` event with
 * `attemptsMade = 1` of 4, and the old counter dropped all three.
 *
 * ⚠ AND `job.isFailed()` IS NOT THE QUESTION EITHER, THOUGH IT READS LIKE IT.
 * It is `isInState('failed')` — a Redis read of the failed SET — so it answers
 * false for a genuinely terminal job that `removeOnFail` has already deleted.
 * Measured: with `removeOnFail: true` or `{ count: 0 }`, a terminal job reports
 * `isFailed() === false`, so a fix built on it would have closed the three
 * paths above and opened a fourth. `topology.ts:55` pins `removeOnFail` to
 * `{ age: … }` for every queue and all three enqueue sites pass
 * `entry.removeOnFail`, so nothing reaches that shape today — which is what
 * makes it a hazard that is latent rather than absent.
 *
 * `finishedOn` is neither proxy. `moveToFailed` declares it fresh and assigns
 * it ONLY in the non-retry branch (job.js:485-503), from a client-built
 * timestamp rather than the Lua script's return value — so it is set if and
 * only if BullMQ decided against a retry, and it is set whether or not the job
 * was then removed. It is also already in memory, costing no round trip on a
 * hot path. The attempt count is kept alongside it as a second, independent
 * witness: if either signal ever regresses, the other still reports the
 * failure rather than losing it.
 */
export function willBullmqRetry(job: Pick<Job, "attemptsMade" | "finishedOn" | "opts">): boolean {
  return job.finishedOn === undefined && job.attemptsMade < (job.opts.attempts ?? 1);
}

/**
 * Attaches the terminal-failure handler to `worker`: every time a job on
 * `entry`'s queue fails and BullMQ will not run it again, its full payload and
 * error land in `entry`'s DLQ. Only jobs that will certainly be retried are
 * left alone — see `willBullmqRetry` for why that is the question asked, and
 * why the obvious two ways of asking it both lose entries.
 */
export function attachDeadLetterHandler(
  worker: { on(event: "failed", listener: (job: Job | undefined, error: unknown) => void): void },
  dlqQueue: Queue,
  entry: QueueTopologyEntry,
): void {
  worker.on("failed", (job, error) => {
    if (!job) return;
    if (willBullmqRetry(job)) return; // certainly coming back — not a terminal failure

    // Code-review fix: recordDeadLetter() is fire-and-forget from the
    // "failed" listener's point of view (the listener itself cannot be
    // async), so a rejection here — the DLQ write itself failing — must
    // never become a silent unhandled rejection. The DLQ is the last line
    // of defense against data loss for a terminally-failed job; failing to
    // even RECORD that failure must be loud. Logs the DLQ-write error
    // itself (never the already-recorded original job error) plus queue and
    // job id, and increments a counter so this is pageable, not just logged.
    recordDeadLetter(dlqQueue, entry, job, error).catch((dlqWriteError: unknown) => {
      logger.error({
        message: `failed to write terminally-failed job to its dead-letter queue`,
        queue: entry.name,
        jobId: String(job.id),
        dlqWriteError: dlqWriteError instanceof Error ? dlqWriteError.message : String(dlqWriteError),
      });
      incrementCounter("nominara_queue_dlq_write_failed_total", { queue: entry.name });
    });
  });
}

// --- Sustained dead-letter depth paging (SLO-24) ---------------------------
// "Sustained dead-letter depth pages. A silent dead-letter queue is a silent
// data-loss queue." Threshold and window are named constants, per the story.

/** SLO-24: DLQ depth threshold that must page on-call once sustained. */
export const DLQ_DEPTH_PAGE_THRESHOLD = 50;
/** SLO-24: how long the depth must stay above the threshold before paging. */
export const DLQ_DEPTH_SUSTAINED_MS = 10 * 60 * 1000;

/**
 * Function-seam port — no real paging backend (PagerDuty et al.) exists yet
 * in this codebase. The default implementation logs at error level and
 * increments a counter via the existing telemetry module; a later story
 * swaps in a real adapter without this monitor's logic changing.
 */
export interface Pager {
  page(message: string, context: Record<string, unknown>): void;
}

export const defaultPager: Pager = {
  page(message, context) {
    logger.error({ message, ...context });
    incrementCounter("nominara_queue_dlq_depth_page_total", { queue: String(context.queue ?? "unknown") });
  },
};

export interface DlqDepthMonitorOptions {
  /** Returns the current time in epoch ms — injectable for deterministic tests. Defaults to Date.now. */
  readonly clock?: () => number;
  readonly pager?: Pager;
  readonly thresholdDepth?: number;
  readonly sustainedMs?: number;
}

/**
 * Tracks, per queue, how long its DLQ depth has stayed above
 * `thresholdDepth`. Pages exactly once per sustained breach — a call to
 * `observe` with a depth back at or below the threshold clears the state, so
 * a later breach pages again.
 */
export class DlqDepthMonitor {
  private readonly clock: () => number;
  private readonly pager: Pager;
  private readonly thresholdDepth: number;
  private readonly sustainedMs: number;
  private readonly aboveSince = new Map<string, number>();
  private readonly alreadyPaged = new Set<string>();

  constructor(options: DlqDepthMonitorOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.pager = options.pager ?? defaultPager;
    this.thresholdDepth = options.thresholdDepth ?? DLQ_DEPTH_PAGE_THRESHOLD;
    this.sustainedMs = options.sustainedMs ?? DLQ_DEPTH_SUSTAINED_MS;
  }

  observe(queueName: string, depth: number): void {
    const now = this.clock();

    if (depth <= this.thresholdDepth) {
      this.aboveSince.delete(queueName);
      this.alreadyPaged.delete(queueName);
      return;
    }

    const since = this.aboveSince.get(queueName);
    if (since === undefined) {
      this.aboveSince.set(queueName, now);
      return;
    }

    if (now - since >= this.sustainedMs && !this.alreadyPaged.has(queueName)) {
      this.alreadyPaged.add(queueName);
      this.pager.page(`dead-letter queue "${dlqQueueName(queueName)}" depth sustained above threshold`, {
        queue: queueName,
        depth,
        thresholdDepth: this.thresholdDepth,
        sustainedMs: this.sustainedMs,
      });
    }
  }
}
