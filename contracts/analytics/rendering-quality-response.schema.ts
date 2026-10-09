import { z } from "zod";
import { dataSourceSchema } from "./data-source.schema.js";
import { scorecardTimeframeSchema } from "./scorecards-response.schema.js";

// NEW-C-11 — `GET /v1/projects/{id}/rendering-quality`, `api-specification.md`
// §3's Analytics row: "per-engine breakdown and attribute coverage (D4)".
// The score itself is `scoring-models.md` §8's, computed by the one existing
// formula (the same figure the scorecards publish as `rendering_quality`).
//
// NULL IS NEVER ZERO. A score is null when no mention was counted; a coverage
// is null when there is nothing to take a share of. An engine that cannot
// render attributes at all is EXCLUDED, and says so (`renders_attributes`).

export const renderingQualityQuerySchema = z.object({ timeframe: scorecardTimeframeSchema }).strict();

/** §8's `attr_weight` set. `review_count` has no weight of its own (folded into rating). */
export const renderingAttributeSchema = z.enum([
  "price",
  "rating",
  "image",
  "spec",
  "description",
  "link",
  "availability",
]);

/**
 * The open AUX finding behind a missing attribute. Present only where an open
 * finding of the mapped `structured_data` rule exists (see the service for
 * the rule-to-attribute mapping) - never invented.
 */
export const renderingCauseSchema = z
  .object({
    finding_id: z.string().uuid(),
    rule_code: z.string().min(1),
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    title: z.string(),
  })
  .strict();

export const renderingAttributeCoverageSchema = z
  .object({
    attribute: renderingAttributeSchema,
    /** §8's `attr_weight` for this attribute. */
    weight: z.number(),
    /**
     * Share of the counted mentions that carry the attribute, in [0,1]. Null
     * when no mention was counted, or when the surface cannot show it.
     */
    coverage: z.number().min(0).max(1).nullable(),
    /** True where the engine's surface has no element that could carry it (priced elements are AI Mode's alone). */
    surface_unavailable: z.boolean(),
    /** The open finding that causes the attribute to be missing. Null when none exists or nothing is missing. */
    cause: renderingCauseSchema.nullable(),
  })
  .strict();

export const renderingEngineEntrySchema = z
  .object({
    engine_key: z.string().min(1),
    display_name: z.string().nullable(),
    /** False: the engine returns prose, so it is excluded from the denominator and `score` is null. */
    renders_attributes: z.boolean(),
    /** True where priced elements (price, rating, availability) exist: AI Mode only. */
    has_priced_elements: z.boolean(),
    /** §8, 0-100. Null with no counted mentions, or on an engine that cannot render attributes. Never 0 for "no data". */
    score: z.number().nullable(),
    mentions_counted: z.number().int().nonnegative(),
    attributes: z.array(renderingAttributeCoverageSchema),
    /** 'live' | 'demo' | 'mixed' | null (null = nothing measured). */
    data_source: dataSourceSchema.nullable(),
  })
  .strict();

export const renderingBlendedSchema = z
  .object({
    score: z.number().nullable(),
    mentions_counted: z.number().int().nonnegative(),
    /** Pooled over the engines whose surface can show the attribute, so a priced attribute is not diluted by a surface that has none. */
    attributes: z.array(renderingAttributeCoverageSchema),
    data_source: dataSourceSchema.nullable(),
  })
  .strict();

export const renderingQualityResponseSchema = z
  .object({
    project_id: z.string().uuid(),
    timeframe: z.enum(["7d", "30d", "90d"]),
    window: z.object({ from: z.string(), to: z.string(), timezone: z.string() }).strict(),
    /** The engines that support rich rendering, so the interface can state which. */
    rich_rendering_engines: z.array(z.string()),
    engines: z.array(renderingEngineEntrySchema),
    blended: renderingBlendedSchema,
  })
  .strict();

export type RenderingQualityQuery = z.infer<typeof renderingQualityQuerySchema>;
export type RenderingAttribute = z.infer<typeof renderingAttributeSchema>;
export type RenderingCause = z.infer<typeof renderingCauseSchema>;
export type RenderingAttributeCoverage = z.infer<typeof renderingAttributeCoverageSchema>;
export type RenderingEngineEntry = z.infer<typeof renderingEngineEntrySchema>;
export type RenderingQualityResponse = z.infer<typeof renderingQualityResponseSchema>;
