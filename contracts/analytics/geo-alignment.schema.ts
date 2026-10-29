import { z } from "zod";

// STORY-059 - the alignment session payload: alignment, coverage, semantic nodes and projected gain
// (aux-and-geo-analysis.md section 7).
//
// HONESTY IS IN THE SHAPE, NOT IN THE COPY.
//  - Every gain figure sits under an `estimate` block that is a literal: method "additive_blend_estimate", confidence "modeled",
//    and the caveat. A reader cannot receive a gain without the label that qualifies it, because there is no field it could arrive
//    in without it. NFR-OPT-02 forbids any wording implying a ranking guarantee; `ALIGNMENT_CAVEAT` is the only sentence, and a unit
//    test scans this module and the alignment library for the banned wording.
//  - `generation` is the literal "disabled" (AC12). There is no editor and no generation endpoint; the literal is what a contract
//    test asserts, so the day someone adds one it is a build failure rather than a quiet erosion.
//  - Compliance, metric and pricing nodes carry `requires_human_review: true` and an `accuracy_warning`, and `auto_insert` is the
//    literal `false` on EVERY recommendation (AC13). A claim-bearing node is never inserted by the product.
//  - A figure that was not measured is `null`, never 0: no corpus means no band, an unmeasured page means no percentile.

export const ALIGNMENT_ESTIMATE_METHOD = "additive_blend_estimate" as const;

/** The one caveat. Fixed text: it describes the model, and makes no promise about any engine's output. */
export const ALIGNMENT_CAVEAT =
  "Modeled estimate of embedding proximity to the passages engines cited for these prompts. It is not a measurement of any engine's behaviour and does not predict where, or whether, a page is cited." as const;

export const semanticNodeTypeSchema = z.enum([
  "capability",
  "compliance",
  "integration",
  "metric",
  "persona",
  "industry",
  "pricing_term",
  "entity",
  "differentiator",
]);
export type SemanticNodeType = z.infer<typeof semanticNodeTypeSchema>;

/** The node types that assert a fact about the customer: flagged for human review, warned about, never auto-inserted. */
export const CLAIM_BEARING_NODE_TYPES: readonly SemanticNodeType[] = ["compliance", "metric", "pricing_term"];

export const alignmentEstimateSchema = z
  .object({
    method: z.literal(ALIGNMENT_ESTIMATE_METHOD),
    confidence: z.literal("modeled"),
    caveat: z.literal(ALIGNMENT_CAVEAT),
  })
  .strict();

export const alignmentRecommendationSchema = z
  .object({
    node_id: z.string().uuid(),
    phrase: z.string().min(1),
    node_type: semanticNodeTypeSchema,
    corpus_doc_ratio: z.number().min(0).max(1),
    /** Estimated change in the best chunk's cosine to the centroid if the phrase were added. Null when it could not be modeled. */
    projected_gain: z.number().nullable(),
    /** 1-based; null for a node with no modeled gain. A node modeled to move the page away from the centroid (gain <= 0) is not recommended. */
    priority_rank: z.number().int().min(1).nullable(),
    /** EVERY node is evidenced: a source URL and the sentence it came from. */
    evidence_url: z.string().min(1),
    evidence_snippet: z.string().min(1),
    requires_human_review: z.boolean(),
    /** Present exactly when review is required. */
    accuracy_warning: z.string().min(1).nullable(),
    /** Never true: a claim-bearing concept is the customer's to add, if it is true of them. */
    auto_insert: z.literal(false),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.requires_human_review !== (r.accuracy_warning !== null)) {
      ctx.addIssue({ code: "custom", message: "a node that requires review carries an accuracy warning, and only such a node does", path: ["accuracy_warning"] });
    }
  });
export type AlignmentRecommendation = z.infer<typeof alignmentRecommendationSchema>;

export const alignmentProjectionSchema = z
  .object({
    /**
     * CHUNK-level units: every gain is the change in ONE chunk's cosine, so these sums are NOT a change in the page's alignment (the
     * page figure is a token-weighted mean over all chunks). There is deliberately no projected page alignment: adding a chunk gain to
     * the page mean would overstate it by roughly the number of chunks.
     * The sum of every recommendation's gain with no diminishing returns. Shown so the difference is visible, never as a forecast. */
    naive_sum: z.number(),
    /** Gains weighted by 0.85^(i-1) for the i-th ranked node. */
    diminished_sum: z.number(),
    diminishing_returns_factor: z.literal(0.85),
  })
  .strict();

export const alignmentSessionPayloadSchema = z
  .object({
    session_id: z.string().uuid(),
    target_url: z.string().min(1),
    prompt_cluster_id: z.string().uuid().nullable(),
    embedding_model: z.string().min(1),
    /** Token-weighted alignment of the live page (and, once a draft exists, of the draft). Null before it is measured. */
    baseline_alignment: z.number().nullable(),
    current_alignment: z.number().nullable(),
    /** The empirical band [p50, p85] of the cited documents' own alignment; null with no cited document. */
    target_band: z.object({ low: z.number(), high: z.number() }).strict().nullable(),
    percentile_vs_corpus: z.number().int().min(0).max(100).nullable(),
    coverage_ratio: z.number().min(0).max(1).nullable(),
    centroid_source_count: z.number().int().nonnegative(),
    centroid_domains: z.array(z.string()),
    low_confidence: z.boolean(),
    estimate: alignmentEstimateSchema,
    recommendations: z.array(alignmentRecommendationSchema),
    projection: alignmentProjectionSchema.nullable(),
    generation: z.literal("disabled"),
  })
  .strict();
export type AlignmentSessionPayload = z.infer<typeof alignmentSessionPayloadSchema>;
