import { z } from "zod";

// The raw query string a provider's redirect appends to our callback URL.
// This is deliberately NOT `.strict()` (mirrors webauthnCredentialJsonSchema's
// own non-strict comment, contracts/identity/webauthn-credential-json.schema.ts):
// providers append extra query params we don't model — Google's `scope`,
// `authuser`, `prompt`, `hd`; GitHub's none; Microsoft's `session_state` —
// and none of it is ours to reject. `.strict()` here would make an
// unmodelled provider param a 400 on every single callback.
export const oauthCallbackQuerySchema = z.object({
  state: z.string().min(1),
  code: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export type OauthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;
