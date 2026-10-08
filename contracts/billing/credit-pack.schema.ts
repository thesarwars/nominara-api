import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";
import { currencySchema, moneySchema } from "./money.schema.js";

// NEW-D-1 — `GET /v1/billing/credit-packs` (workspace:read). The catalog is
// ALREADY filtered to the caller's plan (`min_plan_key`), so a pack in the
// list is a pack that can be bought; there is no `purchasable` flag to
// misread. A cursor list per api-specification.md §3, not the demo's bare array.
export const creditPackSchema = z
  .object({
    key: z.string(),
    display_name: z.string(),
    credits: z.number().int().positive(),
    price_usd: moneySchema,
    currency: currencySchema,
    /** Lowest plan that may buy it. Null = every tier. */
    min_plan_key: z.string().nullable(),
  })
  .strict();

export const creditPackListQuerySchema = paginationRequestSchema;

export const creditPackKeyParamSchema = z.string().min(1).max(64);

export type CreditPack = z.infer<typeof creditPackSchema>;
export type CreditPackListQuery = z.infer<typeof creditPackListQuerySchema>;

// NEW-D-1 AC3 (checkpoint-4) — the response is the cursor envelope's `data`; the
// envelope's `pagination` member is published by the route's `listOf` marker and
// the request carries `creditPackListQuerySchema`. An earlier comment here argued
// for a bare array because the catalog is a handful of rows; AC3 ("every list
// response uses the cursor envelope") outranks that and the comment is withdrawn.
export const creditPackListResponseSchema = z.array(creditPackSchema);
export type CreditPackListResponse = z.infer<typeof creditPackListResponseSchema>;
