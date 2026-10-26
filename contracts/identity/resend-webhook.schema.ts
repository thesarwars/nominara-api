import { z } from "zod";

// STORY-178 — `POST /v1/webhooks/resend` (public, Svix-signature-verified).
//
// THE REQUEST IS NOT `.strict()`, DELIBERATELY, AND THE RULE STILL HOLDS: the body is Resend's, not a client's. It is
// authenticated by an HMAC over its raw bytes, and Resend adds fields to events without notice, so a strict schema would
// turn a provider change into a 400 and a retry storm. The envelope names only what the handler READS; the rest is ignored
// after the signature has vouched for the bytes (the stripe-webhook.schema.ts reasoning).
//
// What the handler reads: the event type, and for a bounce or complaint the recipient addresses and, for a bounce, its
// type. It never stores an address: it stores the peppered hash.
export const resendWebhookEventSchema = z
  .object({
    type: z.string().min(1),
    data: z
      .object({
        to: z.array(z.string()).optional(),
        bounce: z.object({ type: z.string().optional() }).loose().optional(),
      })
      .loose(),
  })
  .loose();

/**
 * `suppressed` — at least one address was newly suppressed; `duplicate` — a redelivered event, nothing changed;
 * `ignored` — acknowledged and deliberately not acted on (a transient bounce, a delivery delay, any other event type).
 */
export const resendWebhookOutcomeSchema = z.enum(["suppressed", "duplicate", "ignored"]);

export const resendWebhookResponseSchema = z
  .object({
    received: z.literal(true),
    outcome: resendWebhookOutcomeSchema,
  })
  .strict();

export type ResendWebhookEvent = z.infer<typeof resendWebhookEventSchema>;
export type ResendWebhookOutcome = z.infer<typeof resendWebhookOutcomeSchema>;
export type ResendWebhookResponse = z.infer<typeof resendWebhookResponseSchema>;
