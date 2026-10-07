import { z } from "zod";

// NEW-C-7 / STORY-054 read side — `GET /v1/projects/{id}/sources`,
// `api-specification.md` §3 (Analytics: "Source Citation Index with gap
// severity"). Matches the frontend's `SourceIndex` / `SourceDomain`, with the
// two honesty changes NEW-C-4 forced: presence and severity are `null` until
// a fetch has verified the domain — absence is never assumed.

export const sourceIndexQuerySchema = z
  .object({
    timeframe: z.enum(["7d", "30d", "90d"]).default("30d"),
  })
  .strict();

export const sourceClassSchema = z.enum([
  "community_forum",
  "review_marketplace",
  "developer_platform",
  "encyclopedic",
  "news_media",
  "blog",
  "vendor_owned",
  "academic",
  "government",
  "other",
]);

export const sourceDomainSchema = z
  .object({
    domain: z.string(),
    /** `context_weight` in [0,1], normalised to sum to 1 across the listed domains. */
    influence: z.number().min(0).max(1),
    citations: z.number().int().nonnegative(),
    prompts: z.number().int().nonnegative(),
    source_class: sourceClassSchema,
    /** `null` = not yet verified by fetching. Never `false` by assumption. */
    brand_present: z.boolean().nullable(),
    verified_at: z.string().nullable(),
    /** `null` while presence is unverified. */
    gap_severity: z.enum(["critical", "high", "medium", "low", "none"]).nullable(),
    seedable: z.boolean(),
    top_urls: z.array(z.object({ url: z.string(), citations: z.number().int().nonnegative(), last_seen: z.string() }).strict()),
    /** Tracked competitors whose own domain this is. */
    competitors_present: z.array(z.string()),
  })
  .strict();

export const sourceIndexResponseSchema = z
  .object({
    window: z.object({ from: z.string(), to: z.string() }).strict(),
    /** Source Coverage 0-100, beside AUX and never folded into a composite. `null` = not computed. */
    source_coverage: z.number().nullable(),
    domains: z.array(sourceDomainSchema),
  })
  .strict();

export type SourceIndexQuery = z.infer<typeof sourceIndexQuerySchema>;
export type SourceDomain = z.infer<typeof sourceDomainSchema>;
export type SourceIndexResponse = z.infer<typeof sourceIndexResponseSchema>;

/** The shape the index job stores in `project_source_index.top_urls` (jsonb). */
export const storedTopUrlsSchema = z.array(
  z.object({ url: z.string(), count: z.number().int().nonnegative(), last_seen: z.string() }).strict(),
);
