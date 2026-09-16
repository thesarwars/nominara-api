import { Injectable } from "@nestjs/common";
import type { CreditLedgerEntry, CreditLedgerQuery, WalletResponse } from "../../../contracts/billing/index.js";
import { FeatureNotInPlanError } from "../../api/errors/domain-errors.js";
import { readLifetimeCounters } from "../../lib/credits/replay.js";
import { readWallet } from "../../lib/credits/wallet.js";
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

    const [wallet, counters, resolved] = await Promise.all([
      readWallet(client, workspaceId),
      readLifetimeCounters(client, workspaceId),
      resolveEntitlements(client, workspaceId),
    ]);

    if (wallet === null) {
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
      // ⚠ NULL, NOT ZERO, WHEN THERE IS NOTHING TO LOSE. A spent included
      // balance expires nothing at cycle end, and "0 credits expiring on
      // 2026-10-01" invites the reader to wonder what they did wrong.
      expiring_soon:
        wallet.includedBalance > 0 ? { credits: wallet.includedBalance, expires_at: wallet.cycleEnd } : null,
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
