import { z } from "zod";

// STORY-025 T13 — api-specification.md §12: "Token buckets in Valkey; keys
// are ADDITIVE — every applicable bucket must have capacity." This file is
// the SHAPE of that configuration. The fifteen route classes' numbers are
// data (src/api/rate-limit/defaults.ts), transcribed from §12's table.
//
// §12 defines SEVENTEEN route classes (`plan_change` and `plan_change_preview` are STORY-184's; `tool_site_files` is owner
// decision 71(d)'s; `public_plans` is STORY-103's). STORY-025's own acceptance criteria
// list nine. The reference beats the story (spec-navigation precedence), so
// fifteen are implemented and the story text goes on the hand-carried
// specification-fix list.
//
// Rate limits are an ABUSE control and independent of credits: exhausting one
// returns `429 rate_limited` and debits nothing. That is a statement about
// ORDER, not just accounting — RateLimitGuard runs before CreditGuard, so a
// refused request never reaches the reservation path at all.

/** §12's table, one member per row, in the reference's own order. */
export const rateLimitRouteClassSchema = z.enum([
  "auth",
  "reads",
  "writes",
  "capture_backed_tools",
  "capture_backed_tools_capped_tiers",
  "project_runs",
  "project_aux_audits",
  "tool_site_files",
  "geo_alignment",
  "command_parse",
  "command_execute",
  "credit_pack_purchase",
  "plan_change",
  "plan_change_preview",
  "portal_session",
  "public_niche_reports",
  "public_plans",
]);

export type RateLimitRouteClass = z.infer<typeof rateLimitRouteClassSchema>;

/**
 * Which identity a bucket counts against.
 *
 * Every scope is a KEY COMPONENT in a store with no row-level security, so
 * the scope is also the isolation boundary: a workspace-scoped counter whose
 * key omits the workspace id lets one tenant exhaust another's capacity.
 * src/lib/cache/valkey-keys.ts owns that construction and asserts it.
 */
export const rateLimitScopeSchema = z.enum(["user", "workspace", "ip"]);

export type RateLimitScope = z.infer<typeof rateLimitScopeSchema>;

/**
 * A rolling window is the ordinary case. `utc_day` exists because §12's
 * capped-tier row says "3/**UTC-day** hard cap" — a calendar boundary, not a
 * 24-hour rolling one. The two differ for a customer: a rolling window frees
 * capacity continuously, a UTC-day cap frees it all at midnight, and the
 * `daily_limit_reached` remediation ("come back tomorrow") is only truthful
 * for the second.
 */
export const rateLimitWindowSchema = z.enum(["rolling", "utc_day"]);

export type RateLimitWindow = z.infer<typeof rateLimitWindowSchema>;

export const rateLimitBucketSchema = z
  .object({
    scope: rateLimitScopeSchema,
    limit: z.number().int().positive(),
    window: rateLimitWindowSchema,
    /** Required for a rolling window, absent for `utc_day`, whose boundary is the calendar. */
    window_ms: z.number().int().positive().optional(),
    /**
     * §12 marks exactly one bucket a "hard cap". A hard cap is not liftable by
     * buying credits, which is what separates `daily_limit_reached` from
     * `insufficient_credits` in the taxonomy — two of the five distinct
     * spend-and-limit conditions `NFR-API-13` forbids collapsing.
     */
    hard_cap: z.boolean().default(false),
  })
  .strict()
  .refine((bucket) => (bucket.window === "rolling" ? bucket.window_ms !== undefined : bucket.window_ms === undefined), {
    message: "a rolling bucket needs window_ms; a utc_day bucket's boundary is the calendar and must not carry one",
  });

export type RateLimitBucket = z.infer<typeof rateLimitBucketSchema>;

/**
 * One row of §12's table.
 *
 * `buckets` is a LIST, not one per scope: the capture-backed rows carry two
 * user buckets each ("5/min, 40/day" and "1/min, 3/UTC-day"), and flattening
 * them into a single per-scope slot would silently drop the daily half.
 */
export const rateLimitRouteClassConfigSchema = z
  .object({
    route_class: rateLimitRouteClassSchema,
    buckets: z.array(rateLimitBucketSchema).min(1),
    /** §12's own column. Capacity above the steady rate, so a normal burst is not a refusal. */
    burst: z.number().int().positive(),
  })
  .strict();

export type RateLimitRouteClassConfig = z.infer<typeof rateLimitRouteClassConfigSchema>;

/**
 * The whole configuration document — every route class §12 defines, and no
 * others. `.length` rather than `.min`: a class silently missing from the
 * document is a route with NO limit, which is the failure this schema exists
 * to make impossible.
 */
export const RATE_LIMIT_ROUTE_CLASS_COUNT = rateLimitRouteClassSchema.options.length;

export const rateLimitConfigSchema = z
  .array(rateLimitRouteClassConfigSchema)
  .length(RATE_LIMIT_ROUTE_CLASS_COUNT)
  .refine(
    (classes) => new Set(classes.map((entry) => entry.route_class)).size === RATE_LIMIT_ROUTE_CLASS_COUNT,
    { message: "every route class in §12 must appear exactly once" },
  );

export type RateLimitConfig = z.infer<typeof rateLimitConfigSchema>;

/**
 * §1's rate-limit response headers. Present on a refusal AND on a success —
 * a client that only learns its remaining capacity by being refused cannot
 * pace itself, which is the point of publishing them.
 */
export const RATE_LIMIT_HEADERS = {
  limit: "x-ratelimit-limit",
  remaining: "x-ratelimit-remaining",
  reset: "x-ratelimit-reset",
  retryAfter: "retry-after",
} as const;
