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
  /**
   * OWNER DECISION 67g: some cell (one prompt asked of one engine) failed even though every engine answered something. A run that would be `completed` is then
   * `partial`. Charging is unchanged: partial is charged in full, and a run that captured nothing is still `failed` and refunded.
   */
  readonly cellsFailed?: boolean;
}

export interface ToolRunOutcome {
  readonly status: Extract<ToolRunStatus, "completed" | "partial" | "failed">;
  readonly refund: boolean;
  /**
   * What `engines_failed` is stored as: the engines the caller reported failed PLUS every engine in the set that was reported by neither
   * list (a timed-out engine never reports). An engine that did not answer is a failure, whoever forgot to say so; in the run's engine order.
   */
  readonly enginesFailed: readonly string[];
}

export function deriveToolRunOutcome(input: ToolRunOutcomeInput): ToolRunOutcome {
  const allowed = new Set(input.engineKeys);
  for (const engine of [...input.enginesSucceeded, ...input.enginesFailed]) {
    if (!allowed.has(engine)) throw new Error(`engine '${engine}' is not in the run's engine set`);
  }
  const succeeded = new Set(input.enginesSucceeded);
  const reportedFailed = new Set(input.enginesFailed);
  for (const engine of succeeded) {
    if (reportedFailed.has(engine)) throw new Error(`engine '${engine}' is listed as both succeeded and failed`);
  }
  if (input.engineKeys.length === 0) return { status: input.failed === true ? "failed" : "completed", refund: input.failed === true, enginesFailed: [] };
  const enginesFailed = [...new Set(input.engineKeys)].filter((engine) => !succeeded.has(engine));
  if (succeeded.size === 0) return { status: "failed", refund: true, enginesFailed };
  if (enginesFailed.length > 0) return { status: "partial", refund: false, enginesFailed };
  if (input.cellsFailed === true) return { status: "partial", refund: false, enginesFailed: [] };
  return { status: "completed", refund: false, enginesFailed: [] };
}
