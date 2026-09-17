import { Injectable } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { CreditLedgerEntry, CreditLedgerQuery, WalletResponse } from "../../../contracts/billing/index.js";
import { FeatureNotInPlanError, InternalError } from "../../api/errors/domain-errors.js";
import { hasLedgerHistory, readLifetimeCounters } from "../../lib/credits/replay.js";
import { cycleHasLapsed, readWallet, type WalletState } from "../../lib/credits/wallet.js";
import { resolveEntitlements } from "../../lib/entitlements/resolution.js";
import { resolveBillingPeriod } from "../../lib/usage/billing-period.js";
import type { Page } from "../../api/pagination/page.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { readLedgerPage } from "./credit-ledger.reader.js";

// STORY-073 AC12 — api-specification.md §3: `GET /billing/wallet/ledger`,
// "cursor over credit_ledger; filter by action, project, actor, date; CSV
// export".

@Injectable()
export class BillingService {
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
    };
  }

  async ledger(query: CreditLedgerQuery): Promise<Page<CreditLedgerEntry>> {
    return readLedgerPage(this.client(), query);
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
 *   ⚠ A LAPSED CYCLE HAS NO DEADLINE TO REPORT. Nothing rolls `cycle_end`
 *     until STORY-075/076, so a wallet provisioned in August still names an
 *     August date. Those credits did NOT expire — no writer took them — so
 *     `available` stays true, but when they lapse is genuinely unknown, and a
 *     past date presented as a deadline is the one thing worse than silence.
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
