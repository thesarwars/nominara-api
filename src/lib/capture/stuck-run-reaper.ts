import type { ClientBase } from "pg";
import type { EnqueueRollup } from "../queue/handlers/run-rollup-request.js";
import { STALE_QUEUED_RUN_BOUND_MS } from "./stale-run-reaper.js";

// SCANFIX D4 - RED stub. The behaviour lands in the fix commit.

/** How long a run may show no activity before it is presumed stuck. */
export const STUCK_RUN_GRACE_MS = STALE_QUEUED_RUN_BOUND_MS;

export interface StuckRunResult {
  readonly finalized: number;
}

export function reapStuckRuns(
  _client: ClientBase,
  _now: Date,
  _options: { readonly enqueueRollup: EnqueueRollup; readonly graceMs?: number },
): Promise<StuckRunResult> {
  return Promise.resolve({ finalized: 0 });
}
