import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";
import { currencySchema, moneySchema } from "./money.schema.js";

// NEW-D-1 — `GET /v1/billing/invoices` (billing:read). A read model of what
// the provider issued; Nominara never computes an invoice total.
export const INVOICE_STATUSES = ["draft", "open", "paid", "uncollectible", "void"] as const;

export const invoiceSchema = z
  .object({
    id: z.uuid(),
    /** Null until the provider numbers it (a draft). */
    number: z.string().nullable(),
    status: z.enum(INVOICE_STATUSES),
    subtotal: moneySchema,
    addon_amount: moneySchema,
    credit_pack_amount: moneySchema,
    total: moneySchema,
    currency: currencySchema,
    period_start: z.iso.datetime(),
    period_end: z.iso.datetime(),
    hosted_invoice_url: z.url().nullable(),
    pdf_url: z.url().nullable(),
    /** Null while unpaid. */
    paid_at: z.iso.datetime().nullable(),
  })
  .strict();

export const invoiceListQuerySchema = paginationRequestSchema
  .extend({ status: z.enum(INVOICE_STATUSES).optional() })
  .strict();

// The list route's `data` member; the envelope adds `pagination` (STORY-023).
export const invoiceListResponseSchema = z.array(invoiceSchema);

export type Invoice = z.infer<typeof invoiceSchema>;
export type InvoiceListResponse = z.infer<typeof invoiceListResponseSchema>;
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;
