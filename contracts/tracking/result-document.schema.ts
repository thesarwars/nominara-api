import { z } from "zod";

// STORY-034 AC7's first half, unblocked by the parser — `GET /v1/results/{id}`,
// `api-specification.md` §6's canonical parser document.
//
// THIS IS WHAT THE LIVE ANSWER DRAWER RENDERS, and STORY-091 calls that "the
// most sensitive rendering surface in the product". Two fields carry that
// weight and everything else on this schema is context for them:
//
//   `raw_response.text`  the VERBATIM answer, as the engine wrote it
//   `highlight_map`      offsets into that text, and nothing else
//
// The drawer is required to derive every highlight from the map and to render
// no engine-supplied markup at all. That guarantee is only as good as this
// contract: a field carrying HTML, or a highlight carrying anything but
// offsets and a class name, would hand the client something it could be
// tempted to render.

/** §6's `schema` discriminator. */
export const RESULT_DOCUMENT_SCHEMA = "answer_capture.v3";

export const highlightSchema = z
  .object({
    char_start: z.number().int().nonnegative(),
    char_end: z.number().int().nonnegative(),
    /**
     * A CLASS NAME FROM A CLOSED SET, never a style, never markup.
     *
     * `entity-sentiment`, so a renderer maps it to one of a fixed number of
     * CSS classes and can emit nothing else. An open string here would let a
     * class name become an injection vector the moment someone interpolated
     * it into an attribute.
     */
    class: z.enum([
      "brand-positive",
      "brand-neutral",
      "brand-negative",
      "competitor-positive",
      "competitor-neutral",
      "competitor-negative",
      "other-positive",
      "other-neutral",
      "other-negative",
    ]),
    entity_id: z.string().uuid().nullable(),
  })
  .strict();

export const resultEntitySchema = z
  .object({
    entity_type: z.enum(["brand", "competitor", "other"]),
    entity_id: z.string().uuid().nullable(),
    label: z.string().min(1),
    matched_alias: z.string().min(1),
    occurrences: z.array(
      z
        .object({
          occurrence_index: z.number().int().nonnegative(),
          char_start: z.number().int().nonnegative(),
          char_end: z.number().int().nonnegative(),
          first_token_index: z.number().int().nonnegative(),
          list_position: z.number().int().positive().nullable(),
          in_link: z.boolean(),
        })
        .strict(),
    ),
    /** Null outside a ranked list — never 0, which would sort as the best position. */
    rank_position: z.number().int().positive().nullable(),
    prominence: z.number(),
    render: z
      .object({
        form: z.enum(["bare_text", "linked", "described", "structured_row", "featured"]),
        attrs: z.array(z.string()),
        score: z.number(),
      })
      .strict(),
    position_class: z.enum(["recommendation", "ranked", "neutral_list", "also_consider", "caveat"]),
    answer_form: z.string().nullable(),
    sentiment: z
      .object({
        label: z.enum(["positive", "neutral", "negative", "absent"]),
        score: z.number(),
        confidence: z.number(),
        method: z.enum(["lexicon", "heuristic", "llm_arbiter", "arbiter_rejected"]),
        /**
         * THE EVIDENCE SPAN, which STORY-038 AC3 requires on every verdict:
         * "there is no sentiment verdict without the sentence that caused
         * it." The drawer renders it beside the label, which is what turns
         * "this mention is negative" from an assertion into evidence.
         */
        evidence_char_start: z.number().int().nonnegative().nullable(),
        evidence_char_end: z.number().int().nonnegative().nullable(),
        negative_reasons: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export const resultCitationSchema = z
  .object({
    slot_index: z.number().int().positive(),
    raw_url: z.string(),
    normalized_url: z.string(),
    domain: z.string(),
    path: z.string().nullable(),
    anchor_text: z.string().nullable(),
    title: z.string().nullable(),
    is_owned: z.boolean(),
    is_competitor: z.boolean(),
    source_class: z.string().nullable(),
    /** Null means unresolved — excluded from share, neither owned nor foreign. */
    http_status: z.number().int().nullable(),
    resolved_at: z.string().datetime({ offset: true }).nullable(),
    position_weight: z.number(),
    /** `#:~:text=` — the exact passage the engine quoted. */
    text_fragment: z.string().nullable(),
  })
  .strict();

export const resultDocumentSchema = z
  .object({
    schema: z.literal(RESULT_DOCUMENT_SCHEMA),
    result_id: z.string().uuid(),
    project_id: z.string().uuid(),
    run_id: z.string().uuid(),
    prompt: z
      .object({
        prompt_id: z.string().uuid(),
        text: z.string(),
        intent_archetype: z.string(),
        funnel_stage: z.string(),
        /** Null until STORY-047's topic clustering exists — it is blocked on STORY-133. */
        cluster_id: z.string().uuid().nullable(),
      })
      .strict(),
    engine: z
      .object({
        key: z.string(),
        display_name: z.string(),
        capture_mode: z.enum(["api", "licensed_serp", "headless"]),
        adapter_version: z.string(),
        model_fingerprint: z.string().nullable(),
      })
      .strict(),
    capture: z
      .object({
        captured_at: z.string().datetime({ offset: true }),
        sample_index: z.number().int().nonnegative(),
        latency_ms: z.number().int().nullable(),
        response_tokens_est: z.number().int().nullable(),
        /** The length of the NORMALISED text served in `raw_response.text` (the string every offset indexes), not of the engine's raw bytes. */
        response_chars: z.number().int().nonnegative(),
        truncated: z.boolean(),
        content_hash: z.string(),
        normalizer_version: z.string(),
        /** Null until object storage exists — STORY-034 AC7's second half. */
        raw_object_key: z.string().nullable(),
        status: z.enum(["captured", "parsed", "failed", "blocked", "skipped"]),
        error_code: z.string().nullable(),
      })
      .strict(),
    cache: z
      .object({
        layer: z.enum(["live", "l1", "l2"]),
        hit: z.boolean(),
        source_result_id: z.string().uuid().nullable(),
      })
      .strict(),
    raw_response: z
      .object({
        format: z.string(),
        char_count: z.number().int().nonnegative(),
        /**
         * THE VERBATIM ANSWER. Normalised — every offset in this document
         * indexes THIS string, which is what `normalized_text_offsets`
         * asserts and what makes the highlight map usable at all.
         */
        text: z.string(),
        normalized_text_offsets: z.literal(true),
        /**
         * Owner decision 100(f). Present ONLY when `raw_expired` is true: the retained excerpt (null if the capture never had one). With the text gone
         * `text` is "" and `char_count` is 0, which then mean "not available", not "an empty answer".
         */
        excerpt: z.string().nullable().optional(),
      })
      .strict(),
    entities: z.array(resultEntitySchema),
    citations: z.array(resultCitationSchema),
    metrics: z
      .object({
        scoring_version: z.string(),
        /**
         * NULLABLE since migration 0021. The capture stage writes the row and
         * the parse stage fills the scores afterwards; between the two there
         * is no measurement, and the column's old `NOT NULL DEFAULT false`
         * reported one — "the brand was absent" — that nobody had made.
         */
        brand_present: z.boolean().nullable(),
        brand_rank_position: z.number().int().positive().nullable(),
        /** Null when nothing was measurable — never 0. */
        share_of_voice: z.number().nullable(),
        citation_count: z.number().int().nonnegative(),
        owned_citation_count: z.number().int().nonnegative(),
        citation_share: z.number().nullable(),
        sentiment_label: z.enum(["positive", "neutral", "negative", "absent"]).nullable(),
        sentiment_score: z.number().nullable(),
      })
      .strict(),
    highlight_map: z.array(highlightSchema),
    flags: z.array(z.string()),
    /**
     * Owner decision 100(f), STORY-077 R2: true once the capture is past the plan's raw-capture retention (or the sweep already expired it). The
     * document is then served without its text (`raw_response.text` is "", `highlight_map` is empty, `capture.response_chars` is 0) and with its facts
     * and excerpt; false inside the window. OPTIONAL only because a new required response field is classified a MAJOR change by contracts:diff.
     */
    raw_expired: z.boolean().optional(),
  })
  .strict();

export type Highlight = z.infer<typeof highlightSchema>;
export type ResultEntity = z.infer<typeof resultEntitySchema>;
export type ResultCitation = z.infer<typeof resultCitationSchema>;
export type ResultDocument = z.infer<typeof resultDocumentSchema>;
