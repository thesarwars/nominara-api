import { z } from "zod";

// STORY-015 — response of the OAuth flow-start endpoint. Only what the
// caller needs to begin the redirect: the fully-formed provider
// authorization URL (code_challenge/S256 already embedded by openid-client)
// and when the signed, single-use, session-bound state goes stale. The PKCE
// verifier itself is never returned — it stays server-side, keyed by state.
export const oauthStartResponseSchema = z
  .object({
    authorization_url: z.url(),
    state_expires_at: z.iso.datetime(),
  })
  .strict();

export type OauthStartResponse = z.infer<typeof oauthStartResponseSchema>;
