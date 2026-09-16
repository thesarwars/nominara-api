import { Injectable } from "@nestjs/common";
import type { CreditLedgerEntry, CreditLedgerQuery } from "../../../contracts/billing/index.js";
import type { Page } from "../../api/pagination/page.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { readLedgerPage } from "./credit-ledger.reader.js";

// STORY-073 AC12 — api-specification.md §3: `GET /billing/wallet/ledger`,
// "cursor over credit_ledger; filter by action, project, actor, date; CSV
// export".

@Injectable()
export class BillingService {
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
