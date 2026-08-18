import { z } from "zod";

// POST /auth/passkey/options, purpose 'assertion'. No identifying field is
// accepted — resident/discoverable credentials (STORY-014 acceptance
// criteria) mean the authenticator itself supplies the credential id at
// verify time; `allowCredentials` stays empty so any registered authenticator
// can respond (usernameless sign-in).
export const assertionOptionsRequestSchema = z
  .object({
    purpose: z.literal("assertion"),
  })
  .strict();

export type AssertionOptionsRequest = z.infer<typeof assertionOptionsRequestSchema>;
