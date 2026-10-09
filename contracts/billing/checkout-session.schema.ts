import { z } from "zod";

// NEW-D-1 — `POST /v1/billing/checkout-session` (billing:write, idempotent ✚).
// STORY-075 AC4: the plan changes ONLY when the signature-verified webhook
// reconciles a freshly fetched subscription. This response therefore carries
// where to send the browser, never a plan or a balance — the demo's
// synchronous plan switch is the thing this shape rules out.
//
// The success and cancel return paths are chosen by the server from its own
// configuration; a client-supplied redirect would be an open redirect.
export const checkoutSessionRequestSchema = z
  .object({
    /** `plans.key`. Validated against the catalog by the handler, not here. */
    plan_key: z.string().min(1).max(64),
    billing_interval: z.enum(["monthly", "annual"]),
  })
  .strict();

export const checkoutSessionResponseSchema = z
  .object({
    /** Hosted Stripe Checkout URL. Single use, short-lived. */
    checkout_url: z.url(),
    /** Provider session id, for support correlation only. */
    session_id: z.string().min(1),
  })
  .strict();

export type CheckoutSessionRequest = z.infer<typeof checkoutSessionRequestSchema>;
export type CheckoutSessionResponse = z.infer<typeof checkoutSessionResponseSchema>;
