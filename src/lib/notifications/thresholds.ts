import type { ClientBase } from "pg";
import { includedGrantOf } from "../credits/debit.js";
import { resolveEntitlements } from "../entitlements/resolution.js";
import { alertDeepLink, CREDITS_DEEP_LINK } from "../alert-rules/deep-links.js";
import { alertRule } from "../alert-rules/catalog.js";
import { writeNotification, type WriterOptions } from "./writer.js";

// STORY-068 AC7 — "A threshold notification fires ONCE PER THRESHOLD PER CYCLE, not per page view."
//
// The once-ness is RECORDED ON THE COUNTER OR WALLET ROW (story Technical notes): the statement that returns a crossed
// threshold is the statement that stamps it, so a second request, a page load or a second process finds it stamped and
// says nothing. The event key on the notification is a second, independent guard (AC11): even a caller that reported
// the same crossing twice writes one row.
//
//   QUOTA (scoring-models.md §15 `quota_threshold`, owner decision 2026-10-23: 80% AND 95%): `crossedWarningThresholds`
//   (src/lib/usage/tier-caps.ts) stamps `usage_counters.warned_at_80/95`; the period is the counter's primary key, so a
//   new cycle is a new row and needs no reset. QuotaGuard calls `notifyQuotaThresholds` in the same short transaction.
//
//   CREDITS (25% / 10% of the cycle's grant, ui-ux-guidelines.md's amber and red): `stampCreditThresholds` stamps
//   `credit_wallets.warned_at_25pct/10pct`. A stamp from before the wallet's `cycle_start` belongs to an earlier cycle and
//   is stale, so nothing has to reset it at the roll (and the cycle roll, a ledger mutation, is not touched). It runs in
//   the `notify.dispatch` `credit_check` job, which the notify sweep asks for after the debit committed — NEVER inside a
//   ledger transaction, and no debit path was changed to ask for it.

export async function notifyQuotaThresholds(
  tx: ClientBase,
  workspaceId: string,
  metric: string,
  periodStart: string,
  crossed: readonly number[],
  options: WriterOptions = {},
): Promise<void> {
  const rule = alertRule("quota_threshold");
  for (const threshold of crossed) {
    await writeNotification(
      tx,
      {
        workspaceId,
        projectId: null,
        userId: null,
        kind: "usage.quota_threshold",
        severity: rule.severity,
        title: `${String(threshold)}% of this cycle's ${metricLabel(metric)} allowance is used`,
        body: "The allowance resets at the start of the next billing cycle.",
        eventKey: `usage.quota:${metric}:${periodStart}:${String(threshold)}`,
        deepLink: alertDeepLink(rule.code, { projectId: null }),
        facts: { alert_rule: rule.code, metric, period_start: periodStart, threshold },
      },
      options,
    );
  }
}

function metricLabel(metric: string): string {
  return metric === "pdf_exports" ? "PDF export" : metric.replaceAll("_", " ");
}

/** The two credit thresholds, most severe last. Severity is the routing (AC12): under 10% is emailed at once. */
export const CREDIT_THRESHOLDS = [
  { pct: 25, column: "warned_at_25pct", severity: "warning" },
  { pct: 10, column: "warned_at_10pct", severity: "critical" },
] as const;

/**
 * Stamps every credit threshold the wallet's available balance (included + purchased - reserved) is now under, ONCE per
 * cycle, and writes one notification for each it stamped. Returns the thresholds crossed by THIS call. A plan with no
 * numeric grant (negotiated) warns about nothing: there is no figure to be 25% of.
 */
export async function stampCreditThresholds(tx: ClientBase, workspaceId: string, options: WriterOptions = {}): Promise<number[]> {
  const grant = includedGrantOf((await resolveEntitlements(tx, workspaceId)).entitlements);
  if (grant <= 0) return [];
  const crossed: number[] = [];
  for (const threshold of CREDIT_THRESHOLDS) {
    // Integer arithmetic on both sides (balance * 100 < grant * pct): no float decides whether a customer is warned.
    const stamped = await tx.query<{ cycle_start: string }>(
      `UPDATE credit_wallets
          SET ${threshold.column} = now()
        WHERE workspace_id = $1
          AND (${threshold.column} IS NULL OR ${threshold.column} < (cycle_start::timestamp AT TIME ZONE 'UTC'))
          AND (included_balance + purchased_balance - reserved)::bigint * 100 < $2::bigint * $3::int
        RETURNING to_char(cycle_start, 'YYYY-MM-DD') AS cycle_start`,
      [workspaceId, grant, threshold.pct],
    );
    const cycleStart = stamped.rows[0]?.cycle_start;
    if (cycleStart === undefined) continue;
    crossed.push(threshold.pct);
    await writeNotification(
      tx,
      {
        workspaceId,
        projectId: null,
        userId: null,
        kind: "credits.threshold",
        severity: threshold.severity,
        title: `Credits are below ${String(threshold.pct)}% of this cycle's grant`,
        body: "Scheduled tracking continues at 0 credits; on-demand actions need credits. Top up or wait for the next cycle.",
        eventKey: `credits.threshold:${cycleStart}:${String(threshold.pct)}`,
        deepLink: CREDITS_DEEP_LINK,
        facts: { threshold: threshold.pct, cycle_start: cycleStart },
      },
      options,
    );
  }
  return crossed;
}

