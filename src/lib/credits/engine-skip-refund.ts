import type { ClientBase } from "pg";

// STORY-031 OWNER DECISION 2026-10-26 (10). RED: the surface only.

export interface EngineSkipRefundInput {
  readonly workspaceId: string;
  readonly runId: string;
}

export interface EngineSkipRefundOutcome {
  readonly refunded: number;
  readonly skippedCells: number;
}

export function settleEngineSkippedCells(_tx: ClientBase, _input: EngineSkipRefundInput): Promise<EngineSkipRefundOutcome> {
  return Promise.reject(new Error("not implemented"));
}
