import type { ClientBase } from "pg";

// STORY-031 OWNER DECISION 2026-10-26 (10). RED: the surface only.

export interface EngineSkipRefundSweepResult {
  readonly refundedRuns: number;
}

export function sweepEngineSkipRefunds(_client: ClientBase, _now: Date): Promise<EngineSkipRefundSweepResult> {
  return Promise.reject(new Error("not implemented"));
}
