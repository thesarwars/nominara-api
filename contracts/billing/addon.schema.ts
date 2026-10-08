import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";
import { moneySchema } from "./money.schema.js";

// NEW-D-1 — `/v1/billing/addons` (billing:write; the list is billing:read).
// `subscription_addons.kind` is `extra_project | extra_seat`.
export const ADDON_KINDS = ["extra_project", "extra_seat"] as const;

export const addonKindSchema = z.enum(ADDON_KINDS);

/** The most units of one add-on a workspace can hold (STORY-076b); the request bound and the total bound are one number. */
export const ADDON_MAX_QUANTITY = 100;

/**
 * STORY-076 AC11 / scenario 11 — what ONE unit of the add-on grants, stated by
 * the server so the purchase control never has to guess it. Derived from the
 * entitlement resolver's own `addonContributions`, so the statement and the
 * resolved entitlements cannot disagree. `extra_project` carries its prompt
 * slots (`FR-CRD-05`); a project with no prompt capacity is a broken purchase.
 */
export const addonGrantSchema = z
  .object({
    projects: z.number().int().nonnegative(),
    prompt_slots: z.number().int().nonnegative(),
    seats: z.number().int().nonnegative(),
    statement: z.string().min(1),
  })
  .strict();

export const addonSchema = z
  .object({
    id: z.uuid(),
    kind: addonKindSchema,
    quantity: z.number().int().positive(),
    unit_price_usd: moneySchema,
    /** Per unit of `quantity`. */
    grant: addonGrantSchema,
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
    /** Units to ADD to what the workspace already holds (not the new total). */
    quantity: z.number().int().min(1).max(ADDON_MAX_QUANTITY),
  })
  .strict();

/**
 * `POST /v1/billing/addons` and `DELETE /v1/billing/addons/{kind}` (STORY-076b).
 *
 * ASYNC BY CONSTRUCTION, LIKE THE CREDIT-PACK PURCHASE. The subscription item
 * is changed in Stripe; the local add-on rows, `seats_purchased` and
 * `projects_purchased` change only when the signature-verified webhook
 * reconciles the freshly fetched subscription. So this can only ever say
 * `pending` and never carries a granted quantity or an updated entitlement.
 * `quantity_requested` is the total asked of Stripe (0 for a removal).
 */
export const addonChangeResponseSchema = z
  .object({
    kind: addonKindSchema,
    status: z.literal("pending"),
    quantity_requested: z.number().int().nonnegative(),
    /** `immediate`: pro-rated by Stripe now. `period_end`: a removal takes effect at `effective_at`. */
    effective: z.enum(["immediate", "period_end"]),
    effective_at: z.iso.datetime().nullable(),
    grant: addonGrantSchema,
  })
  .strict();

/** `GET /v1/billing/addons`'s list is the cursor envelope's `data`. */
export const addonListResponseSchema = z.array(addonSchema);

export const addonListQuerySchema = paginationRequestSchema;

export type Addon = z.infer<typeof addonSchema>;
export type AddonGrant = z.infer<typeof addonGrantSchema>;
export type AddonChangeResponse = z.infer<typeof addonChangeResponseSchema>;
export type AddonListResponse = z.infer<typeof addonListResponseSchema>;
export type AddonListQuery = z.infer<typeof addonListQuerySchema>;
export type AddonCreateRequest = z.infer<typeof addonCreateRequestSchema>;
