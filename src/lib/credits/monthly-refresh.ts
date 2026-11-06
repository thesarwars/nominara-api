import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase, Pool, PoolClient } from "pg";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { rollIncludedCycle } from "./cycle-roll.js";

// STORY-177 — the monthly included-credit refresh for the two kinds of wallet no Stripe event ever rolls monthly.
//
// `plans-and-entitlements.md` §5 ("Annual billing and free wallets", owner decision 2026-10-15): included credits
// refresh EVERY MONTH, annual billing included, and a free wallet's grant is per cycle.
//
//   - ANNUAL: Stripe's period is a year, so the webhook rolls once a year. This job rolls the other eleven months, on
//     the subscription's anniversary day.
//   - FREE: a free workspace has no Stripe events. This job rolls it on the calendar month (the same month
//     `resolveBillingPeriod` falls back to).
//
// ⚠ NO SECOND ROLL. Every roll below is `rollIncludedCycle`, the function the webhook calls, so the `grant`/`expire`
// entries, the carry-over of holds in flight and the ledger keys are inherited. The gate against a double roll is the
// wallet's own `cycle_start` under its row lock: a replay, a second instance, and a Stripe renewal landing on a day
// this job already rolled all find "not newer" and do nothing.
//
// ⚠ THE TWELFTH BOUNDARY IS STRIPE'S. The annual window is clamped to the eleventh month after the period start, so
// this job never rolls onto the anniversary that is the Stripe renewal. If the renewal event is late, the wallet waits
// for it (and for the payment, if it is `past_due`) exactly as a monthly subscription does; the webhook's roll is then
// the twelfth, and the job's next run finds the subscription's NEW period and nothing to do.
//
// ⚠ NOT A PAYMENT-OUTSTANDING ROLL. Only a subscription that is `active` rolls. `past_due` waits for the payment (the
// webhook's recovery roll, or the next run after the status returns to `active`); `trialing`/`soft_capped` annual
// subscriptions are left to the webhook. A monthly-billed paid wallet is never this job's.
//
// The decision is made INSIDE each workspace's tenant transaction, from the rows as they are under the lock, never from
// the discovery scan: discovery is a loose, cross-tenant "worth looking at" list.

const logger = new Logger("monthly-refresh");
const tracer = trace.getTracer("nominara.credits");

export interface MonthWindow {
  /** `YYYY-MM-DD`, UTC. */
  readonly start: string;
  readonly end: string;
}

export interface MonthlyRefreshOutcome {
  readonly workspacesChecked: number;
  readonly workspacesRolled: number;
  readonly failures: readonly { workspaceId: string; reason: string }[];
}

const pad = (n: number): string => String(n).padStart(2, "0");

function parse(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return { y, m, d };
}

/** `anchor` plus `months`, keeping the anchor's day of month, clamped to the target month's length. */
function addMonths(anchor: string, months: number): string {
  const { y, m, d } = parse(anchor);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year)}-${pad(month)}-${pad(Math.min(d, daysInMonth))}`;
}

/** The calendar month containing `today` (a free wallet's cycle). */
export function calendarMonthWindow(today: string): MonthWindow {
  const { y, m } = parse(today);
  const first = `${String(y)}-${pad(m)}-01`;
  return { start: first, end: addMonths(first, 1) };
}

/**
 * The monthly window of an annual subscription containing `today`, anniversary-day based on its period start, clamped to
 * months 0..11 (the twelfth boundary is Stripe's renewal, not this job's).
 */
export function annualWindow(periodStart: string, today: string): MonthWindow {
  let month = 0;
  while (month < 11 && addMonths(periodStart, month + 1) <= today) month += 1;
  return { start: addMonths(periodStart, month), end: addMonths(periodStart, month + 1) };
}

export interface MonthlyRefreshConnections {
  /** Privileged, direct connection: a cross-tenant scan on the runtime role would see nothing. */
  readonly discovery: ClientBase;
  /** The runtime pool; each roll runs in its own tenant transaction on it. */
  readonly work: Pool;
  readonly now?: Date;
}

interface WalletView {
  readonly cycle_start: string;
  readonly cycle_end: string;
  readonly plan_key: string | null;
  readonly billing_interval: string | null;
  readonly status: string | null;
  readonly period_start: string | null;
  readonly grant_free: number;
  readonly grant_plan: number | null;
}

export async function refreshMonthlyWallets(connections: MonthlyRefreshConnections): Promise<MonthlyRefreshOutcome> {
  return tracer.startActiveSpan("credits.monthly_refresh", async (span) => {
    try {
      const outcome = await sweep(connections);
      span.setAttribute("nominara.credits.monthly_refresh.checked", outcome.workspacesChecked);
      span.setAttribute("nominara.credits.monthly_refresh.rolled", outcome.workspacesRolled);
      span.setAttribute("nominara.credits.monthly_refresh.failed", outcome.failures.length);
      if (outcome.failures.length > 0) span.setStatus({ code: SpanStatusCode.ERROR });
      // Counts and workspace IDs only: never a name, never a balance.
      logger.log({
        message: "monthly included-credit refresh",
        checked: outcome.workspacesChecked,
        rolled: outcome.workspacesRolled,
        failed: outcome.failures.length,
      });
      return outcome;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function sweep({ discovery, work, now = new Date() }: MonthlyRefreshConnections): Promise<MonthlyRefreshOutcome> {
  const today = now.toISOString().slice(0, 10);

  // Loose on purpose: a wallet whose cycle has ended (free), or one that belongs to an annual subscription and whose
  // cycle began before today (its `cycle_end` can be a year away). `decide` is the real test, under the lock.
  const candidates = await discovery.query<{ workspace_id: string }>(
    `SELECT w.workspace_id
       FROM credit_wallets w
      WHERE w.cycle_end <= $1::date
         OR (w.cycle_start < $1::date
             AND EXISTS (SELECT 1 FROM subscriptions s
                          WHERE s.workspace_id = w.workspace_id AND s.billing_interval = 'annual' AND s.status = 'active'))
      ORDER BY w.workspace_id`,
    [today],
  );

  let workspacesRolled = 0;
  const failures: { workspaceId: string; reason: string }[] = [];
  for (const { workspace_id: workspaceId } of candidates.rows) {
    let client: PoolClient | undefined;
    try {
      client = await work.connect();
      const rolled = await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        refreshOne(tx, workspaceId, today),
      );
      if (rolled) workspacesRolled += 1;
    } catch (error) {
      incrementCounter("nominara_credits_monthly_refresh_failed_total");
      failures.push({ workspaceId, reason: error instanceof Error ? error.message : String(error) });
    } finally {
      client?.release();
    }
  }
  return { workspacesChecked: candidates.rows.length, workspacesRolled, failures };
}

async function refreshOne(tx: ClientBase, workspaceId: string, today: string): Promise<boolean> {
  const view = await tx.query<WalletView>(
    `SELECT w.cycle_start::text, w.cycle_end::text,
            s.plan_key, s.billing_interval, s.status, s.period_start,
            (SELECT credits_per_cycle FROM plans WHERE key = 'free') AS grant_free,
            (SELECT credits_per_cycle FROM plans WHERE key = s.plan_key) AS grant_plan
       FROM credit_wallets w
       LEFT JOIN LATERAL (
         SELECT plan_key, billing_interval, status, (current_period_start AT TIME ZONE 'UTC')::date::text AS period_start
           FROM subscriptions WHERE workspace_id = w.workspace_id
          ORDER BY current_period_start DESC LIMIT 1
       ) s ON true
      WHERE w.workspace_id = $1`,
    [workspaceId],
  );
  const row = view.rows[0];
  if (row === undefined) return false;

  let window: MonthWindow;
  let grant: number;
  const isFree = row.plan_key === null || row.plan_key === "free" || row.status === "canceled";
  if (isFree) {
    // Only when the month has ended: a free wallet mid-cycle is left alone.
    if (row.cycle_end > today) return false;
    window = calendarMonthWindow(today);
    grant = row.grant_free;
  } else if (row.billing_interval === "annual" && row.status === "active" && row.period_start !== null && row.grant_plan !== null) {
    window = annualWindow(row.period_start, today);
    grant = row.grant_plan;
  } else {
    // Monthly-billed paid wallet, or an annual one that is past_due / trialing: the webhook's.
    return false;
  }
  if (window.start <= row.cycle_start) return false;

  const outcome = await rollIncludedCycle(tx, { workspaceId, grant, cycleStart: window.start, cycleEnd: window.end });
  return outcome.rolled;
}
