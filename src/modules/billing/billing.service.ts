import { Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { LEDGER_EXPORT_MAX_ROWS } from "../../../contracts/billing/index.js";
import type {
  AutoTopupConfig,
  AutoTopupRequest,
  CreditLedgerEntry,
  CreditLedgerExportQuery,
  CreditLedgerExportResponse,
  CreditLedgerQuery,
  UsageResponse,
  WalletResponse,
} from "../../../contracts/billing/index.js";
import { FeatureNotInPlanError, InternalError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { provisionWalletWithGrant } from "../../lib/credits/balance.js";
import { hasLedgerHistory, readLifetimeCounters } from "../../lib/credits/replay.js";
import { cycleHasLapsed, purchasableOptions, readWallet, type WalletState } from "../../lib/credits/wallet.js";
import { resolveEntitlements } from "../../lib/entitlements/resolution.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { DAILY_CAP_ENTITLEMENT, type DailyCapAction } from "../../api/decorators/daily-cap.decorator.js";
import { nextUtcMidnight } from "../../lib/usage/daily-cap.js";
import { resolveBillingPeriod } from "../../lib/usage/billing-period.js";
import { METRIC_SPECS } from "../../lib/usage/metrics.js";
import { limitValueFor, UNLIMITED_LIMIT } from "../../lib/usage/tier-caps.js";
import type { Page } from "../../api/pagination/page.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { isFeatureGranted } from "../../lib/entitlements/classification.js";
import { readLedgerPage, toLedgerCsv } from "./credit-ledger.reader.js";

// STORY-073 AC12 — api-specification.md §3: `GET /billing/wallet/ledger`,
// "cursor over credit_ledger; filter by action, project, actor, date; CSV
// export".

/** The plan from which CSV export is available (plans-and-entitlements.md section 2: `exports.csv`). */
const EXPORTS_CSV_MIN_PLAN = "growth";

const logger = new Logger("BillingService");

/** The plan from which auto top-up is available (plans-and-entitlements.md: "Growth+"). */
export const AUTO_TOPUP_MIN_PLAN = "growth";

/** OFF by default: what a workspace with no wallet row reads, and what a new wallet's column defaults give. */
const AUTO_TOPUP_OFF: AutoTopupConfig = {
  enabled: false,
  pack_key: null,
  threshold: null,
  max_per_cycle: null,
  used_this_cycle: 0,
  trigger_active: true,
};

async function readAutoTopup(client: ClientBase, workspaceId: string): Promise<AutoTopupConfig | null> {
  const result = await client.query<{
    auto_topup_enabled: boolean;
    auto_topup_pack_key: string | null;
    auto_topup_threshold: number | null;
    auto_topup_max_per_cycle: number | null;
    auto_topup_count_cycle: number;
  }>(
    `SELECT auto_topup_enabled, auto_topup_pack_key, auto_topup_threshold, auto_topup_max_per_cycle, auto_topup_count_cycle
       FROM credit_wallets WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  // NEW-D-7 — why it is OFF, when the system switched it off: the newest of the
  // two audit actions says whether the last change was a failure or the customer's own.
  let disabledReason: AutoTopupConfig["disabled_reason"];
  if (!row.auto_topup_enabled) {
    const last = await client.query<{ action: string; reason: string | null }>(
      `SELECT action, after_state->>'reason' AS reason FROM audit_log
        WHERE workspace_id = $1 AND action IN ('billing.auto_topup.disabled', 'billing.auto_topup.updated')
        ORDER BY seq DESC LIMIT 1`,
      [workspaceId],
    );
    if (last.rows[0]?.action === "billing.auto_topup.disabled" && last.rows[0].reason === "payment_failed") disabledReason = "payment_failed";
  }
  return {
    enabled: row.auto_topup_enabled,
    ...(disabledReason === undefined ? {} : { disabled_reason: disabledReason }),
    pack_key: row.auto_topup_pack_key,
    threshold: row.auto_topup_threshold,
    max_per_cycle: row.auto_topup_max_per_cycle,
    used_this_cycle: row.auto_topup_count_cycle,
    // NEW-D-7: the trigger is wired (a debit below the threshold enqueues billing.auto_topup) and the counter resets on the billing-cycle roll.
    trigger_active: true,
  };
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  /**
   * `GET /v1/billing/wallet` — the workspace's standing position.
   *
   * ⚠ A WORKSPACE WITH NO WALLET ROW IS NOT AN ERROR AND NOT A ZERO BALANCE.
   * `provisionWalletWithGrant` runs on the first PRICED request, so a
   * customer who has never triggered a paid action has no row. STORY-074 hit
   * this on the estimate and answered it with the plan's own included grant;
   * the same answer applies here, and for the same reason — "0 available" is
   * a claim about their money that is not true.
   *
   * It refuses when that grant is not a number, which is enterprise's
   * `"custom"`. An unknown grant is unknown, and inventing a figure for a
   * billing screen is worse than failing.
   */
  async wallet(): Promise<WalletResponse> {
    const client = this.client();
    const store = currentTenantStore()!;
    const workspaceId = store.context.workspaceId;

    // ⚠ SEQUENTIAL ON PURPOSE. These three share ONE `ClientBase` — the
    // request's transaction. `Promise.all` over a single pg client does not
    // run them concurrently; pg queues them and warns
    // ("Calling client.query() when the client is already executing a query"),
    // a warning pg 9 turns into a throw. There is no concurrency to win here.
    const wallet = await readWallet(client, workspaceId);
    const counters = await readLifetimeCounters(client, workspaceId);

    if (wallet === null) {
      // ⚠ "NO WALLET" IS ONLY HONEST WHEN THERE IS NO HISTORY. A workspace
      // with ledger entries and no wallet row is the discrepancy
      // `verifyWorkspaceWallet` reports, not a customer who has never spent —
      // and substituting the plan's full grant would answer a data incident
      // with a confident figure, directly above a ledger on the same screen
      // showing what they actually spent.
      if (await hasLedgerHistory(client, workspaceId)) {
        // `problem.filter` replaces an `internal_error` message with
        // "internal server error" before it leaves the process, so this
        // sentence is for the log, not the customer. Right on both counts:
        // they cannot act on it, and we should not tell them a figure.
        throw new InternalError({ message: "credit_ledger has entries for a workspace with no credit_wallets row" });
      }

      const resolved = await resolveEntitlements(client, workspaceId);
      const grant = resolved.entitlements["credits.included_per_cycle"]?.value;
      if (typeof grant !== "number") {
        throw new FeatureNotInPlanError({
          message: "this workspace has no credit wallet yet and its plan's included grant is negotiated, not a figure",
          details: { key: "credits.included_per_cycle", min_plan: "enterprise" },
        });
      }
      const period = await resolveBillingPeriod(client, workspaceId);
      return {
        available: grant,
        included_balance: grant,
        purchased_balance: 0,
        reserved: 0,
        expiring_soon: grant > 0 ? { credits: grant, expires_at: period.end } : null,
        cycle_end: period.end,
        lifetime_granted: 0,
        lifetime_purchased: 0,
        lifetime_spent: 0,
        auto_topup: AUTO_TOPUP_OFF,
      };
    }

    return {
      available: wallet.available,
      included_balance: wallet.includedBalance,
      purchased_balance: wallet.purchasedBalance,
      reserved: wallet.reserved,
      expiring_soon: await expiringSoon(client, workspaceId, wallet),
      cycle_end: wallet.cycleEnd,
      lifetime_granted: counters?.granted ?? 0,
      lifetime_purchased: counters?.purchased ?? 0,
      lifetime_spent: counters?.spent ?? 0,
      auto_topup: (await readAutoTopup(client, workspaceId)) ?? AUTO_TOPUP_OFF,
    };
  }

  /**
   * `PUT /v1/billing/wallet/auto-topup` — STORY-076 AC6, AC8.
   *
   * THE CAP IS NOT CHECKED HERE. `ck_autotopup_bounded` (1..20) is the
   * control, and the request schema's bound only turns the same refusal into a
   * 400 early. This method never reads `max_per_cycle` to decide anything.
   *
   * `auto_topup_count_cycle` IS NOT IN THE UPDATE'S SET LIST, on purpose
   * (AC8): only the cycle roll resets it, so a configuration change cannot be
   * used to buy more firings in the same cycle.
   *
   * Growth+ is decided in SQL from `plans.sort_order`, the comparison the pack
   * catalog already uses, so a plan reorder needs no redeploy.
   */
  async setAutoTopup(body: AutoTopupRequest): Promise<AutoTopupConfig> {
    const client = this.client();
    const workspaceId = currentTenantStore()!.context.workspaceId;

    const plan = await client.query<{ eligible: boolean }>(
      `SELECT (p.sort_order >= g.sort_order) AS eligible
         FROM workspaces w JOIN plans p ON p.key = w.plan_key JOIN plans g ON g.key = $2
        WHERE w.id = $1`,
      [workspaceId, AUTO_TOPUP_MIN_PLAN],
    );
    if (plan.rows[0]?.eligible !== true) {
      incrementCounter("nominara_billing_auto_topup_update_total", { outcome: "not_in_plan" });
      throw new FeatureNotInPlanError({ details: { key: "credits.auto_topup", min_plan: AUTO_TOPUP_MIN_PLAN } });
    }

    if (body.pack_key !== null) {
      const pack = await client.query<{ min_plan_key: string | null }>("SELECT min_plan_key FROM credit_packs WHERE key = $1 AND is_public", [body.pack_key]);
      if (pack.rowCount === 0) {
        incrementCounter("nominara_billing_auto_topup_update_total", { outcome: "unknown_pack" });
        throw new ValidationFailedError({
          message: "pack_key does not name a credit pack",
          details: { issues: [{ path: ["pack_key"], message: "no such pack" }] },
        });
      }
      if (!(await purchasableOptions(client, workspaceId)).some((o) => o.key === body.pack_key)) {
        incrementCounter("nominara_billing_auto_topup_update_total", { outcome: "pack_above_tier" });
        throw new FeatureNotInPlanError({ details: { key: `credit_pack.${body.pack_key}`, min_plan: pack.rows[0]?.min_plan_key ?? AUTO_TOPUP_MIN_PLAN } });
      }
    }

    // The first priced request normally provisions the wallet; a configuration can precede it.
    if ((await readWallet(client, workspaceId)) === null) {
      const resolved = await resolveEntitlements(client, workspaceId);
      const value = resolved.entitlements["credits.included_per_cycle"]?.value;
      const grant = typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
      await provisionWalletWithGrant(client, workspaceId, grant, await resolveBillingPeriod(client, workspaceId));
    }

    await client.query(
      `UPDATE credit_wallets
          SET auto_topup_enabled = $2, auto_topup_pack_key = $3, auto_topup_threshold = $4, auto_topup_max_per_cycle = $5
        WHERE workspace_id = $1`,
      [workspaceId, body.enabled, body.pack_key, body.threshold, body.max_per_cycle],
    );
    incrementCounter("nominara_billing_auto_topup_update_total", { outcome: "updated" });
    this.logger.log({ message: "auto-top-up configuration changed", workspace_id: workspaceId, enabled: body.enabled });
    return (await readAutoTopup(client, workspaceId))!;
  }

  /**
   * `GET /v1/billing/usage` — the current period's non-credit tier caps.
   *
   * READ-ONLY. A workspace whose counter row has not been provisioned yet
   * (rows are created by the first metered request) reports `used: 0` and the
   * cap its plan resolves to, rather than creating a row from a GET.
   *
   * `cap`: the column's `-1` (unlimited) becomes `null`; `0` stays `0` (the
   * tier has none). `used` is `used_value`, committed use only.
   *
   * STORY-096 AC15: also the two customer-visible DAILY caps, from `credit_daily_counters` (never `usage_counters`); `fair_use_captures` stays hidden.
   */
  async usage(): Promise<UsageResponse> {
    const client = this.client();
    const workspaceId = currentTenantStore()!.context.workspaceId;
    const period = await resolveBillingPeriod(client, workspaceId);

    const counter = await client.query<{ used_value: string; limit_value: string }>(
      `SELECT used_value::text, limit_value::text FROM usage_counters
        WHERE workspace_id = $1 AND metric = 'pdf_exports' AND period_start = $2`,
      [workspaceId, period.start],
    );
    let used = 0;
    let limit: number;
    const found = counter.rows[0];
    if (found === undefined) {
      const resolved = await resolveEntitlements(client, workspaceId);
      limit = limitValueFor("pdf_exports", resolved.entitlements[METRIC_SPECS.pdf_exports.entitlementKey!]?.value ?? null);
    } else {
      used = Number(found.used_value);
      limit = Number(found.limit_value);
    }

    // The same predicate share-token minting counts against `share_links.enabled`.
    const links = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM share_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    );
    // STORY-096 AC15 - the daily caps. `used` is today's (UTC) row of credit_daily_counters, 0 with no row; the cap is the plan's CURRENT entitlement,
    // not the row's `limit_count`, which holds the limit the day's last write used (a mid-day upgrade lifts the cap at once). Read-only: no row is created.
    const todays = await client.query<{ action_code: string; used_count: number }>(
      `SELECT action_code, used_count FROM credit_daily_counters
        WHERE workspace_id = $1 AND utc_date = (now() AT TIME ZONE 'UTC')::date`,
      [workspaceId],
    );
    const entitlements = (await resolveEntitlements(client, workspaceId)).entitlements;
    const dailyMeter = (action: DailyCapAction): { used: number; cap: number | null } => {
      const value = entitlements[DAILY_CAP_ENTITLEMENT[action]]?.value;
      return {
        used: todays.rows.find((r) => r.action_code === action)?.used_count ?? 0,
        cap: typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null,
      };
    };

    incrementCounter("nominara_billing_usage_read_total", { outcome: "ok" });
    return {
      period_start: period.start,
      pdf_exports: { used, cap: limit === UNLIMITED_LIMIT ? null : limit },
      share_links_active: links.rows[0]?.n ?? 0,
      daily_lookups: dailyMeter("lookup"),
      daily_nlp_parses: dailyMeter("nlp_command"),
      daily_resets_at: nextUtcMidnight(new Date()),
    };
  }

  async ledger(query: CreditLedgerQuery): Promise<Page<CreditLedgerEntry>> {
    return readLedgerPage(this.client(), query);
  }

  /**
   * STORY-073 AC10 - the ledger as one CSV, under the same filters as `ledger()`.
   *
   * Reads inside the request's tenant transaction, so RLS is what keeps it to the caller's workspace (no `workspace_id`
   * predicate, as in `readLedgerPage`). Pure computation over a bounded read: at most LEDGER_EXPORT_MAX_ROWS rows, newest
   * first, with `truncated` saying so when more matched. `exports.csv` is checked here because the route is not metered.
   */
  async ledgerExport(query: CreditLedgerExportQuery): Promise<CreditLedgerExportResponse> {
    const started = Date.now();
    const client = this.client();
    const workspaceId = currentTenantStore()!.context.workspaceId;

    const resolved = await resolveEntitlements(client, workspaceId);
    if (!isFeatureGranted(resolved.entitlements["exports.csv"]?.value ?? null)) {
      incrementCounter("nominara_billing_ledger_exports_total", { outcome: "feature_not_in_plan" });
      throw new FeatureNotInPlanError({ details: { key: "exports.csv", min_plan: EXPORTS_CSV_MIN_PLAN } });
    }

    const page = await readLedgerPage(client, { ...query, limit: LEDGER_EXPORT_MAX_ROWS });
    const file = Buffer.from(toLedgerCsv(page.items), "utf8");
    const stamp = new Date().toISOString().slice(0, 10);

    incrementCounter("nominara_billing_ledger_exports_total", { outcome: "ok" });
    // The workspace ID, never its name; a count and a size, never a row.
    logger.log({
      span: "billing.ledger.export",
      workspace_id: workspaceId,
      rows: page.items.length,
      truncated: page.pagination.has_more,
      bytes: file.length,
      duration_ms: Date.now() - started,
    });

    return {
      filename: `nominara-credit-ledger-${stamp}.csv`,
      content_type: "text/csv",
      download_url: `data:text/csv;base64,${file.toString("base64")}`,
      row_count: page.items.length,
      truncated: page.pagination.has_more,
    };
  }

  private client() {
    const store = currentTenantStore();
    // Every billing route runs under TenantContextInterceptor. Refusing here
    // beats reaching the database on a connection with no workspace set,
    // where RLS would return an empty ledger that reads like a real answer.
    if (store === undefined) throw new Error("BillingService requires an active tenant context");
    return store.client;
  }
}

/**
 * What the customer actually stands to lose at cycle end, or `null`.
 *
 * Three ways this figure lies if it is taken straight off `included_balance`:
 *
 *   ⚠ NULL, NOT ZERO, WHEN THERE IS NOTHING TO LOSE. A spent included
 *     balance expires nothing, and "0 credits expiring on 2026-10-01" invites
 *     the reader to wonder what they did wrong.
 *
 *   ⚠ RESERVED CREDITS ARE ALREADY SPOKEN FOR. §5 settles included first,
 *     so a wallet holding 600 included with 600 reserved will expire NOTHING —
 *     the running action consumes the lot. Warning someone to spend credits
 *     that are already committed sends them to buy what they do not need.
 *
 *   ⚠ A LAPSED CYCLE HAS NO DEADLINE TO REPORT. `cycle_end` moves only when the cycle rolls (`rollIncludedCycle`,
 *     STORY-072, on a subscription period change or a past_due payment finally succeeding). A free wallet, and a
 *     subscription whose renewal is unpaid, can sit past its `cycle_end` unrolled. Those credits did NOT expire - the
 *     roll has not run - so `available` stays true, but when they lapse is genuinely unknown, and a past date presented
 *     as a deadline is the one thing worse than silence.
 */
async function expiringSoon(
  client: ClientBase,
  workspaceId: string,
  wallet: WalletState,
): Promise<WalletResponse["expiring_soon"]> {
  if (await cycleHasLapsed(client, workspaceId)) return null;
  const atRisk = Math.max(wallet.includedBalance - wallet.reserved, 0);
  return atRisk > 0 ? { credits: atRisk, expires_at: wallet.cycleEnd } : null;
}
