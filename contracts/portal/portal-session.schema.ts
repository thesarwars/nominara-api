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

// Owner decision 71 (b) — allowed-email-domain sign-in. Where the token carries `allowed_email_domains`, POST /portal/session
// (after the password, where one is required) answers 202 with this body and NO cookie: a six-digit code has been mailed to
// the address. The body is the same constant whether or not the mailbox exists (we cannot know, and must not seem to).
export const portalSessionCodeSentResponseSchema = z.object({ code_sent: z.literal(true) }).strict();

/** Six digits, as mailed. Anything else is a 400 before any lookup. */
export const PORTAL_CODE_PATTERN = /^[0-9]{6}$/;

/**
 * POST /portal/session/verify — the second step. The code is bound to the token and the address it was mailed to, so the
 * link's `secret` and the address travel with it. Where the link has a password it is sent AGAIN and checked again, with the same
 * lock as the first step: a code alone must never open a password-protected link (a visitor holding only the link could otherwise
 * guess a live code, 5 tries at a time). Answers like POST /portal/session: the cookie and `{ expires_at }`.
 */
export const portalSessionVerifyRequestSchema = z
  .object({
    secret: z.string().min(16).max(256),
    password: z.string().min(1).max(128).optional(),
    email: z.email().max(254),
    code: z.string().regex(PORTAL_CODE_PATTERN, "a code is six digits"),
  })
  .strict();

// Owner decision 71 (c) — telemetry. POST /portal/telemetry, portal cookie only. The VIEW the beat belongs to is the one the
// cookie carries (`view_id`), never one the request names; the request says only which tab the visitor is on. Duration is
// measured by the server (now minus the view's start), so a client cannot report a time it did not spend.
export const portalTelemetryRequestSchema = z.object({ tab: portalTabSchema }).strict();
export const portalTelemetryResponseSchema = z.object({ recorded: z.boolean() }).strict();

/** The decrypted cookie payload — the ONLY source of portal scope. Never read from path, query or header. */
export const portalCookiePayloadSchema = z
  .object({
    token_id: z.uuid(),
    workspace_id: z.uuid(),
    scope_project_ids: z.array(z.uuid()).min(1),
    scope_tabs: z.array(portalTabSchema).min(1),
    theme_id: z.uuid().nullable(),
    /**
     * Owner decision 71 (c): the `share_token_views` row this session opened, so telemetry beats find it without the
     * request naming one. Optional so a session minted before this field existed stays valid (it simply records nothing).
     */
    view_id: z.uuid().optional(),
  })
  .strict();

export type PortalSessionCodeSentResponse = z.infer<typeof portalSessionCodeSentResponseSchema>;
export type PortalSessionVerifyRequest = z.infer<typeof portalSessionVerifyRequestSchema>;
export type PortalTelemetryRequest = z.infer<typeof portalTelemetryRequestSchema>;
export type PortalTelemetryResponse = z.infer<typeof portalTelemetryResponseSchema>;
export type PortalSessionRequest = z.infer<typeof portalSessionRequestSchema>;
export type PortalSessionResponse = z.infer<typeof portalSessionResponseSchema>;
export type PortalCookiePayload = z.infer<typeof portalCookiePayloadSchema>;
