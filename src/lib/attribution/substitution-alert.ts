import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { SUBSTITUTION_CO_MOVEMENT_COPY } from "../../../contracts/attribution/index.js";
import { alertDeepLink } from "../alert-rules/deep-links.js";
import { alertKind, alertRule } from "../alert-rules/catalog.js";
import { writeNotification, type WriterOptions } from "../notifications/writer.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { addDays } from "./attribution-rollup.js";

// STORY-114 I4 - the `ai_substitution` alert (scoring-models.md section 15): "a URL classified `ai_substitution_candidate` for 2
// consecutive windows", warning, 14 day cooldown. It goes through the SAME catalog entry, notification writer, event-key
// idempotency and cooldown read as every other alert - no bespoke path.
//
// "Consecutive" is the window of the same length that ends where this one starts (`windowStart - windowDays`); the rollup job
// computes it alongside this one, so it exists whenever this one does. One alert per URL (the cooldown's scope is the URL's hash).
// The body is the shared co-movement copy: the alert never states a cause.

const logger = new Logger("attribution-substitution-alert");

export interface SubstitutionAlertContext {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly windowStart: string;
  readonly windowDays: number;
}

export interface SubstitutionAlertSummary {
  raised: number;
  cooledDown: number;
  duplicate: number;
}

export async function raiseSubstitutionAlerts(tx: ClientBase, ctx: SubstitutionAlertContext, options: WriterOptions = {}): Promise<SubstitutionAlertSummary> {
  const summary: SubstitutionAlertSummary = { raised: 0, cooledDown: 0, duplicate: 0 };
  const rule = alertRule("ai_substitution");
  const previousStart = addDays(ctx.windowStart, -ctx.windowDays);
  const sustained = await tx.query<{ hash_hex: string; landing_url: string }>(
    `SELECT encode(cur.landing_url_hash, 'hex') AS hash_hex, cur.landing_url
       FROM attribution_url_rollup cur
       JOIN attribution_url_rollup prev
         ON prev.project_id = cur.project_id AND prev.window_days = cur.window_days AND prev.landing_url_hash = cur.landing_url_hash
        AND prev.workspace_id = app.current_workspace()
      WHERE cur.workspace_id = app.current_workspace() AND cur.project_id = $1 AND cur.window_start = $2::date AND cur.window_days = $3
        AND cur.pattern = 'ai_substitution_candidate'
        AND prev.window_start = $4::date AND prev.pattern = 'ai_substitution_candidate'
      ORDER BY cur.landing_url`,
    [ctx.projectId, ctx.windowStart, ctx.windowDays, previousStart],
  );
  for (const row of sustained.rows) {
    const inCooldown = await tx.query(
      `SELECT 1 FROM notifications
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND kind = $2 AND payload->>'alert_scope' = $3
          AND created_at > now() - make_interval(days => $4::int)
        LIMIT 1`,
      [ctx.projectId, alertKind(rule.code), row.hash_hex, rule.cooldownDays],
    );
    if ((inCooldown.rowCount ?? 0) > 0) {
      summary.cooledDown += 1;
      incrementCounter("nominara_alerts_outcomes_total", { rule: rule.code, outcome: "cooldown" });
      continue;
    }
    const outcome = await writeNotification(
      tx,
      {
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        userId: null,
        kind: alertKind(rule.code),
        severity: rule.severity,
        title: `Citations are up while AI-referred sessions are down on ${row.landing_url}`,
        body: SUBSTITUTION_CO_MOVEMENT_COPY,
        eventKey: `alert:${rule.code}:${ctx.projectId}:${row.hash_hex}:${ctx.windowStart}:${String(ctx.windowDays)}`,
        deepLink: alertDeepLink(rule.code, { projectId: ctx.projectId, windowDays: ctx.windowDays }),
        facts: { alert_rule: rule.code, alert_scope: row.hash_hex, window_start: ctx.windowStart, window_days: ctx.windowDays },
      },
      options,
    );
    summary[outcome.created ? "raised" : "duplicate"] += 1;
    incrementCounter("nominara_alerts_outcomes_total", { rule: rule.code, outcome: outcome.created ? "raised" : "duplicate" });
  }
  if (summary.raised > 0) logger.log({ event: "attribution.substitution_alert_raised", workspace_id: ctx.workspaceId, project_id: ctx.projectId, raised: summary.raised });
  return summary;
}
