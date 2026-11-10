import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// `GET /v1/projects/{id}/benchmark` — the category-relative values of a project's category (STORY-176; owner decision 91).
//
// WHERE THE NUMBERS COME FROM. `platform_metrics`: one anonymised row per (date, category, engine), computed across workspaces by a
// SECURITY DEFINER function and published only when at least 20 DISTINCT WORKSPACES contribute (NFR-SEC-05, decision 88(d)). No workspace id
// and no other workspace's project ever appears here.
//
// PRIVACY (owner decision 93). Category membership counts only at the nightly batch, a project's membership changes at most once per 7 days, the
// percentiles are whole numbers, the workspace count is the band "20+", and a domain carries no weight. A test encodes the differencing hazard.
//
// NULL, NEVER ZERO. A category with fewer than 20 contributing workspaces has NO row (and a row older than the nightly batch window is not served), and the API answers `engines: null`, not an empty
// list and not zeros: a 0 would read as "the whole category scores nothing". A project with no category answers `category_slug: null` and
// `engines: null` the same way. Its own metrics are unaffected; it simply has no category-relative value.

/**
 * `platform_metrics.top_source_domains` (jsonb): the domains the category's answers cite most, MOST-CITED FIRST. The order is the whole signal: no weight,
 * share or count is published, because a weight is an exact figure that a workspace changing its own citations could difference away (owner decision 93).
 */
export const topSourceDomainsSchema = z
  .array(
    z
      .object({
        domain: z.string().min(1),
      })
      .strict(),
  )
  .max(10);

/**
 * The workspace count is a BAND, never a number (owner decision 93). Every published row has at least 20 contributing workspaces, so the only band
 * is "20+": an exact count, before and after one workspace's change, would let a caller solve for that workspace's value.
 */
export const WORKSPACE_COUNT_BAND = "20+" as const;

export const categoryBenchmarkEngineSchema = z
  .object({
    engine_key: z.string().min(1),
    /** The day these figures describe. Each engine reports its own newest aggregate, never one older than the nightly batch window. */
    metric_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    /** Distinct contributing workspaces, as a band: always "20+", or the row does not exist. */
    workspace_count_band: z.literal(WORKSPACE_COUNT_BAND),
    /** The percentiles and the AUX median are WHOLE NUMBERS: a rounded figure cannot be solved back to one workspace's value. */
    median_visibility: z.number().int(),
    p25_visibility: z.number().int(),
    p75_visibility: z.number().int(),
    median_aux_score: z.number().int(),
    top_source_domains: topSourceDomainsSchema,
  })
  .strict();

export const projectBenchmarkResponseSchema = z
  .object({
    project_id: lowercaseUuidSchema,
    /** The category the project currently holds, or null when it has none (undiscovered, or low-confidence and unconfirmed). */
    category_slug: z.string().nullable(),
    /** Null when no aggregate exists for the category: too few contributing workspaces, or no category. Never `[]`, never zeros. */
    engines: z.array(categoryBenchmarkEngineSchema).min(1).nullable(),
  })
  .strict();

export const projectBenchmarkParamsSchema = z.object({ id: lowercaseUuidSchema }).strict();

export type ProjectBenchmarkParams = z.infer<typeof projectBenchmarkParamsSchema>;
export type ProjectBenchmarkResponse = z.infer<typeof projectBenchmarkResponseSchema>;
export type CategoryBenchmarkEngine = z.infer<typeof categoryBenchmarkEngineSchema>;
export type TopSourceDomains = z.infer<typeof topSourceDomainsSchema>;
