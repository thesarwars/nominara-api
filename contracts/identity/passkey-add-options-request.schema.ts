import { z } from "zod";

// POST /me/passkeys/options — STORY-173. The ONLY way a passkey is added to
// an account. It is session-authenticated and step-up gated, so the account
// is known from the session and the body carries no identifying field: an
// `email` here would be exactly the anonymous account-binding input
// STORY-173 removed from POST /auth/passkey/options. `.strict()` makes a
// stray `email` a 400 rather than a silent drop.
//
// The response is the existing passkeyOptionsResponseSchema; the ceremony is
// completed at POST /me/passkeys/verify with registrationVerifyRequestSchema.
export const passkeyAddOptionsRequestSchema = z
  .object({
    display_name: z.string().min(1).max(200).optional(),
  })
  .strict();

export type PasskeyAddOptionsRequest = z.infer<typeof passkeyAddOptionsRequestSchema>;
