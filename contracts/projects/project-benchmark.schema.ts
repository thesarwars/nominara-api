import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// `GET /v1/projects/{id}/benchmark` — the category-relative values of a project's category (STORY-176; owner decision 91).
//
// WHERE THE NUMBERS COME FROM. `platform_metrics`: one anonymised row per (date, category, engine), computed across workspaces by a
// SECURITY DEFINER function and published only when at least 20 DISTINCT WORKSPACES contribute (NFR-SEC-05, decision 88(d)). No workspace id
// and no other workspace's project ever appears here.
//
// NULL, NEVER ZERO. A category with fewer than 20 contributing workspaces has NO row, and the API answers `engines: null`, not an empty
// list and not zeros: a 0 would read as "the whole category scores nothing". A project with no category answers `category_slug: null` and
// `engines: null` the same way. Its own metrics are unaffected; it simply has no category-relative value.

/** `platform_metrics.top_source_domains` (jsonb): the domains the category's answers cite most, with their share of citation context. */
export const topSourceDomainsSchema = z
  .array(
    z
      .object({
        domain: z.string().min(1),
        context_weight: z.number().min(0).max(1),
      })
      .strict(),
  )
  .max(10);

export const categoryBenchmarkEngineSchema = z
  .object({
    engine_key: z.string().min(1),
    /** The day these figures describe. Each engine reports its own newest aggregate. */
    metric_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    /** Distinct contributing workspaces: always at least 20, or the row does not exist. */
    sample_size: z.number().int().min(20),
    median_visibility: z.number(),
    p25_visibility: z.number(),
    p75_visibility: z.number(),
    median_aux_score: z.number(),
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
