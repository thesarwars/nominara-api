import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { incrementCounter } from "../telemetry/metrics.js";
import { parseCondition } from "../taskgen/evaluate.js";
import type { FiredDraft } from "../taskgen/generate.js";
import { writeNotification, type WriterOptions } from "../notifications/writer.js";
import { alertKind, alertRule, alertRuleForTask, type AlertRule } from "./catalog.js";
import { alertDeepLink, type DeepLinkFacts } from "./deep-links.js";

// STORY-068 AC1-AC4 — raising the §15 alerts after each rollup, inside the `task.generate` job's tenant transaction (the
// rollup queues that job after its own commit, for the day it rolled up: "evaluation runs after each rollup, on the
// changed facts"). Nothing here reads a fact the task generator did not already judge:
//
//   * A CONTENT RULE alerts from the drafts the generator acted on (`FiredDraft`). Its hysteresis is the generator's —
//     a window versus the prior window, `n >= 30` in both, a day-level sustain — so a single sample, which makes no
//     draft, cannot alert (AC3). The alert adds its OWN cooldown, scoped like the task (the draft's fingerprint: per
//     project and engine, competitor or domain), read from the notifications already raised.
//   * THE DISPLACEMENT RULE alerts from the `displacement_events` row (AC4): every event at or over the rule's
//     `min_impact`, no cooldown, one alert per event (the event id is the event key). It reads the threshold and the
//     enabled state from the SAME task rule row the generator reads (`TG-DISPLACEMENT-RECOVER`), so the two agree.
//   * Every alert carries an EVENT KEY (AC11): a retried job writes nothing twice.
//
// NO NETWORK I/O: the writer records a critical alert's emails in the outbox and enqueues their jobs after commit.

const logger = new Logger("alert-rules");

/** How far back from the evaluated day a new displacement still alerts: "a NEW row", not the history a first deploy finds. */
export const ALERT_DISPLACEMENT_LOOKBACK_DAYS = 2;

export interface AlertContext {
  readonly workspaceId: string;
  readonly projectId: string;
  /** `YYYY-MM-DD`, workspace-local: the day evaluated. */
  readonly metricDate: string;
}

export interface AlertSummary {
  raised: number;
  cooledDown: number;
  duplicate: number;
}

const emptySummary = (): AlertSummary => ({ raised: 0, cooledDown: 0, duplicate: 0 });

function factsOf(fired: FiredDraft, projectId: string): DeepLinkFacts {
  const vars = fired.draft.vars;
  return {
    projectId,
    ...(typeof vars.engine === "string" ? { engine: vars.engine } : {}),
    ...(typeof vars.window_days === "number" ? { windowDays: vars.window_days } : {}),
    ...(typeof vars.domain === "string" ? { domain: vars.domain } : {}),
    ...(fired.draft.sourceFindingId ? { findingId: fired.draft.sourceFindingId } : {}),
  };
}

async function inCooldown(tx: ClientBase, ctx: AlertContext, rule: AlertRule, scope: string): Promise<boolean> {
  if (rule.cooldownDays === null) return false;
  const found = await tx.query(
    `SELECT 1 FROM notifications
      WHERE workspace_id = $1 AND project_id = $2 AND kind = $3 AND payload->>'alert_scope' = $4
        AND created_at > now() - make_interval(days => $5::int)
      LIMIT 1`,
    [ctx.workspaceId, ctx.projectId, alertKind(rule.code), scope, rule.cooldownDays],
  );
  return (found.rowCount ?? 0) > 0;
}

/** AC1-AC3 — one alert per fired draft of a catalogued rule, unless the same rule and scope alerted inside its cooldown. */
export async function raiseAlertsForDrafts(tx: ClientBase, ctx: AlertContext, fired: readonly FiredDraft[], options: WriterOptions = {}): Promise<AlertSummary> {
  const summary = emptySummary();
  const crossings = new Set<string>();
  // One negative_spike alert per crossing links the first draft whose task was CREATED by this evaluation; with none created, the first draft.
  const spikeDrafts = fired.filter((f) => alertRuleForTask(f.ruleCode)?.code === "negative_spike");
  const spikeLink = spikeDrafts.find((f) => f.outcome === "created") ?? spikeDrafts[0];
  for (const drafted of fired) {
    const rule = alertRuleForTask(drafted.ruleCode);
    // The displacement rule is raised from its events (raiseDisplacementAlerts), never from the authority drafts.
    if (rule === undefined || rule.code === "displacement_detected") continue;
    // A negative-sentiment CROSSING is one alert however many reason-class tasks it makes (owner decision 21): its scope is the project, not the task.
    const scope = rule.code === "negative_spike" ? `project:${ctx.projectId}` : drafted.draft.fingerprint.toString("hex");
    if (rule.code === "negative_spike") {
      if (crossings.has(scope)) continue;
      crossings.add(scope);
    }
    const item = rule.code === "negative_spike" ? (spikeLink ?? drafted) : drafted;
    if (await inCooldown(tx, ctx, rule, scope)) {
      summary.cooledDown += 1;
      incrementCounter("nominara_alerts_outcomes_total", { rule: rule.code, outcome: "cooldown" });
      continue;
    }
    const eventKey =
      rule.cooldownDays === null
        ? `alert:${rule.code}:${item.draft.sourceFindingId ?? scope}:${item.taskId}:${ctx.metricDate}`
        : `alert:${rule.code}:${ctx.projectId}:${scope}:${ctx.metricDate}`;
    const outcome = await writeNotification(
      tx,
      {
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        userId: null,
        kind: alertKind(rule.code),
        severity: rule.severity,
        title: item.title,
        body: item.description === "" ? null : item.description,
        eventKey,
        deepLink: alertDeepLink(rule.code, factsOf(item, ctx.projectId)),
        taskId: item.taskId,
        facts: { alert_rule: rule.code, alert_scope: scope, metric_date: ctx.metricDate },
      },
      options,
    );
    summary[outcome.created ? "raised" : "duplicate"] += 1;
    incrementCounter("nominara_alerts_outcomes_total", { rule: rule.code, outcome: outcome.created ? "raised" : "duplicate" });
  }
  return summary;
}

/** AC4 — every new displacement at or over the rule's impact bar alerts, no cooldown, once per event. */
export async function raiseDisplacementAlerts(tx: ClientBase, ctx: AlertContext, options: WriterOptions = {}): Promise<AlertSummary> {
  const summary = emptySummary();
  const rule = alertRule("displacement_detected");
  const taskRule = await tx.query<{ code: string; condition: unknown; enabled_since: Date | null }>(
    "SELECT code, condition, enabled_since FROM task_generation_rules WHERE code = $1 AND enabled",
    [rule.generates],
  );
  const row = taskRule.rows[0];
  const condition = row === undefined ? undefined : parseCondition(row);
  if (row === undefined || condition === undefined || condition.kind !== "displacement") return summary;

  const events = await tx.query<{ id: string; engine_key: string; impact: number; task_id: string | null }>(
    `SELECT e.id, e.engine_key, e.impact_score::float8 AS impact, e.task_id
       FROM displacement_events e
       JOIN projects p ON p.id = e.project_id
       JOIN workspaces w ON w.id = p.workspace_id
      WHERE e.project_id = $1::uuid
        AND e.impact_score >= $2::real
        AND e.recovered_at IS NULL AND e.dismissed_at IS NULL
        AND ($3::timestamptz IS NULL OR e.detected_at >= $3::timestamptz)
        AND e.detected_at >= (($4::date - $5::int)::timestamp AT TIME ZONE w.timezone)
      ORDER BY e.detected_at, e.id`,
    [ctx.projectId, condition.min_impact, row.enabled_since, ctx.metricDate, ALERT_DISPLACEMENT_LOOKBACK_DAYS],
  );
  for (const event of events.rows) {
    const outcome = await writeNotification(
      tx,
      {
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        userId: null,
        kind: alertKind(rule.code),
        severity: rule.severity,
        title: `A high-impact displacement on ${event.engine_key}`,
        body: `The brand lost its place in an answer on ${event.engine_key} (impact ${String(Math.round(event.impact))} of 100). The recovery plan shows what to do next.`,
        eventKey: `alert:${rule.code}:${event.id}`,
        deepLink: alertDeepLink(rule.code, { projectId: ctx.projectId, displacementId: event.id }),
        taskId: event.task_id,
        facts: { alert_rule: rule.code, alert_scope: event.id, metric_date: ctx.metricDate },
      },
      options,
    );
    summary[outcome.created ? "raised" : "duplicate"] += 1;
    incrementCounter("nominara_alerts_outcomes_total", { rule: rule.code, outcome: outcome.created ? "raised" : "duplicate" });
  }
  if (summary.raised > 0) logger.log({ event: "alerts.displacement_raised", workspace_id: ctx.workspaceId, project_id: ctx.projectId, raised: summary.raised });
  return summary;
}
