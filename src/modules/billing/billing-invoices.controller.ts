import { Controller, Get, Query } from "@nestjs/common";
import {
  invoiceListQuerySchema,
  invoiceListResponseSchema,
  type Invoice,
  type InvoiceListQuery,
} from "../../../contracts/billing/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { Page } from "../../api/pagination/page.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { BillingInvoicesService } from "./billing-invoices.service.js";

// STORY-075b — api-specification.md §3: `GET /billing/invoices`, billing:read.
@Controller("billing")
export class BillingInvoicesController {
  constructor(private readonly service: BillingInvoicesService) {}

  @Get("invoices")
  @RequirePermission("billing:read")
  @ApiContract({ operationId: "listInvoices", querySchema: invoiceListQuerySchema, responseSchema: invoiceListResponseSchema, listOf: true })
  list(@Query(new ZodValidationPipe(invoiceListQuerySchema)) query: InvoiceListQuery): Promise<Page<Invoice>> {
    return this.service.list(query);
  }
}
