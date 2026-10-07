import { z } from "zod";

// STORY-062 — `GET /v1/projects/{id}/geo-insights` (the digest) and
// `GET /v1/projects/{id}/geo-insights/{analysis}` (one analysis), plus the
// WRITE shape every analysis persists through. Matches the frontend's
// GeoDigest, GeoAnalysisSummary and GeoAnalysis.
//
// THERE ARE SEVEN SLUGS FOR EIGHT SPECIFIED ANALYSES, ON PURPOSE.
// Query fan-out has no value here because no v1 engine exposes its
// sub-queries, and inferring them and presenting them as observed is
// prohibited (geo-and-vectors.md, `geo_analyses.analysis`). Do NOT add an
// eighth member to make a call site compile: leaving it out is what makes the
// schema refuse to write that analysis with inferred data. Adding it is a
// migration (the column's CHECK) plus this enum, on the day an engine exposes
// its sub-queries.
export const geoSlugSchema = z.enum([
  "alignment",
  "entity",
  "structure",
  "divergence",
  "topics",
  "sentiment",
  "freshness",
]);
export type GeoSlug = z.infer<typeof geoSlugSchema>;

export const geoWindowSchema = z.enum(["7d", "30d", "90d"]).default("30d");

export const geoInsightsQuerySchema = z.object({ timeframe: geoWindowSchema }).strict();
export type GeoInsightsQuery = z.infer<typeof geoInsightsQuerySchema>;

export const geoAnalysisParamsSchema = z.object({ analysis: geoSlugSchema }).strict();

// ---------------------------------------------------------------- write side

export const geoEvidenceSchema = z
  .object({
    url: z.string().url(),
    snippet: z.string().min(1),
    corpus_doc_ratio: z.number().min(0).max(1).optional(),
  })
  .strict();

/**
 * One persisted finding (geo-and-vectors.md `geo_analyses.findings`).
 *
 * EVIDENCE IS REQUIRED (`min(1)`): a finding without a source URL is dropped,
 * not rendered with a caveat. And every finding terminates in a task rule OR
 * an explicit no-action verdict (FR-GEO-01) — the refine below rejects a
 * finding with neither, and one claiming both.
 */
export const geoFindingSchema = z
  .object({
    id: z.string().min(1),
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    headline: z.string().min(1),
    detail: z.string().optional(),
    evidence: z.array(geoEvidenceSchema).min(1),
    metric: z.object({ name: z.string().min(1), value: z.number(), target: z.number().optional() }).strict().optional(),
    task_rule_code: z.string().min(1).optional(),
    no_action: z.literal(true).optional(),
    lever_rank: z.number().int().min(1).max(3).optional(),
  })
  .strict()
  .refine((f) => (f.task_rule_code !== undefined) !== (f.no_action === true), {
    message: "a finding carries a task_rule_code or no_action: true, exactly one",
  });
export type GeoFinding = z.infer<typeof geoFindingSchema>;

export const geoAnalysisWriteSchema = z
  .object({
    analysis: geoSlugSchema,
    window_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    window_days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
    score: z.number().nullable(),
    score_label: z.string().nullable(),
    evidence_cells: z.number().int().nonnegative(),
    evidence_passages: z.number().int().nonnegative(),
    sufficient: z.boolean(),
    suppression_reason: z.string().min(1).nullable(),
    findings: z.array(geoFindingSchema),
    lever_rank: z.number().int().min(1).max(3).nullable(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (!a.sufficient) {
      if (a.suppression_reason === null) {
        ctx.addIssue({ code: "custom", message: "an insufficient analysis states its reason", path: ["suppression_reason"] });
      }
      if (a.findings.length > 0 || a.score !== null || a.lever_rank !== null) {
        ctx.addIssue({ code: "custom", message: "an insufficient analysis publishes no score, findings or lever", path: ["findings"] });
      }
    }
  });
export type GeoAnalysisWrite = z.infer<typeof geoAnalysisWriteSchema>;

// ----------------------------------------------------------------- read side

export const geoAnalysisSummarySchema = z
  .object({
    slug: geoSlugSchema,
    code: z.enum(["A1", "A2", "A3", "A4", "A5", "A6", "A7"]),
    title: z.string(),
    /** `insufficient`: below its stated minimum, so it renders no number (FR-GEO-UI-02). */
    status: z.enum(["ready", "low_confidence", "insufficient", "post_launch"]),
    evidence: z
      .object({
        passages: z.number().int().nonnegative().nullable(),
        cells: z.number().int().nonnegative(),
        window_days: z.number().int().positive(),
      })
      .strict(),
    minimum: z.string(),
    /** What is missing, when `insufficient` or `post_launch`. Never a blank panel. */
    needs: z.string().nullable(),
    headline: z.string().nullable(),
    score: z.number().nullable(),
    verdict: z.enum(["action", "no_action"]).nullable(),
    lever_rank: z.number().int().min(1).max(3).nullable(),
  })
  .strict();
export type GeoAnalysisSummary = z.infer<typeof geoAnalysisSummarySchema>;

export const geoActionSchema = z
  .object({
    label: z.string(),
    task_title: z.string().nullable(),
    task_id: z.string().nullable(),
    href: z.string().nullable(),
    engines: z.array(z.string()),
  })
  .strict();

export const leverSchema = z
  .object({
    rank: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    headline: z.string(),
    analysis: z.string(),
    analysis_href: z.string(),
    /** Null until an open task exists for the finding's rule. */
    task: z.object({ task_id: z.string(), label: z.string(), href: z.string() }).strict().nullable(),
  })
  .strict();
export type Lever = z.infer<typeof leverSchema>;

export const geoDigestSchema = z
  .object({
    sufficient: z.boolean(),
    needs: z.string().nullable(),
    /** AT MOST THREE — a digest that lists everything ranks nothing. */
    levers: z.array(leverSchema).max(3),
    evidence: z.object({ passages: z.number().int().nonnegative(), cells: z.number().int().nonnegative() }).strict(),
    analyses: z.array(geoAnalysisSummarySchema),
  })
  .strict();
export type GeoDigest = z.infer<typeof geoDigestSchema>;

/**
 * Per-slug detail is not persisted by this layer; each analysis story adds its
 * own variant. Until then the shape is the slug alone, and the value is null
 * for every analysis that has no detail builder.
 */
export const geoDetailSchema = z.object({ slug: geoSlugSchema }).catchall(z.unknown());

export const geoAnalysisSchema = z
  .object({
    summary: geoAnalysisSummarySchema,
    detail: geoDetailSchema.nullable(),
    actions: z.array(geoActionSchema),
  })
  .strict();
export type GeoAnalysis = z.infer<typeof geoAnalysisSchema>;
