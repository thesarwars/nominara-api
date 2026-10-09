import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";
import { reportTimeframeSchema } from "../reports/report-shared.schema.js";

// NEW-E-0 — /v1/share-tokens. Permissions share_token:mint / share_token:revoke.
// integrations-and-sharing.md §4; STORY-098 (FR-AGY-01j..01o).
//
// DECISIONS CITED (planner contractMismatches, approved):
//  - Tab vocabulary: {overview, growth_map, matrix, sources, tasks} replaces
//    the DB CHECK {overview,tracking,sources,aux,tasks} (migration NEW-E-1).
//  - Revoke: DELETE /share-tokens/{id} (the frontend's verb) answers 200 with
//    the ShareToken, idempotently. The spec's PATCH is not offered.
//  - Mint returns { token, secret, url } NESTED (the frontend's shape).
//  - timeframe_lock: {24h,7d,30d,90d} or null — the DB set minus `custom`,
//    a superset of the frontend's '30d'|'90d'.
//  - Views: pages / duration_s / geo are null until telemetry exists
//    (heartbeat and GeoIP are week 2). Null is "not recorded", never 0.
//
// FR-AGY-01k: ONLY MintedShareToken carries `secret`. ShareToken (list,
// revoke, views) has neither the secret nor the hash.

export const portalTabSchema = z.enum(["overview", "growth_map", "matrix", "sources", "tasks"]);
export type PortalTab = z.infer<typeof portalTabSchema>;

export const shareTokenSchema = z
  .object({
    id: z.uuid(),
    label: z.string(),
    /** First 8 characters of the secret — the only secret-derived value ever returned. */
    token_prefix: z.string().length(8),
    scope_project_ids: z.array(z.uuid()),
    scope_tabs: z.array(portalTabSchema),
    hide_competitors: z.boolean(),
    hide_costs: z.boolean(),
    timeframe_lock: reportTimeframeSchema.nullable(),
    theme_id: z.uuid().nullable(),
    password_required: z.boolean(),
    allowed_email_domains: z.array(z.string()),
    max_views: z.number().int().positive().nullable(),
    view_count: z.number().int().nonnegative(),
    expires_at: z.iso.datetime().nullable(),
    revoked_at: z.iso.datetime().nullable(),
    created_at: z.iso.datetime(),
    last_viewed_at: z.iso.datetime().nullable(),
  })
  .strict();

// NEW-E-7 checkpoint-6 — the cursor envelope; `pagination` is published by the route's `listOf` marker.
export const shareTokenListQuerySchema = paginationRequestSchema;
export type ShareTokenListQuery = z.infer<typeof shareTokenListQuerySchema>;
export const shareTokenListResponseSchema = z.array(shareTokenSchema);

export const mintShareTokenRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    scope_project_ids: z.array(z.uuid()).min(1),
    scope_tabs: z.array(portalTabSchema).min(1),
    hide_competitors: z.boolean(),
    hide_costs: z.boolean(),
    timeframe_lock: reportTimeframeSchema.nullable(),
    /** null = passwordless, which requires `acknowledge_no_password: true` (audited at notice severity). */
    password: z.string().min(8).max(128).nullable(),
    acknowledge_no_password: z.boolean(),
    allowed_email_domains: z.array(z.string().min(3).max(253)).max(20),
    max_views: z.number().int().positive().nullable(),
    expires_at: z.iso.datetime().nullable(),
    /** Optional theme pin; must belong to the same workspace (FR-AGY-01i). */
    theme_id: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => v.password !== null || v.acknowledge_no_password, {
    message: "a passwordless link requires acknowledge_no_password",
    path: ["acknowledge_no_password"],
  });

/** The one and only schema containing `secret`. Shown once, at mint. */
export const mintedShareTokenSchema = z
  .object({
    token: shareTokenSchema,
    secret: z.string().min(1),
    url: z.string().min(1),
  })
  .strict();

export const shareTokenViewSchema = z
  .object({
    at: z.iso.datetime(),
    ip: z.string().nullable(),
    /** Coarse country code (ISO 3166-1 alpha-2); null until a GeoIP source exists. */
    geo: z.string().length(2).nullable(),
    user_agent: z.string().nullable(),
    authenticated: z.boolean(),
    pages: z.number().int().nonnegative().nullable(),
    duration_s: z.number().nonnegative().nullable(),
  })
  .strict();

export const shareTokenViewListQuerySchema = paginationRequestSchema;
export type ShareTokenViewListQuery = z.infer<typeof shareTokenViewListQuerySchema>;
export const shareTokenViewListResponseSchema = z.array(shareTokenViewSchema);

export type ShareToken = z.infer<typeof shareTokenSchema>;
export type MintShareTokenRequest = z.infer<typeof mintShareTokenRequestSchema>;
export type MintedShareToken = z.infer<typeof mintedShareTokenSchema>;
export type ShareTokenView = z.infer<typeof shareTokenViewSchema>;
