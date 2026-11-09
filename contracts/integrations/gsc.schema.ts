import { z } from "zod";

// STORY-115 - api-specification.md section 3 "Integrations": `POST /integrations/gsc/oauth/start`, `GET /integrations/gsc/oauth/callback`
// (a GET because Google redirects the browser to it; the specification's POST is a documentation error), `GET`/`DELETE
// /integrations/gsc/{id}`, `POST /integrations/gsc/{id}/sync` and `GET /projects/{id}/gsc/correlation`.
//
// THE SCHEMA IS THE TRUST POSTURE. There is no field anywhere in it that could carry a credential: a connection answers with its
// property, its health and its frontier, and nothing a token could ride in. The ONLY OAuth scope this integration ever requests is
// the read-only one below; it is a constant here so the request and the test that asserts it read the same value.

/** `gsc_connections.property_type` CHECK. */
export const GSC_PROPERTY_TYPES = ["domain", "url_prefix"] as const;
export type GscPropertyType = (typeof GSC_PROPERTY_TYPES)[number];

/** `gsc_connections.health_status` CHECK: every documented state. */
export const GSC_HEALTH_STATUSES = ["unknown", "healthy", "degraded", "unauthorized", "revoked"] as const;
export type GscHealthStatus = (typeof GSC_HEALTH_STATUSES)[number];

/** The one scope this integration requests (FR-GSC-01a). A write scope is never requested. */
export const GSC_READ_ONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

/** The two source reports, never conflated (`gsc_daily.report`). */
export const GSC_REPORTS = ["ai_surface", "classic"] as const;
export type GscReport = (typeof GSC_REPORTS)[number];

/**
 * Search Console data lags the calendar by days (FR-GSC-01c). The frontier is stated, never implied; these are the sentences every
 * surface reads.
 */
export const GSC_FRONTIER_COPY =
  "Search Console data lags by two to three days. Figures run to the last synced date shown, not to today.";
export const GSC_AI_IMPRESSIONS_LIMIT_COPY =
  "AI-surface impressions are Google's own count of how often a link was shown in AI Overviews or AI Mode. They carry no query, no clicks and no position, and are not a measure of citation.";
export const GSC_CITATIONS_LIMIT_COPY =
  "Citations are Nominara's own measurement of answers that cite this site on the engines it tracks. They say nothing about whether a link was shown.";
export const GSC_SESSIONS_LIMIT_COPY =
  "AI-referred sessions are a measured floor from the first-party beacon: sessions whose referrer was stripped are not counted as AI.";
export const GSC_INDEPENDENCE_COPY =
  "Citations, link impressions and sessions are three independent measurements. None of them answers the outcome question on its own.";
export const GSC_CORRELATION_ONLY_COPY =
  "These figures are shown side by side so movements can be compared. They show correlation only; no claim is made that one caused another.";
export const GSC_SEARCH_QUERY_LABEL = "Search query (a real Google query, not an AI prompt)";

export const gscOauthStartRequestSchema = z
  .object({
    project_id: z.string().uuid(),
    /** As Search Console names it: `sc-domain:example.com` for a domain property, `https://example.com/` for a URL-prefix property. */
    property_url: z.string().min(1).max(300),
  })
  .strict();
export type GscOauthStartRequest = z.infer<typeof gscOauthStartRequestSchema>;

export const gscOauthStartResponseSchema = z
  .object({
    authorization_url: z.string(),
    state_expires_at: z.string(),
    property_type: z.enum(GSC_PROPERTY_TYPES),
  })
  .strict();
export type GscOauthStartResponse = z.infer<typeof gscOauthStartResponseSchema>;

/** Google adds its own parameters (`scope`, `authuser`, `prompt`) to the redirect, so this is deliberately not `.strict()`. */
export const gscOauthCallbackQuerySchema = z.object({
  state: z.string().min(1).max(2048),
  code: z.string().min(1).max(2048).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(500).optional(),
});
export type GscOauthCallbackQuery = z.infer<typeof gscOauthCallbackQuerySchema>;

export const gscConnectionSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    property_url: z.string(),
    property_type: z.enum(GSC_PROPERTY_TYPES),
    health_status: z.enum(GSC_HEALTH_STATUSES),
    /** A short reason code (`quota_exhausted`, `credential_revoked`), never provider text. `null` when healthy. */
    last_error: z.string().nullable(),
    /** The true data frontier, `YYYY-MM-DD`; `null` until the first slice has synced. Never today. */
    last_sync_date: z.string().nullable(),
    last_sync_at: z.string().nullable(),
    backfill_completed: z.boolean(),
    frontier_note: z.string(),
    created_at: z.string(),
  })
  .strict();
export type GscConnection = z.infer<typeof gscConnectionSchema>;

export const gscSyncResponseSchema = z.object({ connection_id: z.string(), queued: z.boolean() }).strict();
export type GscSyncResponse = z.infer<typeof gscSyncResponseSchema>;

export const gscCorrelationQuerySchema = z.object({ timeframe: z.enum(["7d", "30d", "90d"]).default("30d") }).strict();
export type GscCorrelationQuery = z.infer<typeof gscCorrelationQuerySchema>;

/** Every figure states its source, its frontier and its limits (FR-GSC-01c). */
export const gscSignalSchema = z
  .object({
    key: z.enum(["citations", "ai_surface_impressions", "ai_sessions"]),
    label: z.string(),
    source: z.string(),
    /** The last day the figure covers; `null` when it has none to state. */
    frontier: z.string().nullable(),
    limits: z.string(),
  })
  .strict();
export type GscSignal = z.infer<typeof gscSignalSchema>;

export const gscCorrelationPageSchema = z
  .object({
    url: z.string(),
    /** Our measurement: answers citing this page in the window. */
    citations: z.number().int().min(0),
    /** Google's measurement; `null` when Search Console reported no AI-surface row for the page, never 0. */
    gsc_ai_impressions: z.number().int().min(0).nullable(),
    /** The beacon's measurement; `null` when no beacon is configured for the project, never 0. */
    ai_sessions: z.number().int().min(0).nullable(),
  })
  .strict();
export type GscCorrelationPage = z.infer<typeof gscCorrelationPageSchema>;

export const gscQueryMatchSchema = z
  .object({
    prompt_id: z.string(),
    prompt_text: z.string(),
    method: z.literal("trigram"),
    /** 0..1, at or above the confidence floor: a weaker match is not joined at all. */
    confidence: z.number().min(0).max(1),
    /** Always false: a query match is never presented as exact. */
    exact: z.literal(false),
    low_confidence: z.boolean(),
  })
  .strict();
export type GscQueryMatch = z.infer<typeof gscQueryMatchSchema>;

export const gscSearchQuerySchema = z
  .object({
    query: z.string(),
    /** Always the classic report: a real search query, never evidence that anyone asked an answer engine. */
    report: z.literal("classic"),
    label: z.string(),
    impressions: z.number().int().min(0),
    clicks: z.number().int().min(0),
    match: gscQueryMatchSchema.nullable(),
  })
  .strict();
export type GscSearchQuery = z.infer<typeof gscSearchQuerySchema>;

export const gscCorrelationSchema = z
  .object({
    connected: z.boolean(),
    health_status: z.enum(GSC_HEALTH_STATUSES).nullable(),
    window_days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
    /** `YYYY-MM-DD` first and last day of the window; the end is the stored frontier. Both `null` before the first sync. */
    window_start: z.string().nullable(),
    window_end: z.string().nullable(),
    frontier: z.string().nullable(),
    frontier_note: z.string(),
    signals: z.array(gscSignalSchema),
    independence_note: z.string(),
    correlation_note: z.string(),
    pages: z.array(gscCorrelationPageSchema),
    search_queries: z.array(gscSearchQuerySchema),
  })
  .strict();
export type GscCorrelation = z.infer<typeof gscCorrelationSchema>;
