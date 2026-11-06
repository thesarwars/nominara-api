import { Body, Controller, Get, Put, Query } from "@nestjs/common";
import {
  autoTopupConfigSchema,
  autoTopupRequestSchema,
  creditLedgerExportQuerySchema,
  creditLedgerExportResponseSchema,
  creditLedgerListResponseSchema,
  creditLedgerQuerySchema,
  walletResponseSchema,
  type AutoTopupConfig,
  type AutoTopupRequest,
  type CreditLedgerEntry,
  type CreditLedgerExportQuery,
  type CreditLedgerExportResponse,
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
// STORY-073 AC10 - THE CSV EXPORT is `GET /billing/wallet/ledger/export`, and it is NOT a bare `.csv` download. An
// earlier `ledger.csv` needed `@NoEnvelope()` (a marker an architectural gate reserves for the health probes) and
// carried no `exports.csv` check. This route answers in the normal envelope with the file inline as a `data:` URL - the
// same shape as the report export - and the service refuses a plan without `exports.csv`. Same permission as the read.
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

  // Declared AFTER `ledger` and as a distinct path segment, so `ledger/export` is never read as a ledger id.
  @Get("ledger/export")
  @RequirePermission("billing:read")
  @ApiContract({
    operationId: "exportCreditLedger",
    querySchema: creditLedgerExportQuerySchema,
    responseSchema: creditLedgerExportResponseSchema,
  })
  ledgerExport(
    @Query(new ZodValidationPipe(creditLedgerExportQuerySchema)) query: CreditLedgerExportQuery,
  ): Promise<CreditLedgerExportResponse> {
    return this.service.ledgerExport(query);
  }
}
