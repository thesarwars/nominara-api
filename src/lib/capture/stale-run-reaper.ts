import type { ClientBase } from "pg";

// NEW-A-13 checkpoint-4 — STUB (RED): signatures only, no behaviour.

/** How long a scheduled run may sit `queued` before it is presumed lost. */
export const STALE_QUEUED_RUN_BOUND_MS = 6 * 60 * 60 * 1000;

export interface ReapResult {
  readonly reaped: number;
}

export async function reapStaleQueuedRuns(
  _client: ClientBase,
  _now: Date,
  _boundMs: number = STALE_QUEUED_RUN_BOUND_MS,
): Promise<ReapResult> {
  return { reaped: 0 };
}
