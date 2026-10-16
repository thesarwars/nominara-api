import { z } from "zod";
import { pendingPlanChangeSummarySchema } from "./plan-change.schema.js";

// NEW-D-1 — `GET /v1/billing/subscription` (billing:read). Mirrors
// `subscriptions` in schemas/billing-and-credits.md. The Stripe customer and
// subscription ids are provider internals and are not published.
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "paused",
] as const;

export const subscriptionSchema = z
  .object({
    plan_key: z.string(),
    billing_interval: z.enum(["monthly", "annual"]),
    status: z.enum(SUBSCRIPTION_STATUSES),
    /**
     * Migration 0026: `none` is a workspace with no provider behind it,
     * `operator` was set by the plan-set CLI, `stripe` is billed. A UI that
     * offers "manage billing" must key off this, not off the plan.
     */
    provider: z.enum(["none", "operator", "stripe"]),
    current_period_start: z.iso.datetime(),
    current_period_end: z.iso.datetime(),
    /** Null when there is no trial — not the same as a trial that ended. */
    trial_ends_at: z.iso.datetime().nullable(),
    cancel_at_period_end: z.boolean(),
    seats_purchased: z.number().int().positive(),
    projects_purchased: z.number().int().nonnegative(),
    /**
     * STORY-184 — a plan change Stripe has accepted and the webhook has not yet applied (a scheduled downgrade, or an
     * upgrade awaiting confirmation); null when none. The server always sends it; it is OPTIONAL in the contract only because
     * a new required response field is classified a MAJOR change by contracts:diff, and this one is purely additive. A client
     * treats an absent value as null.
     */
    pending_plan_change: pendingPlanChangeSummarySchema.nullable().optional(),
  })
  .strict();

export type Subscription = z.infer<typeof subscriptionSchema>;
