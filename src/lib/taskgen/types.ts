import type { ClientBase } from "pg";

/** A `task_generation_rules` row as the evaluator reads it. `condition` is untrusted jsonb until zod has parsed it. */
export interface RuleRow {
  readonly code: string;
  readonly category: "content" | "technical" | "authority" | "monitoring";
  readonly title_template: string;
  readonly description_template: string;
  readonly trigger_kind: string;
  readonly condition: unknown;
  readonly default_priority: number;
  readonly impact_weight: number;
  readonly effort_band: "xs" | "s" | "m" | "l" | "xl";
  readonly opens_alignment: boolean;
  readonly playbook_slug: string | null;
  readonly cooldown_days: number;
  /** The workspace-local date of the last false-to-true flip of `enabled`, or null when the rule was never switched off. */
  readonly enabled_since_date: string | null;
  /** The instant of that flip (or of the rule's insertion), or null. The watermark every event-driven rule gates on. */
  readonly enabled_since: Date | null;
}

export interface EvalContext {
  readonly tx: ClientBase;
  readonly workspaceId: string;
  readonly projectId: string;
  /** `YYYY-MM-DD`, workspace-local. */
  readonly metricDate: string;
  readonly timezone: string;
  readonly scoringVersion: string;
}

/** What an evaluator found: one task's worth of evidence, before the engine turns it into a task. */
export interface TaskDraft {
  readonly fingerprint: Buffer;
  /** Defaults to the rule's category. */
  readonly kind?: RuleRow["category"];
  readonly vars: Readonly<Record<string, string | number>>;
  /** 0..1, how far past its threshold the evidence went. Scales the rule's impact weight. */
  readonly strength: number;
  /** `engine_key` of the metric_daily rows the baseline is read from. */
  readonly baselineEngine: string;
  readonly affectedEngines: readonly string[];
  readonly affectedPromptIds: readonly string[];
  readonly sourceFindingId?: string | null;
  readonly sourceDomainId?: string | null;
  readonly sourceDisplacementId?: string | null;
  readonly affectedUrl?: string | null;
  /** Authority work: the playbook reference and the pieces of its payload known at generation time. */
  readonly playbook?: { readonly slug: string | null; readonly domain: string; readonly url: string | null; readonly angle: string };
  /** A displacement every one of which must surface: never subject to a cooldown, and linked back to its task. */
  readonly displacementId?: string;
  readonly noCooldown?: boolean;
  /** A discrete event (an AUX regression, a re-verified source gap): it counts on an open task once, even within the same metric day. */
  readonly discrete?: boolean;
}
