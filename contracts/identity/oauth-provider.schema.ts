import { z } from "zod";

// STORY-015 — the three supported OAuth 2.1 + PKCE providers
// (security-and-tenancy.md §5 "Authentication": Google, GitHub, Microsoft
// via `openid-client`). A fourth provider is a new decision, not an enum
// edit — every DTO/service that needs the provider set imports THIS.
export const oauthProviderSchema = z.enum(["google", "github", "microsoft"]);

export type OauthProvider = z.infer<typeof oauthProviderSchema>;
