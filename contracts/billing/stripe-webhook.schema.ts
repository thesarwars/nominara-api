import { z } from "zod";

// NEW-D-2 — `POST /v1/webhooks/stripe` (public, signature-verified).
//
// THE REQUEST IS NOT `.strict()`, DELIBERATELY, AND THE RULE STILL HOLDS. The
// "unknown key is a 400" rule exists so a CLIENT's typo is not silently
// dropped. This body is Stripe's, not a client's: it is authenticated by an
// HMAC over its raw bytes, and Stripe adds fields to events without notice, so
// a strict schema would turn every Stripe API upgrade into a 400 and then a
// retry storm. The envelope below names only what the handler READS; anything
// else is ignored after the signature has already vouched for the bytes.
//
// What the handler never reads from this payload is the workspace: the event
// is only a pointer ("object X changed"). The object is re-fetched from Stripe
// and the workspace comes from ITS `metadata.workspace_id`.
export const stripeWebhookEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    data: z.object({ object: z.object({ id: z.string().min(1) }).loose() }).loose(),
  })
  .loose();

/** `processed` — effect committed; `duplicate` — already seen, no-op; `ignored` — acknowledged, nothing to do (unknown subject or unhandled type). */
export const stripeWebhookOutcomeSchema = z.enum(["processed", "duplicate", "ignored"]);

export const stripeWebhookResponseSchema = z
  .object({
    received: z.literal(true),
    outcome: stripeWebhookOutcomeSchema,
  })
  .strict();

export type StripeWebhookEvent = z.infer<typeof stripeWebhookEventSchema>;
export type StripeWebhookOutcome = z.infer<typeof stripeWebhookOutcomeSchema>;
export type StripeWebhookResponse = z.infer<typeof stripeWebhookResponseSchema>;
