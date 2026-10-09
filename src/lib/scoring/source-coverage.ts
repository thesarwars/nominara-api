// STORY-169 — `scoring-models.md` §5 and §7 ("Source Coverage is reported
// alongside AUX ... not folded into a composite").
//
// ⚠ IMPORTS NOTHING. See prominence.ts.

/** Clamp to [0,1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** `schemas/sources-and-rollups.md` — `project_source_index.gap_severity`. */
export type GapSeverity = "none" | "low" | "medium" | "high" | "critical";

export interface SourceCoverageDomain {
  /** `context_weight(d)` — normalised to sum to 1 across every domain in the window. */
  readonly contextWeight: number;
  readonly gapSeverity: GapSeverity;
}

/**
 * §7 — `SourceCoverage = 100 · (1 − Σ_{d : gap_severity ∈ {critical, high}} context_weight(d))`.
 *
 * NULL ON AN EMPTY WINDOW, never 100. A project with no `project_source_index`
 * rows has not been measured, and reporting full coverage would assert a
 * result nobody has looked for — the same distinction every other score in
 * this library draws between "no data" and "a good score".
 */
export function sourceCoverage(domains: readonly SourceCoverageDomain[]): number | null {
  if (domains.length === 0) return null;
  const gapWeight = domains
    .filter((domain) => domain.gapSeverity === "critical" || domain.gapSeverity === "high")
    .reduce((total, domain) => total + domain.contextWeight, 0);
  // `context_weight` is normalised to sum to 1 across ALL domains in the
  // window, so `gapWeight` is a subset sum in [0,1] by construction. Clamped
  // anyway — a caller passing an un-normalised or stale set should get a
  // valid 0–100 figure rather than a number outside the range every other
  // score in the product promises.
  return 100 * clamp01(1 - gapWeight);
}
