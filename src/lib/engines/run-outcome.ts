// STORY-031 Phase G stage 5 — AC: "the engine renders with a warning
// wherever it appears, and runs complete as `partial` rather than failing."
// D15 — a pure resolver PLUS a port (this file is the resolver only):
// `capture_runs` has no writer yet (STORY-032/034's scope), so this is
// proven in isolation against inputs a future writer will supply, not
// wired into any real run-lifecycle table here.

export type RunOutcome = "success" | "partial" | "failed";

export interface RunOutcomeSignals {
  readonly successCount: number;
  readonly totalCount: number;
  /** Whether ANY engine involved in the run is currently degraded (or was skipped for that reason). */
  readonly hasDegradedEngine: boolean;
}

/**
 * Zero successes → failed, unconditionally (even when the sole reason is a
 * degraded engine — this resolver never invents a "success" or "partial"
 * out of nothing). Otherwise, a run is only "success" when EVERY attempted
 * cell succeeded AND no engine involved was degraded; anything short of
 * that — some cells missing, or a degraded engine skipped entirely — is
 * "partial", never "failed": a run never fails MERELY because one engine
 * is down.
 */
export function resolveRunOutcome(signals: RunOutcomeSignals): RunOutcome {
  if (signals.successCount === 0) {
    return "failed";
  }
  if (signals.hasDegradedEngine || signals.successCount < signals.totalCount) {
    return "partial";
  }
  return "success";
}
