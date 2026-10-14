import type { Job, JobsOptions, Queue } from "bullmq";
import type { QueueTopologyEntry } from "../queue/topology.js";
import { attemptsFor, resolvePriority, type PriorityVariant } from "../queue/queue-factory.js";

// STORY-032 AC13 — dispatching a planned run's live cells: one batch, with
// per-cell jitter.
//
// WHY JITTER, and the second reason is the one worth remembering.
// tracking-engine.md §5: "Capturing all tenants at midnight would spike
// vendor rate limits AND systematically sample one diurnal slice." The first
// is a load problem and would show up as vendor 429s. The second is an
// ACCURACY problem and would show up as nothing at all — every tenant's
// numbers drawn from the same moment of the day, with no symptom beyond a
// dataset that quietly describes midnight rather than the day.
//
// The cadence values below are the DATABASE's (`projects.cadence`:
// hourly | daily | twice_weekly | weekly | manual). §5's table names two of
// them differently — `daily_priority` and `hourly_priority` — while giving
// the same five rows. The numbers here are §5's; the keys are the schema's,
// because that is what a project row actually holds. RECORDED RATHER THAN
// RECONCILED: renaming either side is a change to a reference or a CHECK
// constraint, and neither is this story's to make.

/** `projects.cadence` — the schema's own enum. */
export type ProjectCadence = "hourly" | "daily" | "twice_weekly" | "weekly" | "manual";

/** §5's Jitter column, in milliseconds. A cell is delayed by a uniform draw from `[0, max]`. */
export const CADENCE_JITTER_MAX_MS: Readonly<Record<ProjectCadence, number>> = Object.freeze({
  // §5 `hourly_priority` — 45 min window, 0–300 s.
  hourly: 300_000,
  // §5 `daily_priority` — 4 h window, 0–900 s.
  daily: 900_000,
  twice_weekly: 3_600_000,
  weekly: 3_600_000,
  // "immediate". A manual run is someone waiting for an answer, and spreading
  // it across an hour to protect a diurnal sample nobody is measuring would
  // trade a real user's time for nothing.
  manual: 0,
});

export interface DispatchCell {
  readonly promptId: string;
  readonly engineKey: string;
  readonly sampleIndex: number;
  /** Whatever the capture worker needs — this module does not inspect it. */
  readonly payload: unknown;
  /** Deduplication identity, so a replayed plan produces at most one job per cell. */
  readonly idempotencyKey: string;
}

export interface DispatchOptions {
  readonly cadence: ProjectCadence;
  readonly priorityVariant?: PriorityVariant;
  readonly dedupTtlMs?: number;
  /** Injected so a test can assert the DISTRIBUTION rather than one sampled draw. */
  readonly random?: () => number;
}

/**
 * The delay for one cell: a uniform draw from `[0, max]`.
 *
 * Per CELL, not per run. One delay applied to the whole batch would move the
 * spike rather than remove it — every cell of that run still lands in the
 * same instant, which is precisely the diurnal-slice problem for that tenant.
 */
export function cellJitterMs(cadence: ProjectCadence, random: () => number = Math.random): number {
  const max = CADENCE_JITTER_MAX_MS[cadence];
  // Clamped, and `max * random()` rather than `(max + 1) * random()`. The
  // `+ 1` form makes a draw of exactly 1 return max + 1 — one millisecond
  // outside the range §5 states. Math.random() never returns 1, so it would
  // never have fired in production; a bound that holds only because of a
  // detail of the caller is not a bound, and an injected random() in a test
  // is exactly the caller that breaks it.
  return Math.min(max, Math.floor(random() * max));
}

/**
 * Enqueues every live cell in ONE `addBulk`, each with its own jitter.
 *
 * One round trip rather than one per cell, for the same reason both cache
 * probes are batched: a run with hundreds of cells that issues hundreds of
 * enqueues spends longer dispatching than the dispatch is worth, and the cost
 * is invisible until a large project appears.
 *
 * Every job keeps the deduplication identity `enqueueJob` would have given
 * it, so replaying a plan still produces at most one job per cell. This is
 * the batch counterpart of that function and deliberately mirrors its option
 * construction rather than re-deriving priority and attempts.
 */
export async function dispatchCaptureCells(
  queue: Queue,
  entry: QueueTopologyEntry,
  cells: readonly DispatchCell[],
  options: DispatchOptions,
): Promise<Job[]> {
  if (cells.length === 0) return [];

  const random = options.random ?? Math.random;
  const base: Omit<JobsOptions, "delay" | "deduplication"> = {
    priority: resolvePriority(entry, options.priorityVariant),
    attempts: attemptsFor(entry),
    removeOnComplete: entry.removeOnComplete,
    removeOnFail: entry.removeOnFail,
    ...(entry.retry.delaysMs.length > 0 ? { backoff: { type: "custom" as const } } : {}),
  };

  return queue.addBulk(
    cells.map((cell) => ({
      name: entry.name,
      data: cell.payload,
      opts: {
        ...base,
        delay: cellJitterMs(options.cadence, random),
        deduplication: {
          id: cell.idempotencyKey,
          ttl: options.dedupTtlMs ?? entry.removeOnComplete.age * 1000,
        },
      },
    })),
  );
}

/**
 * STORY-032 AC7 (owner decision 2026-10-13) — one reused (L1/L2) row whose answer must be re-matched against the
 * CURRENT alias set. It is the `capture.parse` payload minus the signature: the row stays `status = 'skipped'` (so
 * run counts, settlement and refunds are unchanged) and the parse carries the facts onto it.
 */
export interface RematchJob {
  readonly workspaceId: string;
  readonly resultId: string;
  readonly projectId: string;
  readonly promptId: string;
  readonly engineKey: string;
  readonly capturedAt: string;
}

/** The idempotency key of a re-match parse — `capture.parse`'s own `parse:{result}` pattern, shared with `capture.execute`. */
export function rematchIdempotencyKey(resultId: string): string {
  return `parse:${resultId}`;
}

/** The re-match parses as dispatchable cells (cadence-independent: they are not jittered). */
export function rematchDispatchCells(jobs: readonly RematchJob[]): DispatchCell[] {
  return jobs.map((job) => ({
    promptId: job.promptId,
    engineKey: job.engineKey,
    sampleIndex: 0,
    payload: { ...job },
    idempotencyKey: rematchIdempotencyKey(job.resultId),
  }));
}
