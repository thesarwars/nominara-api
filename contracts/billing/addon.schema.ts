import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";
import { moneySchema } from "./money.schema.js";

// NEW-D-1 — `/v1/billing/addons` (billing:write; the list is billing:read).
// `subscription_addons.kind` is `extra_project | extra_seat`.
export const ADDON_KINDS = ["extra_project", "extra_seat"] as const;

export const addonKindSchema = z.enum(ADDON_KINDS);

export const addonSchema = z
  .object({
    id: z.uuid(),
    kind: addonKindSchema,
    quantity: z.number().int().positive(),
    unit_price_usd: moneySchema,
    active_from: z.iso.datetime(),
    /**
     * Null while the add-on is in force. Set (to the period end) by a
     * removal: STORY-076 AC13 removes at the period end, so a removed add-on
     * stays listed, with this date, until then. The demo's immediate
     * decrement is not this contract.
     */
    active_until: z.iso.datetime().nullable(),
  })
  .strict();

export const addonCreateRequestSchema = z
  .object({
    kind: addonKindSchema,
    quantity: z.number().int().min(1).max(100),
  })
  .strict();

export const addonListQuerySchema = paginationRequestSchema;

export type Addon = z.infer<typeof addonSchema>;
export type AddonCreateRequest = z.infer<typeof addonCreateRequestSchema>;
