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

export type AuxSeverityBand = "critical" | "high" | "medium" | "low" | "info";
const BANDS: readonly AuxSeverityBand[] = ["info", "low", "medium", "high", "critical"];

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
  | { readonly kind: "resolve"; readonly id: string };

/** Statuses a later clean audit may close. */
const RESOLVABLE: ReadonlySet<FindingStatus> = new Set(["open", "acknowledged", "in_progress", "regressed"]);

export function reconcileFindings(input: {
  readonly existing: readonly ExistingFinding[];
  readonly detected: readonly DetectedFinding[];
  /** True when this audit looked in the place (rule AND url) the finding lives, and got a reliable answer. */
  readonly inScope: (finding: ExistingFinding) => boolean;
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
    if (RESOLVABLE.has(row.status) && input.inScope(row)) actions.push({ kind: "resolve", id: row.id });
  }
  return actions;
}
