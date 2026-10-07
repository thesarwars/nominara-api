import { z } from "zod";

// NEW-D-1 — `POST /v1/billing/credit-packs/{key}/purchase` (billing:write, ✚).
//
// ⚠ THE RESPONSE IS ASYNC BY CONSTRUCTION (STORY-076 AC2). Credits land only
// when the signature-verified `succeeded` webhook is applied, so this can
// never say `succeeded` and never carries a credit count or balance — those
// would be claims about money that has not moved. `status` is a literal
// `pending`, which makes a synchronous success unrepresentable.
export const creditPackPurchaseRequestSchema = z.object({}).strict();

export const creditPackPurchaseResponseSchema = z
  .object({
    /** `credit_purchases.id`, created `pending`. Poll the wallet or listen for the realtime event. */
    purchase_id: z.uuid(),
    status: z.literal("pending"),
    /** Hosted Stripe Checkout (mode=payment). */
    checkout_url: z.url(),
  })
  .strict();

export type CreditPackPurchaseRequest = z.infer<typeof creditPackPurchaseRequestSchema>;
export type CreditPackPurchaseResponse = z.infer<typeof creditPackPurchaseResponseSchema>;
