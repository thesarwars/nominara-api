import type { ToolRunStatus } from "../../../contracts/tools/index.js";

// STORY-078 AC5 + AC7 - what a finished run is called, and whether its charge is returned.
//
//   nothing captured  -> `failed`, refunded IN FULL
//   some engines fail -> `partial`, charged IN FULL, and the row says so through engines_succeeded / engines_failed
//   every engine ok   -> `completed`
//
// Pro-rating a partial run is deliberately not offered (story Technical notes): the figure the customer approved must be the figure
// they paid, and a customer should never have to reason about which engines counted.
//
// A tool with no engine set (AUX audit, Schema Builder, Compare Runs) has no per-engine evidence, so its own run states whether it failed.

export interface ToolRunOutcomeInput {
  readonly engineKeys: readonly string[];
  readonly enginesSucceeded: readonly string[];
  readonly enginesFailed: readonly string[];
  /** Only read for a tool with no engine set. */
  readonly failed?: boolean;
}

export interface ToolRunOutcome {
  readonly status: Extract<ToolRunStatus, "completed" | "partial" | "failed">;
  readonly refund: boolean;
}

export function deriveToolRunOutcome(input: ToolRunOutcomeInput): ToolRunOutcome {
  const allowed = new Set(input.engineKeys);
  for (const engine of [...input.enginesSucceeded, ...input.enginesFailed]) {
    if (!allowed.has(engine)) throw new Error(`engine '${engine}' is not in the run's engine set`);
  }
  if (input.engineKeys.length === 0) return input.failed === true ? { status: "failed", refund: true } : { status: "completed", refund: false };
  if (input.enginesSucceeded.length === 0) return { status: "failed", refund: true };
  if (input.enginesFailed.length > 0) return { status: "partial", refund: false };
  return { status: "completed", refund: false };
}
