import { z } from "zod";

// STORY-180 (owner decision 54 (3), option 3B) — GET /v1/report-links/{workspaceId}/{token}
//
// The 7-day link in a scheduled-report email for a file over 8 MiB. It is an API route, not a presigned URL: a URL presigned
// with role (STS) credentials dies with the session, so the route checks a STORED, REVOCABLE token on every click and then
// 302-redirects to a fresh presigned URL that lives 15 minutes. No static keys.
//
// Public and unauthenticated: the token is the credential. The workspace id is in the path only so the lookup runs under that
// workspace's row-level security; it is not a secret and it proves nothing. Every refusal (unknown, wrong workspace, expired,
// file not stored) is the SAME 404, so the route is not an oracle for which tokens exist.
//
// ONE EXCEPTION, owner decision 60 (d): a token that matches a live artifact in the path's workspace but was REVOKED answers
// 401 `token_revoked` with the message "This link was revoked." A visitor can only reach that answer by holding the real token (a
// 256-bit HMAC), so it tells a guesser nothing. Revocation is `POST /v1/exports/{id}/revoke-link` (permission agency:branding, i.e.
// owner and admin).

/** The longest an emailed report link lives (integrations-and-sharing.md section 5). */
export const REPORT_LINK_TTL_DAYS = 7;
/** The presigned URL a click is redirected to (owner decision 54 (3)). */
export const REPORT_LINK_REDIRECT_SECONDS = 900;
/** "8 MB" means 8 MiB (owner decision 54 (4)): a file of at most this many bytes is attached, a larger one is linked. */
export const REPORT_ATTACHMENT_MAX_BYTES = 8_388_608;

export const reportLinkParamsSchema = z
  .object({
    workspaceId: z.uuid(),
    /** 43 characters: 32 bytes, base64url. */
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export type ReportLinkParams = z.infer<typeof reportLinkParamsSchema>;

/** POST /v1/exports/{id}/revoke-link - `id` is report_artifacts.id (the `export_id` of an export). Owner and admin (agency:branding). */
export const reportLinkRevokeParamsSchema = z.object({ id: z.uuid() }).strict();
export type ReportLinkRevokeParams = z.infer<typeof reportLinkRevokeParamsSchema>;

/** Idempotent: a second revoke returns the FIRST revocation's time. 404 for an unknown or other-workspace artifact. */
export const reportLinkRevokeResponseSchema = z
  .object({
    export_id: z.uuid(),
    link_revoked_at: z.iso.datetime(),
  })
  .strict();
export type ReportLinkRevokeResponse = z.infer<typeof reportLinkRevokeResponseSchema>;
