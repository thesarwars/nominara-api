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

/**
 * STORY-076b (owner decision, 2026-10-08) — `GET /billing/addons` lists the
 * PURCHASABLE CATALOG with prices, one entry per add-on kind, and states what
 * the workspace holds of each. A workspace that holds nothing still reads the
 * $49 / $15 before it buys (`check:no-cost-literals` forbids the control from
 * carrying them). `quantity` is 0 and `id`, `active_from`, `active_until` are
 * null for a kind not in force; `purchasable` is whether the workspace's plan
 * grants the add-on at all (a refused purchase is `403 feature_not_in_plan`).
 */
export const addonListItemSchema = z
  .object({
    kind: addonKindSchema,
    display_name: z.string().min(1),
    unit_price_usd: moneySchema,
    purchasable: z.boolean(),
    /** Units held now; 0 when the workspace holds none of this kind. */
    quantity: z.number().int().nonnegative(),
    /** Per unit of `quantity`. */
    grant: addonGrantSchema,
    id: z.uuid().nullable(),
    active_from: z.iso.datetime().nullable(),
    active_until: z.iso.datetime().nullable(),
  })
  .strict();

export const addonCreateRequestSchema = z
  .object({
    kind: addonKindSchema,
    /**
     * The units to ADD to what the workspace holds (owner decision, 2026-10-08:
     * a POST adds). Retry safety is NOT carried by the number: it is carried by
     * the `Idempotency-Key`, which is stored with the resulting total as an
     * intent before Stripe is asked, so a retry after Stripe applied the change
     * re-asks for the stored total and never adds a second time.
     */
    quantity: z
      .number()
      .int()
      .min(1)
      .max(ADDON_MAX_QUANTITY)
      .describe("Units to add to the held quantity; the held quantity plus this may not exceed the cap"),
  })
  .strict();

/**
 * The shape of `subscriptions.pending_addon_changes` (jsonb): the add-on change
 * intents of the live subscription, keyed by a hash of the request's
 * `Idempotency-Key`. Committed in its own short transaction BEFORE Stripe is
 * asked, so a request that dies after Stripe applied the change cannot lose the
 * record of what it asked for. Never leaves the API.
 */
export const pendingAddonChangeSchema = z
  .object({
    id: z.uuid(),
    kind: addonKindSchema,
    /** The units the request asked to add. */
    quantity: z.number().int().min(1).max(ADDON_MAX_QUANTITY),
    /** The total this change sets the Stripe item to: the held quantity at first sight plus `quantity`. */
    target_total: z.number().int().min(1).max(ADDON_MAX_QUANTITY),
    /** The key sent to Stripe, fixed at first sight so every retry replays Stripe's own answer. */
    stripe_idempotency_key: z.string().min(1).max(255),
    created_at: z.iso.datetime(),
  })
  .strict();

export const pendingAddonChangesSchema = z.record(z.string().min(1), pendingAddonChangeSchema);

/**
 * `POST /v1/billing/addons` and `DELETE /v1/billing/addons/{kind}` (STORY-076b).
 *
 * ASYNC BY CONSTRUCTION, LIKE THE CREDIT-PACK PURCHASE. The subscription item
 * is changed in Stripe; the local add-on rows, `seats_purchased` and
 * `projects_purchased` change only when the signature-verified webhook
 * reconciles the freshly fetched subscription. So this can only ever say
 * `pending` and never carries a granted quantity or an updated entitlement.
 * `quantity_requested` is the TOTAL the item was set to in Stripe (the held quantity plus the units added;
 * 0 for a removal).
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
export const addonListResponseSchema = z.array(addonListItemSchema);

export const addonListQuerySchema = paginationRequestSchema;

export type Addon = z.infer<typeof addonSchema>;
export type AddonListItem = z.infer<typeof addonListItemSchema>;
export type PendingAddonChange = z.infer<typeof pendingAddonChangeSchema>;
export type PendingAddonChanges = z.infer<typeof pendingAddonChangesSchema>;
export type AddonGrant = z.infer<typeof addonGrantSchema>;
export type AddonChangeResponse = z.infer<typeof addonChangeResponseSchema>;
export type AddonListResponse = z.infer<typeof addonListResponseSchema>;
export type AddonListQuery = z.infer<typeof addonListQuerySchema>;
export type AddonCreateRequest = z.infer<typeof addonCreateRequestSchema>;
