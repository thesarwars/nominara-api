import { z } from "zod";
import { downgradeExcessItemSchema } from "../common/downgrade-excess.schema.js";
import { currencySchema, moneySchema } from "./money.schema.js";

// STORY-184 — the in-app paid plan change.
//   POST   /v1/billing/subscription/change/preview
//   POST   /v1/billing/subscription/change          (billing:write, idempotent ✚, 202)
//   DELETE /v1/billing/subscription/change          (billing:write)
//
// ⚠ THERE IS NO `billing_interval` ON ANY REQUEST, AND THAT IS THE RULE (owner
// decision 2026-10-16: no monthly/annual switch). The target is priced on the
// subscription's OWN interval; `.strict()` turns a client that sends one into
// a `400` rather than a silently ignored field.
//
// ⚠ THE RESPONSE IS ASYNC BY CONSTRUCTION, like checkout and the add-on routes.
// The plan changes only when the signature-verified webhook reconciles the
// freshly fetched subscription, so `status` is the literal `pending` and no
// field here claims a granted plan or balance.

export const PLAN_CHANGE_DIRECTIONS = ["upgrade", "downgrade"] as const;
export const planChangeDirectionSchema = z.enum(PLAN_CHANGE_DIRECTIONS);

/**
 * Stripe's own figure for what the upgrade costs now, at a fixed proration instant. It is echoed back by the change
 * request: the server re-previews with the SAME `proration_date` and refuses (`409 quote_changed`) a different amount.
 */
export const planChangeQuoteSchema = z
  .object({
    /** Unix seconds. Bounded server-side (not older than 30 minutes, not in the future, not before the period start). */
    proration_date: z.number().int().positive(),
    /** Stripe's `amount_due` for the preview invoice, from `invoices.createPreview` — never computed by us. */
    amount_due_now: moneySchema,
    currency: currencySchema,
  })
  .strict();

export const planChangePreviewRequestSchema = z
  .object({
    /** `plans.key` — validated against the catalog by the handler. */
    plan_key: z.string().min(1).max(64),
  })
  .strict();

export const planChangeRequestSchema = z
  .object({
    plan_key: z.string().min(1).max(64),
    /** Required for an upgrade (the handler answers `400` without it); a downgrade charges nothing and has none. */
    quote: planChangeQuoteSchema.optional(),
  })
  .strict();

/** Why the change route would refuse this target even though the preview can describe it. */
export const PLAN_CHANGE_BLOCKED_BY = ["exceeds_limits", "cancel_in_portal"] as const;

export const planChangePreviewResponseSchema = z
  .object({
    direction: planChangeDirectionSchema,
    current_plan_key: z.string().min(1),
    target_plan_key: z.string().min(1),
    billing_interval: z.enum(["monthly", "annual"]),
    /** `immediate`: charged and applied now. `period_end`: a downgrade takes effect at `effective_at`. */
    effective: z.enum(["immediate", "period_end"]),
    effective_at: z.iso.datetime().nullable(),
    /** Stripe's figure for an upgrade; "0.00" for a downgrade, which charges nothing. */
    amount_due_now: moneySchema,
    currency: currencySchema,
    /** Present for an upgrade; null for a downgrade. */
    quote: planChangeQuoteSchema.nullable(),
    /**
     * LABELLED an estimate: the wallet is topped up by the same pro-rata rule when the webhook applies the change, but
     * the figure is computed here and the real one is the ledger's.
     */
    credit_estimate: z
      .object({
        basis: z.literal("estimate"),
        top_up_now: z.number().int().nonnegative(),
        /** The target plan's included credits at the next cycle roll. */
        grant_at_next_cycle: z.number().int().nonnegative(),
      })
      .strict(),
    /** Always true: purchased credits are never clawed back (plans-and-entitlements.md §14). */
    purchased_credits_kept: z.literal(true),
    /** Empty for an upgrade. */
    exceeds: z.array(downgradeExcessItemSchema),
    /** Non-null when the change route would refuse this target (a structural excess, or Free). */
    blocked_by: z.enum(PLAN_CHANGE_BLOCKED_BY).nullable(),
  })
  .strict();

export const planChangeResponseSchema = z
  .object({
    status: z.literal("pending"),
    direction: planChangeDirectionSchema,
    target_plan_key: z.string().min(1),
    effective: z.enum(["immediate", "period_end"]),
    effective_at: z.iso.datetime().nullable(),
  })
  .strict();

export const planChangeCancelResponseSchema = z
  .object({
    status: z.literal("cancelled"),
    /** The plan the cancelled downgrade would have moved to. */
    target_plan_key: z.string().min(1),
  })
  .strict();

/** What `GET /billing/subscription` shows of a pending change (null when none): enough for the client's banner and its cancel. */
export const pendingPlanChangeSummarySchema = z
  .object({
    direction: planChangeDirectionSchema,
    target_plan_key: z.string().min(1),
    effective_at: z.iso.datetime().nullable(),
  })
  .strict();

/**
 * The shape of `subscriptions.pending_plan_change` (jsonb, migration 0128): the intent of the in-app change,
 * committed in its own short transaction BEFORE Stripe is asked (the `pending_checkout` precedent) because the
 * webhook can arrive before the request commits. It freezes the charge the webhook verifies the subscription
 * against. Never leaves the API.
 */
export const pendingPlanChangeSchema = z
  .object({
    id: z.uuid(),
    direction: planChangeDirectionSchema,
    from_plan_key: z.string().min(1),
    to_plan_key: z.string().min(1),
    billing_interval: z.enum(["monthly", "annual"]),
    /** Integer minor units of the target plan item, frozen from the catalog. */
    unit_amount_cents: z.number().int().positive(),
    currency: currencySchema,
    effective: z.enum(["immediate", "period_end"]),
    effective_at: z.iso.datetime().nullable(),
    /** The subscription the change is for; the webhook honours the intent only for this one. */
    stripe_subscription_id: z.string().min(1),
    /** Sent to Stripe, fixed at first sight so every retry replays Stripe's own answer. */
    stripe_idempotency_key: z.string().min(1).max(255),
    /** An upgrade: the instant the quote was priced at and the amount charged. */
    proration_date: z.number().int().positive().nullable(),
    amount_due_now_cents: z.number().int().nonnegative().nullable(),
    /** A downgrade: the subscription schedule, once Stripe has created it. */
    schedule_id: z.string().min(1).nullable(),
    created_at: z.iso.datetime(),
    /** Set once Stripe has ACCEPTED the change. Absent: the outcome is unknown. */
    settled_at: z.iso.datetime().optional(),
  })
  .strict();

export type PlanChangeDirection = z.infer<typeof planChangeDirectionSchema>;
export type PlanChangeQuote = z.infer<typeof planChangeQuoteSchema>;
export type PlanChangePreviewRequest = z.infer<typeof planChangePreviewRequestSchema>;
export type PlanChangeRequest = z.infer<typeof planChangeRequestSchema>;
export type PlanChangePreviewResponse = z.infer<typeof planChangePreviewResponseSchema>;
export type PlanChangeResponse = z.infer<typeof planChangeResponseSchema>;
export type PlanChangeCancelResponse = z.infer<typeof planChangeCancelResponseSchema>;
export type PendingPlanChangeSummary = z.infer<typeof pendingPlanChangeSummarySchema>;
export type PendingPlanChange = z.infer<typeof pendingPlanChangeSchema>;
