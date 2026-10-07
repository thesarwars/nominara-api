import { z } from "zod";

// NEW-D-1 — `POST /v1/billing/portal-session` (billing:write). No input: the
// customer is resolved from the caller's own workspace subscription, never
// from a client-supplied id. `.strict()` makes a stray `customer_id` a 400.
export const portalSessionRequestSchema = z.object({}).strict();

export const portalSessionResponseSchema = z
  .object({
    portal_url: z.url(),
  })
  .strict();

export type PortalSessionRequest = z.infer<typeof portalSessionRequestSchema>;
export type PortalSessionResponse = z.infer<typeof portalSessionResponseSchema>;
