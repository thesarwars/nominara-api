import { z } from "zod";
import { dataSourceSchema } from "./data-source.schema.js";

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

// ------------------------------------------------------ A6 sentiment detail

/**
 * `GET /geo-insights/sentiment` -> `detail` (STORY-061, A6).
 *
 * Built ONCE, by the rollup, and persisted inside the finding that speaks for
 * the analysis (`GeoFinding.sentiment`); a read returns that stored object and
 * never re-aggregates `mention_facts`.
 *
 * `factual_error` is false WITH A REASON on every mention: there is no verified
 * structured data to compare an engine's claim against, so a contradiction is
 * never guessed at. `reason` is null (not a made-up class) when the parser
 * found none; `cues` are the stored `negative_reasons`.
 * `data_source` is null when nothing was measured (not "demo").
 */
export const sentimentMentionSchema = z
  .object({
    result_id: z.string().min(1),
    engine: z.string().min(1),
    captured_at: z.string().min(1),
    label: z.enum(["neutral", "negative"]),
    evidence_start: z.number().int().nonnegative(),
    evidence_end: z.number().int().nonnegative(),
    /** The sentence the verdict rests on; null when the capture's text is no longer held. */
    evidence_text: z.string().nullable(),
    cues: z.array(z.string()),
    reason: z.string().nullable(),
    factual_error: z.literal(false),
    factual_error_reason: z.string().min(1),
    /** The citation slot nearest the span, located in the answer text; null when none can be located. */
    citation: z
      .object({ slot_index: z.number().int().nonnegative(), url: z.string().min(1), domain: z.string().min(1) })
      .strict()
      .nullable(),
  })
  .strict();
export type SentimentMention = z.infer<typeof sentimentMentionSchema>;

export const sentimentClusterSchema = z
  .object({
    domain: z.string().min(1),
    mention_count: z.number().int().positive(),
    engine_count: z.number().int().positive(),
    engines: z.array(z.string()),
    reasons: z.array(z.string()),
  })
  .strict();

export const sentimentReasonClassSchema = z
  .object({
    reason: z.string().min(1),
    mention_count: z.number().int().positive(),
    /** The task this class will generate; the task engine is deferred, so there is a title and no task id. */
    task_title: z.string().min(1),
    /**
     * The same class's non-positive mentions in the PRIOR window (the trend). `null` when the prior window held no parsed answer:
     * nothing was measured, which is not a count of zero. Optional only because a detail persisted before the trend has none.
     */
    prior_mention_count: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const geoSentimentDetailSchema = z
  .object({
    slug: z.literal("sentiment"),
    data_source: dataSourceSchema.nullable(),
    brand_mentions: z.number().int().nonnegative(),
    non_positive_mentions: z.number().int().nonnegative(),
    /** Non-positive mentions whose citation could not be located: counted, never assigned a guessed source. */
    unattributed_mentions: z.number().int().nonnegative(),
    /** Most recent first, capped; `non_positive_mentions` is the uncapped count. */
    mentions: z.array(sentimentMentionSchema),
    /** Ranked: spanning more engines first, then more mentions, then domain. */
    clusters: z.array(sentimentClusterSchema),
    reason_classes: z.array(sentimentReasonClassSchema),
    factual_error_reason: z.string().min(1),
    /**
     * FR-GEO-A6c: `negative_cell_rate` (answers with any negative brand mention / parsed answers) against the alert threshold with
     * its sample floor. Tasks (one per reason class) exist only while `crossed` is true. Optional only for a pre-trend detail.
     */
    threshold: z
      .object({
        cells: z.number().int().nonnegative(),
        negative_cells: z.number().int().nonnegative(),
        /** `null` with no parsed answers: nothing measured, not a rate of zero. */
        negative_cell_rate: z.number().min(0).max(1).nullable(),
        prior_negative_cell_rate: z.number().min(0).max(1).nullable(),
        rate_threshold: z.number(),
        min_cells: z.number().int().positive(),
        crossed: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type GeoSentimentDetail = z.infer<typeof geoSentimentDetailSchema>;

// ------------------------------------------------------ A4 divergence detail

/**
 * `GET /geo-insights/divergence` -> `detail` (STORY-061, A4; scoring-models.md section 10).
 *
 * Only LIVE engine results are scored (owner question on demo engines is open): a demo result is counted in `excluded`, never in
 * the mean. `project_divergence` is `null` when nothing qualified (not measured), `0` when the engines agree.
 *
 * Citation COUNTS are never compared across engines. Attribution names the domains the winning engine cited and the losing one did
 * not (a set difference, ranked by `context_weight`); the affinity map and the surface comparison use the share of an engine's
 * ANSWERS that cite a domain, which a query fan-out cannot inflate.
 */
export const divergenceDomainSchema = z.object({ domain: z.string().min(1), context_weight: z.number().min(0) }).strict();

export const divergencePromptSchema = z
  .object({
    prompt_id: z.string().min(1),
    divergence: z.number().min(0).max(1),
    stability_score: z.number().min(0).max(1),
    winning_engine: z.string().min(1),
    losing_engine: z.string().min(1),
    /** Winner's citation domains absent from the loser's, by `context_weight` desc. Empty when the loser cited a superset. */
    missing_domains: z.array(divergenceDomainSchema),
  })
  .strict();

export const divergenceTargetSchema = z
  .object({
    losing_engine: z.string().min(1),
    domain: z.string().min(1),
    context_weight: z.number().min(0),
    prompts: z.number().int().positive(),
    winning_engines: z.array(z.string().min(1)),
  })
  .strict();

export const divergenceAffinitySchema = z
  .object({
    engine: z.string().min(1),
    /** Live answers on this engine in the window: the denominator of every rate below. */
    answers: z.number().int().positive(),
    domains: z.array(
      z
        .object({
          domain: z.string().min(1),
          answers_citing: z.number().int().positive(),
          presence_rate: z.number().min(0).max(1),
          source_class: z.string().nullable(),
        })
        .strict(),
    ),
    /** Share of this engine's citations by source class. */
    source_classes: z.array(z.object({ source_class: z.string().min(1), share: z.number().min(0).max(1) }).strict()),
  })
  .strict();

export const surfaceComparisonSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("normalised"),
      engines: z.tuple([z.string().min(1), z.string().min(1)]),
      basis: z.literal("answers_citing_domain / answers"),
      domains: z.array(z.object({ domain: z.string().min(1), rate_a: z.number().min(0).max(1), rate_b: z.number().min(0).max(1) }).strict()),
    })
    .strict(),
  z.object({ status: z.literal("refused"), reason: z.string().min(1) }).strict(),
]);
export type SurfaceComparison = z.infer<typeof surfaceComparisonSchema>;

export const geoDivergenceDetailSchema = z
  .object({
    slug: z.literal("divergence"),
    data_source: dataSourceSchema.nullable(),
    project_divergence: z.number().min(0).max(1).nullable(),
    qualifying_prompts: z.number().int().nonnegative(),
    excluded: z
      .object({
        fewer_than_two_live_engines: z.number().int().nonnegative(),
        no_stability: z.number().int().nonnegative(),
        unscored_results: z.number().int().nonnegative(),
        demo_results: z.number().int().nonnegative(),
      })
      .strict(),
    alert: z.object({ threshold: z.number(), min_prompts: z.number().int().positive(), crossed: z.boolean() }).strict(),
    /** Most divergent first, capped; `qualifying_prompts` is the uncapped count. */
    prompts: z.array(divergencePromptSchema),
    /** Engine-targeted work: the losing engine and the domain it lacks, ranked. */
    targets: z.array(divergenceTargetSchema),
    affinity: z.array(divergenceAffinitySchema),
    /** The two licensed Google surfaces, compared only on a normalised basis; `null` when either has no live answers. */
    surface_comparison: surfaceComparisonSchema.nullable(),
  })
  .strict();
export type GeoDivergenceDetail = z.infer<typeof geoDivergenceDetailSchema>;

// -------------------------------------------------------- A5 topics detail

/**
 * `GET /geo-insights/topics` -> `detail` (STORY-061, A5; scoring-models.md section 10).
 *
 * `achievability` is `null` when no alignment was measured for the topic: that is not a score of zero, and the topic is not
 * recommended (fail closed). A topic below `min_achievability` is listed with the reason and is never recommended.
 */
export const topicAuthoritySchema = z
  .object({
    entity_type: z.enum(["brand", "competitor"]),
    entity_label: z.string().min(1),
    sov: z.number().min(0).max(1),
    presence_rate: z.number().min(0).max(1),
    authority: z.number().min(0).max(1),
  })
  .strict();

export const topicRowSchema = z
  .object({
    cluster_id: z.string().min(1),
    label: z.string(),
    answers: z.number().int().positive(),
    commercial_intent: z.number().min(0).max(1),
    /** argmax over the tracked entities (ties go to the brand, then the label). */
    owner: topicAuthoritySchema,
    brand_authority: z.number().min(0).max(1),
    authorities: z.array(topicAuthoritySchema),
    current_alignment: z.number().nullable(),
    target_alignment: z.number().nullable(),
    achievability: z.number().min(0).max(1).nullable(),
    /** `null` when achievability is unmeasured. 0 when the brand owns the topic. */
    gap_priority: z.number().min(0).nullable(),
    recommended: z.boolean(),
    not_recommended_reason: z.string().min(1).nullable(),
  })
  .strict();

export const topicGapContentSchema = z
  .object({
    cluster_id: z.string().min(1),
    label: z.string(),
    required_concepts: z.array(z.object({ phrase: z.string().min(1), node_type: z.string().min(1), corpus_doc_ratio: z.number().min(0).max(1) }).strict()),
    /** The answer form the cluster's answers use most; `null` when none was classified. */
    structure: z.string().nullable(),
  })
  .strict();

export const geoTopicsDetailSchema = z
  .object({
    slug: z.literal("topics"),
    data_source: dataSourceSchema.nullable(),
    answers: z.number().int().nonnegative(),
    min_achievability: z.number().min(0).max(1),
    topics: z.array(topicRowSchema),
    gaps: z.array(topicGapContentSchema),
  })
  .strict();
export type GeoTopicsDetail = z.infer<typeof geoTopicsDetailSchema>;

// -------------------------------------------------------- A2 entity detail

/** The seven scored nodes of scoring-models.md §10 (`g2` and `capterra` are one scored node). */
export const entityScoredNodeSchema = z.enum([
  "wikidata",
  "wikipedia",
  "g2_or_capterra",
  "crunchbase",
  "linkedin",
  "github",
  "category_directory",
]);
export type EntityScoredNode = z.infer<typeof entityScoredNodeSchema>;

export const disambiguationLevelSchema = z.enum(["low", "medium", "high", "unmeasured"]);

/**
 * `GET /geo-insights/entity` -> `detail` (STORY-060, A2).
 *
 * Presence and completeness are separate facts: `status` is `thin` for a profile that is listed but not resolvable.
 * `link_gap` is a profile that exists but the brand's own structured data does not link to. Disambiguation risk is
 * reported HERE and never folded into `authority.score`; when it is `high` the score is null and `authority.suppressed`
 * says why. `risk` is null (not 0) when fewer than the minimum name matches were seen: unmeasured is not low.
 */
export const geoEntityDetailSchema = z
  .object({
    slug: z.literal("entity"),
    nodes: z.array(
      z
        .object({
          node: entityScoredNodeSchema,
          weight: z.number().min(0).max(1),
          status: z.enum(["unchecked", "absent", "thin", "complete"]),
          /** 0 absent or unchecked, 0.6 thin, 1.0 complete. */
          presence: z.number().min(0).max(1),
          url: z.string().nullable(),
          missing_fields: z.array(z.string()),
          in_brand_sameas: z.boolean(),
          link_gap: z.boolean(),
          /** What to do about it; null when nothing is needed. */
          fix_path: z.string().nullable(),
        })
        .strict(),
    ),
    sameas_coverage: z.number().min(0).max(1).nullable(),
    authority: z
      .object({
        score: z.number().min(0).max(100).nullable(),
        suppressed: z.boolean(),
        reason: z.string().nullable(),
      })
      .strict(),
    disambiguation: z
      .object({
        risk: z.number().min(0).max(1).nullable(),
        level: disambiguationLevelSchema,
        name_matches: z.number().int().nonnegative(),
        not_about_brand: z.number().int().nonnegative(),
        /** Name matches whose answer text could not be read; out of the risk denominator, never counted as false positives. */
        unjudged: z.number().int().nonnegative(),
        minimum_matches: z.number().int().positive(),
      })
      .strict(),
    cooccurrence: z
      .object({
        sufficient: z.boolean(),
        reason: z.string().nullable(),
        terms: z.array(z.string()),
        /** Cited passages containing a category term. */
        category_passages: z.number().int().nonnegative(),
        /** Share of those passages that also name the entity; null when the passage minimum is not met. */
        entities: z.array(
          z
            .object({
              name: z.string().min(1),
              is_brand: z.boolean(),
              passages: z.number().int().nonnegative(),
              rate: z.number().min(0).max(1).nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();
export type GeoEntityDetail = z.infer<typeof geoEntityDetailSchema>;

// ------------------------------------------------------- A3 structure detail

export const answerFormSchema = z.enum(["ranked_list", "comparison_table", "single_recommendation", "neutral_enumeration", "narrative"]);
export type AnswerFormValue = z.infer<typeof answerFormSchema>;
export const positionClassSchema = z.enum(["recommendation", "ranked", "neutral_list", "also_consider", "caveat"]);
export type PositionClassValue = z.infer<typeof positionClassSchema>;

const formCountSchema = z.object({ form: answerFormSchema, count: z.number().int().nonnegative() }).strict();

/**
 * The answer-form distribution of ONE prompt cluster (`topic_clusters`) over the window — STORY-040 AC8.
 *
 * `cluster_id`/`label` are null for the entry that gathers answers whose prompt belongs to no cluster: it is listed
 * rather than dropped, so the entries always sum to the detail's `total`. A cluster under the evidence minimum is
 * `sufficient: false` with `dominant_form: null` — its counts are real and shown, but it names no form to produce,
 * because a confident recommendation from thin data is the failure the minimum exists to prevent.
 */
export const geoStructureClusterSchema = z
  .object({
    cluster_id: z.string().uuid().nullable(),
    label: z.string().nullable(),
    total: z.number().int().nonnegative(),
    sufficient: z.boolean(),
    dominant_form: answerFormSchema.nullable(),
    forms: z.array(formCountSchema),
    engines: z.array(z.object({ engine: z.string(), total: z.number().int().nonnegative(), forms: z.array(formCountSchema) }).strict()),
  })
  .strict();
export type GeoStructureCluster = z.infer<typeof geoStructureClusterSchema>;

/**
 * `GET /geo-insights/structure` -> `detail` (STORY-060, A3).
 *
 * `page_forms` is `[]` and `template`/`rationale` carry the reason, because the
 * structure-match gap needs the brand's own page and no page crawl exists. A
 * gap is never inferred. `position` is `[]` (not zeros) when the brand was in
 * no answer: absent is not a share of zero.
 */
export const geoStructureDetailSchema = z
  .object({
    slug: z.literal("structure"),
    /** Distinct answers per form, across every engine. All five forms are listed, zeros included. */
    forms: z.array(formCountSchema),
    total: z.number().int().nonnegative(),
    dominant_form: answerFormSchema.nullable(),
    engines: z.array(
      z
        .object({
          engine: z.string(),
          data_source: dataSourceSchema.nullable(),
          total: z.number().int().nonnegative(),
          forms: z.array(formCountSchema),
        })
        .strict(),
    ),
    page_forms: z.array(z.string()),
    /** STORY-040 AC8. Optional only because a detail persisted before it existed has none; a fresh one always carries it. */
    clusters: z.array(geoStructureClusterSchema).optional(),
    brand_answers: z.number().int().nonnegative(),
    prior_brand_answers: z.number().int().nonnegative(),
    /** `prior` is null when the prior window held no brand answer: no baseline, not a baseline of zero. */
    position: z.array(
      z
        .object({ cls: positionClassSchema, share: z.number().min(0).max(1), prior: z.number().min(0).max(1).nullable() })
        .strict(),
    ),
    template: z.string().nullable(),
    rationale: z.string().nullable(),
  })
  .strict();
export type GeoStructureDetail = z.infer<typeof geoStructureDetailSchema>;

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
    /** The A6 detail, carried by the one finding that speaks for the analysis (STORY-061). */
    sentiment: geoSentimentDetailSchema.optional(),
    /** The A4 detail, carried by the analysis's first finding (STORY-061). */
    divergence: geoDivergenceDetailSchema.optional(),
    /** The A5 detail, carried by the analysis's first finding (STORY-061). */
    topics: geoTopicsDetailSchema.optional(),
    /** The A3 detail, persisted on the analysis's one finding so a read never re-aggregates (STORY-062). */
    structure: geoStructureDetailSchema.optional(),
    /** The A2 detail, persisted on the analysis's first finding (STORY-060). */
    entity: geoEntityDetailSchema.optional(),
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
