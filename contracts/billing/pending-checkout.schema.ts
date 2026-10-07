import { z } from "zod";
import { currencySchema } from "./money.schema.js";

// NEW-D-2 audit — the shape of `subscriptions.pending_checkout` (jsonb).
//
// A checkout INTENT, committed in its own short transaction BEFORE Stripe is
// asked for a session. It freezes everything that session is built from, so
// that (1) a retry after a crash can replay the exact same Stripe call (same
// Idempotency-Key, same body) to find the session the crashed request created
// and expire it, and (2) the webhook verifies the charge against the price
// ADOPTED at checkout, not against whatever the catalog says by then.
//
// Not a request or response: never leaves the API. Hence not exported from the
// barrel; the service and the webhook handler import it directly.
export const pendingCheckoutSchema = z
  .object({
    id: z.uuid(),
    plan_key: z.string().min(1),
    billing_interval: z.enum(["monthly", "annual"]),
    product_name: z.string().min(1),
    /** Integer minor units, frozen from the plan's `numeric(12,2)` price. */
    unit_amount_cents: z.number().int().positive(),
    currency: currencySchema,
    /** The Stripe customer the session was built for, or null when Checkout creates one. */
    customer_id: z.string().min(1).nullable(),
  })
  .strict();

export type PendingCheckout = z.infer<typeof pendingCheckoutSchema>;
