import { createHash } from "node:crypto";

// NEW-C-9 (STORY-052 lifecycle) — aux-and-geo-analysis.md §3, as a PURE
// transition function: existing rows and this audit's detections in, actions
// out. The handler applies the actions; nothing here touches a database or a
// clock, so every transition is a plain unit test.
//
//   * Identity is sha256(rule_code | url | normalised evidence). An audit is a
//     lifecycle update, not an append-only log.
//   * `resolved` is set ONLY here, by an audit that fails to reproduce the
//     finding. No API path exists for a client to set it.
//   * `regressed` re-opens the resolved row (original first_detected_at kept)
//     and raises its severity one band.
//   * `stale` and `wont_fix` are never resolved by absence: "the page is gone"
//     and "the customer accepted it" are not "the problem is gone".
//   * `stale` is the OTHER outcome of absence: a finding this audit could not
//     observe (its file or page did not answer), and the audit before it could not
//     either, goes stale. Resolved needs an audit that LOOKED and did not find it;
//     stale is "nobody could look, twice running". The two are different facts and a
//     deleted page must never read as a fix (STORY-052 AC8).

export type AuxSeverityBand = "critical" | "high" | "medium" | "low" | "info";
const BANDS: readonly AuxSeverityBand[] = ["info", "low", "medium", "high", "critical"];

/** aux-and-geo-analysis.md section 3: "not seen in 2 consecutive audits of the same URL". */
export const STALE_AFTER_AUDITS = 2;

export function raiseOneBand(severity: AuxSeverityBand): AuxSeverityBand {
  return BANDS[Math.min(BANDS.indexOf(severity) + 1, BANDS.length - 1)]!;
}

/**
 * The evidence that defines identity: which file and why. Line numbers,
 * snippets and the list of agents involved are deliberately NOT part of it —
 * they drift between audits of the same defect, and a drifting fingerprint
 * would resolve one finding and open another for a single unchanged problem.
 */
export function findingFingerprint(ruleCode: string, url: string | null, evidence: { file: string; reason: string }): string {
  return createHash("sha256").update([ruleCode, url ?? "", `${evidence.file}:${evidence.reason}`].join("|")).digest("hex");
}

export type FindingStatus = "open" | "acknowledged" | "in_progress" | "resolved" | "regressed" | "wont_fix" | "stale";

export interface ExistingFinding {
  readonly id: string;
  readonly fingerprint: string;
  readonly ruleCode: string;
  readonly url: string | null;
  readonly severity: AuxSeverityBand;
  readonly status: FindingStatus;
  readonly occurrenceCount: number;
  readonly resolvedAt: Date | null;
}

export interface DetectedFinding {
  readonly fingerprint: string;
  readonly ruleCode: string;
  readonly url: string | null;
  readonly severity: AuxSeverityBand;
}

export type LifecycleAction =
  | { readonly kind: "insert"; readonly finding: DetectedFinding }
  | { readonly kind: "redetect"; readonly id: string; readonly reopen: boolean }
  | { readonly kind: "regress"; readonly id: string; readonly severity: AuxSeverityBand }
  | { readonly kind: "resolve"; readonly id: string }
  | { readonly kind: "stale"; readonly id: string };

/** Statuses a later clean audit may close, or that go stale when the place they live cannot be observed. */
const RESOLVABLE: ReadonlySet<FindingStatus> = new Set(["open", "acknowledged", "in_progress", "regressed"]);

export type MilestoneKind = "aux_status_change" | "schema_fixed";

/**
 * scoring-models.md section 13: a critical or high finding that is resolved pins `aux_status_change`; the resolution of a
 * `structured_data` finding pins `schema_fixed`. `ux_milestones_source` allows one pin per finding, so a structured_data
 * finding that qualifies for both gets `schema_fixed`, the more specific. null = this resolution pins nothing.
 */
export function milestoneKindFor(severity: AuxSeverityBand, category: string | null): MilestoneKind | null {
  if (category === "structured_data") return "schema_fixed";
  return severity === "critical" || severity === "high" ? "aux_status_change" : null;
}

export function reconcileFindings(input: {
  readonly existing: readonly ExistingFinding[];
  readonly detected: readonly DetectedFinding[];
  /** True when this audit looked in the place (rule AND url) the finding lives, and got a reliable answer. */
  readonly inScope: (finding: ExistingFinding) => boolean;
  /**
   * How many audits IMMEDIATELY BEFORE this one also could not observe the place the finding lives, counted back from the latest
   * and stopping at the first that could. Absent = no history is known, and nothing goes stale.
   */
  readonly unobservedBefore?: (finding: ExistingFinding) => number;
}): LifecycleAction[] {
  const live = new Map<string, ExistingFinding>();
  const resolved = new Map<string, ExistingFinding>();
  for (const row of input.existing) {
    if (row.status === "resolved") {
      const prior = resolved.get(row.fingerprint);
      if ((row.resolvedAt?.getTime() ?? 0) >= (prior?.resolvedAt?.getTime() ?? 0)) resolved.set(row.fingerprint, row);
    } else if (!live.has(row.fingerprint)) {
      live.set(row.fingerprint, row);
    }
  }

  const actions: LifecycleAction[] = [];
  const seen = new Set<string>();
  for (const d of input.detected) {
    if (seen.has(d.fingerprint)) continue;
    seen.add(d.fingerprint);
    const current = live.get(d.fingerprint);
    if (current !== undefined) {
      actions.push({ kind: "redetect", id: current.id, reopen: current.status === "stale" });
      continue;
    }
    const prior = resolved.get(d.fingerprint);
    if (prior !== undefined) {
      actions.push({ kind: "regress", id: prior.id, severity: raiseOneBand(prior.severity) });
      continue;
    }
    actions.push({ kind: "insert", finding: d });
  }

  for (const row of live.values()) {
    if (seen.has(row.fingerprint)) continue;
    if (!RESOLVABLE.has(row.status)) continue;
    if (input.inScope(row)) {
      actions.push({ kind: "resolve", id: row.id });
    } else if (input.unobservedBefore !== undefined && input.unobservedBefore(row) + 1 >= STALE_AFTER_AUDITS) {
      actions.push({ kind: "stale", id: row.id });
    }
  }
  return actions;
}
