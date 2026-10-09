import { Body, Controller, Get, Put, Query } from "@nestjs/common";
import {
  autoTopupConfigSchema,
  autoTopupRequestSchema,
  creditLedgerListResponseSchema,
  creditLedgerQuerySchema,
  walletResponseSchema,
  type AutoTopupConfig,
  type AutoTopupRequest,
  type CreditLedgerEntry,
  type CreditLedgerQuery,
  type WalletResponse,
} from "../../../contracts/billing/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { Page } from "../../api/pagination/page.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { BillingService } from "./billing.service.js";

// STORY-073 AC12 — api-specification.md §3's billing table. A controller
// resolves the request, calls one service method, and returns
// (coding-standards.md §1).
//
// `billing:read` is owner/admin only in the permission matrix, and that is
// the right line for this route rather than `workspace:read`: the ledger
// names which person spent what, which is employment-adjacent information a
// viewer has no business reading.
//
// ⚠ THE CSV HALF OF AC12 IS NOT HERE, DELIBERATELY. A `GET
// /billing/wallet/ledger.csv` was written and removed. It needed
// `@NoEnvelope()`, and `envelope-scope-and-probe-exemption.spec.ts` asserts
// that marker sits on the three health probes and NOTHING else — a gate
// worth more than the convenience of a synchronous download, because it is
// what stops a route quietly dropping §1's envelope.
//
// The export belongs where the specification already puts one: `POST
// /exports` (§3) is async CSV/PDF to a `report_artifact_id`, gated on the
// `exports.csv` feature flag that Free and Starter do not carry. The
// synchronous route had no such gate and would have handed two plans a
// feature they have not bought. `toLedgerCsv` in `credit-ledger.reader.ts`
// is the serialiser that pipeline will call, and it is tested
// (`test/unit/credits/ledger-csv.spec.ts`) rather than left to be written
// under the deadline of whoever builds the exports worker.
@Controller("billing/wallet")
export class BillingController {
  constructor(private readonly service: BillingService) {}

  // §3's `GET /billing/wallet` — `billing:read`, owner and admin only. The
  // estimate's project-scoped wallet is a different question at a different
  // permission; see `wallet-response.schema.ts`.
  @Get()
  @RequirePermission("billing:read")
  @ApiContract({ operationId: "getWallet", responseSchema: walletResponseSchema })
  wallet(): Promise<WalletResponse> {
    return this.service.wallet();
  }

  // NEW-D-6 / STORY-076 AC6 — `billing:write`, Growth+; the cap is the schema's.
  @Put("auto-topup")
  @RequirePermission("billing:write")
  @Audit({ action: "billing.auto_topup.updated", resourceType: "credit_wallet", resourceIdFrom: "workspace" })
  @ApiContract({
    operationId: "setAutoTopup",
    requestSchema: autoTopupRequestSchema,
    responseSchema: autoTopupConfigSchema,
  })
  setAutoTopup(@Body(new ZodValidationPipe(autoTopupRequestSchema)) body: AutoTopupRequest): Promise<AutoTopupConfig> {
    return this.service.setAutoTopup(body);
  }

  @Get("ledger")
  @RequirePermission("billing:read")
  @ApiContract({
    operationId: "listCreditLedger",
    querySchema: creditLedgerQuerySchema,
    responseSchema: creditLedgerListResponseSchema,
    listOf: true,
  })
  ledger(
    @Query(new ZodValidationPipe(creditLedgerQuerySchema)) query: CreditLedgerQuery,
  ): Promise<Page<CreditLedgerEntry>> {
    return this.service.ledger(query);
  }

}
