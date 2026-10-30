import type { NotificationSeverity } from "../../../contracts/notifications/index.js";

// STORY-068 — scoring-models.md §15, the ALERT RULE CATALOG, transcribed. Every number here is the reference's.
//
// THIS IS NOT src/lib/alerts. That directory is the operational pager (DlqDepthMonitor, BlackoutMonitor, the ops email
// adapter): alerts to US. This catalog is alerts to the CUSTOMER, written to `notifications`.
//
// ONE EVALUATOR. A content rule's CONDITION — the window versus the prior window, the `n >= 30` sample floor in both,
// the day-level sustain — is the task generator's (src/lib/taskgen, the `task_generation_rules` row it "Generates"), so
// the alert and its task can never disagree about whether the condition held. This file adds what §15 says about the
// ALERT: its severity, its cooldown and where it is diagnosed. A rule whose task rule is a pending analysis (D2/D4) or
// disabled raises nothing until its facts exist.
//
// THE EXCEPTIONS §15 NAMES:
//   * `displacement_detected` has NO cooldown — every high-impact loss surfaces (AC4). It is raised from the
//     `displacement_events` row itself, so an event with no seedable citation gap (which plans no authority task) still
//     alerts; its event key is the event's id.
//   * `aux_critical` has none either: each new critical finding (and each regression) is its own event.
//   * `engine_blackout` is INTERNAL ONLY (AC5): it is our problem, not the customer's. It routes to the ops pager
//     (src/lib/engines/blackout.ts pages under this rule's code) and never writes a notification; the customer sees the
//     degraded engine and the annotated data gap the degradation ladder already provides.
//   * `quota_threshold` fires once per threshold per cycle (AC7), from the counter row's own stamp, not on a cooldown.
//   * `ai_substitution` is post-launch: catalogued so the table is whole, never evaluated.

export type AlertRoute = "customer" | "ops_pager";

export interface AlertRule {
  readonly code: string;
  readonly severity: NotificationSeverity;
  /** Days. `null` is "no cooldown" (or, for `quota_threshold`, "once per threshold" instead). */
  readonly cooldownDays: number | null;
  /** The `task_generation_rules.code` it generates (`TG-AUX-*` = every AUX rule's task), or null. */
  readonly generates: string | null;
  readonly internal: boolean;
  readonly route: AlertRoute;
  readonly postLaunch: boolean;
}

const rule = (code: string, severity: NotificationSeverity, cooldownDays: number | null, generates: string | null, extra: Partial<AlertRule> = {}): AlertRule =>
  Object.freeze({ code, severity, cooldownDays, generates, internal: false, route: "customer" as const, postLaunch: false, ...extra });

export const ALERT_CATALOG: readonly AlertRule[] = Object.freeze([
  rule("sov_drop_engine", "warning", 7, "TG-SOV-DROP-ENGINE"),
  rule("sov_drop_global", "critical", 7, "TG-SOV-DROP-GLOBAL"),
  rule("presence_loss", "warning", 7, "TG-PRESENCE-LOSS"),
  // Owner decision 21: raised through the reason-class rule (one task per distinct negative reason). TG-SENTIMENT-NEGATIVE stays a pending
  // cell-rate rule and no alert maps to it. A crossing is the section 6 level AND the section 15 rise (decision 22), judged by the A6 analysis.
  rule("negative_spike", "critical", 3, "TG-SENTIMENT-REASON"),
  rule("citation_loss", "warning", 7, "TG-CITATION-LOSS"),
  rule("competitor_overtake", "warning", 14, "TG-COMPETITOR-GAIN"),
  // "30 d per domain": the cooldown scope is the domain (the task fingerprint is per project and domain).
  rule("source_gap_critical", "warning", 30, "TG-SOURCE-ABSENCE"),
  rule("aux_critical", "critical", null, "TG-AUX-*"),
  // 24 h. BlackoutMonitor holds the cooldown (BLACKOUT_PAGE_COOLDOWN_MS); it is stated here in days for the table.
  rule("engine_blackout", "critical", 1, null, { internal: true, route: "ops_pager" }),
  rule("stability_collapse", "info", 14, "TG-PROMPT-UNSTABLE"),
  rule("displacement_detected", "critical", null, "TG-DISPLACEMENT-RECOVER"),
  rule("rendering_downgrade", "warning", 7, "TG-RENDER-SCHEMA"),
  rule("entity_node_missing", "warning", 30, "TG-ENTITY-NODE"),
  rule("divergence_high", "warning", 14, "TG-DIVERGENCE"),
  rule("topic_gap_high", "info", 30, "TG-TOPIC-CONTENT"),
  rule("ai_substitution", "warning", 14, "TG-SUBSTITUTION-REVIEW", { postLaunch: true }),
  rule("quota_threshold", "warning", null, null),
]);

const BY_CODE = new Map(ALERT_CATALOG.map((entry) => [entry.code, entry]));

export function alertRule(code: string): AlertRule {
  const found = BY_CODE.get(code);
  if (found === undefined) throw new Error(`no alert rule '${code}' in the §15 catalog`);
  return found;
}

/** The customer-facing alert a generated task's rule maps to; never an internal or post-launch rule. */
export function alertRuleForTask(taskRuleCode: string): AlertRule | undefined {
  for (const entry of ALERT_CATALOG) {
    if (entry.internal || entry.postLaunch || entry.generates === null) continue;
    if (entry.generates.endsWith("*") ? taskRuleCode.startsWith(entry.generates.slice(0, -1)) : entry.generates === taskRuleCode) return entry;
  }
  return undefined;
}

/** The notification kind an alert is written under. */
export function alertKind(code: string): string {
  return `alert.${code}`;
}
