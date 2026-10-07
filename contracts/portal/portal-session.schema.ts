import { z } from "zod";
import { portalTabSchema } from "../agency/share-token.schema.js";

// NEW-E-0 — POST /v1/portal/session. Auth: token secret (+ password).
// integrations-and-sharing.md §4; STORY-098 scenarios 5, 6, 8, 16.
//
// The response sets the `__Host-` cookie (HttpOnly, Secure, SameSite=Lax, 4 h,
// signed + encrypted) via Set-Cookie. The cookie payload is NOT part of the
// body and never appears here. The body is deliberately minimal: scenario 5
// ("raw pre-authentication response has no data").
//
// Refusals disclose nothing (scenario 16). Unknown, expired, revoked and
// view-capped links all answer the SAME 401 `token_revoked` (a code already in
// api-specification §2) with the same neutral message. The demo's 410 is not
// in the taxonomy and is not used. A wrong password is 401 `unauthenticated`
// (an unknown token performs a dummy Argon2 verify and answers identically);
// the 5th failure locks the token for 15 minutes: 429 `rate_limited` with
// details.retry_after_ms. 10 mints/hour/IP per api-specification §6.

export const portalSessionRequestSchema = z
  .object({
    secret: z.string().min(16).max(256),
    password: z.string().min(1).max(128).optional(),
    /**
     * integrations-and-sharing.md §3 session flow: `{ secret, password, email? }`. Required, and its domain
     * checked, only where the token has `allowed_email_domains`. A link without domains ignores it.
     */
    email: z.email().max(254).optional(),
  })
  .strict();

export const portalSessionResponseSchema = z
  .object({
    expires_at: z.iso.datetime(),
  })
  .strict();

/** The decrypted cookie payload — the ONLY source of portal scope. Never read from path, query or header. */
export const portalCookiePayloadSchema = z
  .object({
    token_id: z.uuid(),
    workspace_id: z.uuid(),
    scope_project_ids: z.array(z.uuid()).min(1),
    scope_tabs: z.array(portalTabSchema).min(1),
    theme_id: z.uuid().nullable(),
  })
  .strict();

export type PortalSessionRequest = z.infer<typeof portalSessionRequestSchema>;
export type PortalSessionResponse = z.infer<typeof portalSessionResponseSchema>;
export type PortalCookiePayload = z.infer<typeof portalCookiePayloadSchema>;
