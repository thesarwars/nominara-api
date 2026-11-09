import { z } from "zod";

// STORY-059 - the alignment session payload: alignment, coverage, semantic nodes and projected gain
// (aux-and-geo-analysis.md section 7).
//
// HONESTY IS IN THE SHAPE, NOT IN THE COPY.
//  - Every gain figure sits under an `estimate` block that is a literal: method "additive_blend_estimate", confidence "modeled",
//    and the caveat. A reader cannot receive a gain without the label that qualifies it, because there is no field it could arrive
//    in without it. NFR-OPT-02 forbids any wording implying a ranking guarantee; `ALIGNMENT_CAVEAT` is the only sentence, and a unit
//    test scans this module and the alignment library for the banned wording.
//  - `anti_filler_policy.generation` is the literal "disabled" (AC12). There is no editor and no generation endpoint; the literal is what a contract
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

/**
 * The recommendation as STORED in `geo_alignments.recommendations` (jsonb: every jsonb column has a zod schema). `analyseNodes` writes it and
 * the analysis layer reads it; the WIRE shape (`alignmentRecommendationWireSchema`) is derived from it.
 */
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
    if (CLAIM_BEARING_NODE_TYPES.includes(r.node_type) && !r.requires_human_review) {
      ctx.addIssue({ code: "custom", message: "a compliance, metric or pricing_term node always requires human review", path: ["requires_human_review"] });
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
    method: z.literal(ALIGNMENT_ESTIMATE_METHOD),
    confidence: z.literal("modeled"),
    caveat: z.literal(ALIGNMENT_CAVEAT),
  })
  .strict();

/** api-specification.md section 8: one cited source of a recommendation. */
export const alignmentEvidenceSchema = z.object({ domain: z.string().min(1), url: z.string().min(1), snippet: z.string().min(1) }).strict();

/**
 * api-specification.md section 8 - a recommendation as the client reads it.
 *
 * ONLY `kind: "semantic_node"` is served. The reference also names `structure` and `jsonld` recommendations; no code produces them yet, so
 * the kind is a literal rather than an enum a reader would have to handle and never receive. Adding them is a new variant, not a loosening.
 * `severity` is `null`: the reference shows the field but states no rule that yields it (section 7 ranks by `priority_rank`), and a band
 * invented here would read as a measurement. `guardrail` is `phrase_only` for a node: a phrase to consider, never prose.
 */
export const alignmentRecommendationWireSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("semantic_node"),
    node_id: z.string().uuid(),
    node_type: semanticNodeTypeSchema,
    phrase: z.string().min(1),
    severity: z.null(),
    corpus_doc_ratio: z.number().min(0).max(1),
    present_in_content: z.boolean(),
    projected_gain: z.number().nullable(),
    priority_rank: z.number().int().min(1).nullable(),
    guardrail: z.literal("phrase_only"),
    requires_human_review: z.boolean(),
    /** Present exactly when review is required. */
    warning: z.string().min(1).nullable(),
    /** At least one: a recommendation with no source is not a recommendation. */
    evidence: z.array(alignmentEvidenceSchema).min(1),
    /** Never true: a claim-bearing concept is the customer's to add, if it is true of them. */
    auto_insert: z.literal(false),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.requires_human_review !== (r.warning !== null)) {
      ctx.addIssue({ code: "custom", message: "a node that requires review carries a warning, and only such a node does", path: ["warning"] });
    }
    if (CLAIM_BEARING_NODE_TYPES.includes(r.node_type) && !r.requires_human_review) {
      ctx.addIssue({ code: "custom", message: "a compliance, metric or pricing_term node always requires human review", path: ["requires_human_review"] });
    }
  });
export type AlignmentRecommendationWire = z.infer<typeof alignmentRecommendationWireSchema>;

/** One chunk of the page the alignment was measured on (the live page, or the draft once its recompute is ready). */
export const alignmentChunkSchema = z
  .object({
    chunk_index: z.number().int().nonnegative(),
    heading_path: z.array(z.string()),
    token_count: z.number().int().nonnegative(),
    /** Null for a chunk whose alignment was not measured; never 0. */
    alignment: z.number().nullable(),
    /** The lowest-aligned MEASURED chunk (the first by index on a tie); false for every chunk when none was measured. */
    weakest: z.boolean(),
  })
  .strict();

/**
 * api-specification.md section 8 - the alignment session payload, as `GET /v1/geo/alignment/{id}` and `PATCH` return it.
 *
 * ADDITIONS to the reference's example (kept, because a client needs them): `status` is the session's state (`pending|ready|stale|failed`, not
 * the example's `open`), with `status_reason` and `draft_status`; `low_confidence`; the top-level `estimate` label; and `auto_insert` per
 * recommendation. NOT SERVED: the example's `projection.if_all_applied` (a PAGE alignment after every change) - chunk gains are not page
 * units, so the projection carries the two chunk-unit sums only (see `alignmentProjectionSchema`).
 */
export const alignmentSessionPayloadSchema = z
  .object({
    alignment_id: z.string().uuid(),
    target_url: z.string().min(1),
    prompt_cluster: z
      .object({ cluster_id: z.string().uuid(), label: z.string(), prompt_count: z.number().int().nonnegative(), engines: z.array(z.string()) })
      .strict()
      .nullable(),
    embedding: z.object({ model: z.string().min(1), dims: z.number().int().positive(), storage: z.literal("halfvec") }).strict(),
    centroid: z
      .object({
        source_passage_count: z.number().int().nonnegative(),
        source_domains: z.array(z.string()),
        /** When the newest passage of the centroid was fetched; null when it has none. */
        built_at: z.string().datetime().nullable(),
      })
      .strict(),
    alignment: z
      .object({
        /** Token-weighted alignment of the live page (and `current`, once a draft exists, of the draft). Null before it is measured. */
        baseline: z.number().nullable(),
        current: z.number().nullable(),
        /** The empirical band [p50, p85] of the cited documents' own alignment; null with no cited document. */
        target_band: z.tuple([z.number(), z.number()]).nullable(),
        percentile_vs_cited_docs: z.number().int().min(0).max(100).nullable(),
      })
      .strict(),
    coverage: z
      .object({
        /** The scope's live concepts, counted only while they still describe THIS session (null once a later session moved them on). */
        required_nodes: z.number().int().nonnegative().nullable(),
        present_nodes: z.number().int().nonnegative().nullable(),
        coverage_ratio: z.number().min(0).max(1).nullable(),
      })
      .strict(),
    content: z.object({ chunks: z.array(alignmentChunkSchema) }).strict(),
    low_confidence: z.boolean(),
    estimate: alignmentEstimateSchema,
    recommendations: z.array(alignmentRecommendationWireSchema),
    projection: alignmentProjectionSchema.nullable(),
    anti_filler_policy: z
      .object({ generation: z.literal("disabled"), explanation: z.literal("Nominara returns phrases, structures, and schema - never generated prose.") })
      .strict(),
    /**
     * STORY-192. Where the session is, so an unfinished analysis can never read as a finished one:
     *   pending  a chunk, a cited passage or a concept of the scope still lacks its vector (or the page is still being fetched)
     *   ready    every vector is in and the figures above are final
     *   stale    opened under an embedding model that is no longer the provider's; the reason says so and the session is not analysed
     *   failed   the page could not be fetched, or the vectors never arrived before the deadline; the reason says which
     * Anything but `ready` carries NO coverage, NO recommendation, NO chunk and NO projection: a partial figure is never shown as final.
     */
    status: z.enum(["pending", "ready", "stale", "failed"]),
    status_reason: z.string().min(1).nullable(),
    /** The state of the customer's draft recompute; null when no draft was ever saved. While `pending`, the figures predate the draft. */
    draft_status: z.enum(["pending", "ready", "failed"]).nullable(),
    /**
     * Owner decision 92 - the draft prefill: the text of the live page the worker fetched (`geo_alignments.live_content_md`), so the editor opens on it instead of
     * an empty box. NULL until a session has fetched the page, and null for every session that is not `ready` (a pending page is not final); always the LIVE
     * page, never the customer's draft (`draft_content_md` is theirs and is not echoed). Served on the same route and permission as the rest of the payload.
     */
    live_content_md: z.string().nullable(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.status !== "ready" && p.live_content_md !== null) {
      ctx.addIssue({ code: "custom", message: "an analysis that is not ready serves no page text", path: ["live_content_md"] });
    }
    if (p.status !== "ready" && (p.coverage.coverage_ratio !== null || p.coverage.required_nodes !== null || p.coverage.present_nodes !== null || p.recommendations.length > 0 || p.projection !== null || p.content.chunks.length > 0)) {
      ctx.addIssue({ code: "custom", message: "an analysis that is not ready shows no coverage, chunk, recommendation or projection", path: ["status"] });
    }
    if (p.status !== "ready" && (p.alignment.baseline !== null || p.alignment.current !== null || p.alignment.percentile_vs_cited_docs !== null || p.alignment.target_band !== null)) {
      ctx.addIssue({ code: "custom", message: "an analysis that is not ready shows no baseline, current alignment, percentile or target band", path: ["status"] });
    }
    if (p.status === "ready" && p.status_reason !== null) {
      ctx.addIssue({ code: "custom", message: "a ready session has no status reason", path: ["status_reason"] });
    }
    if ((p.status === "stale" || p.status === "failed") && p.status_reason === null) {
      ctx.addIssue({ code: "custom", message: "a stale or failed session states its reason", path: ["status_reason"] });
    }
  });
export type AlignmentSessionPayload = z.infer<typeof alignmentSessionPayloadSchema>;
