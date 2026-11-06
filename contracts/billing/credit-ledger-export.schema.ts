import { z } from "zod";
import { creditLedgerQuerySchema } from "./credit-ledger-query.schema.js";

// STORY-073 AC10 - the ledger export: `GET /v1/billing/wallet/ledger/export`.
//
// The SAME five filters as `GET /v1/billing/wallet/ledger`, and nothing else: an export is a bounded snapshot, so it
// takes no cursor and no limit. Rebuilt `.strict()` after the `omit` so an unknown filter - or a `cursor`/`limit` a
// caller hopes will page it - is a 400 rather than a silently wider file.
export const creditLedgerExportQuerySchema = creditLedgerQuerySchema.omit({ cursor: true, limit: true }).strict();

/**
 * The most rows one export holds. A file past it is cut at the newest rows and says so (`truncated`): a caller narrows
 * the date range and exports again. The file is built in the request and returned inline (`data:` URL), exactly as the
 * report export is, so the bound is also what keeps the response small.
 */
export const LEDGER_EXPORT_MAX_ROWS = 5000;

export const creditLedgerExportResponseSchema = z
  .object({
    filename: z.string().min(1),
    content_type: z.literal("text/csv"),
    /** `data:text/csv;base64,...` - the file itself. */
    download_url: z.string().min(1),
    /** Rows in the file, header excluded. */
    row_count: z.number().int().nonnegative(),
    /** True when more rows matched than `LEDGER_EXPORT_MAX_ROWS`; the file holds the newest ones. */
    truncated: z.boolean(),
  })
  .strict();

export type CreditLedgerExportQuery = z.infer<typeof creditLedgerExportQuerySchema>;
export type CreditLedgerExportResponse = z.infer<typeof creditLedgerExportResponseSchema>;
