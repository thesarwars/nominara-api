import { z } from "zod";
import { scanEngineResultEventSchema } from "../events/capture-events.schema.js";
import { toolHeadlineFieldSchema } from "./tool-key.schema.js";

// STORY-079 - the Visibility Scan: POST /v1/tools/visibility-scan (server-sent events, api-specification.md section 9), its free paired estimate
// (NFR-API-11), and the stored snapshot that lives in tool_runs.result_json.
//
// ONE SAMPLE PER ENGINE, STATED IN THE PAYLOAD (FR-VS-03). Every figure a scan derives is an ESTIMATE; each engine row and the terminal event carry
// the list of estimated fields so a client cannot render one as exact. `null` and `0` stay distinct: a brand absent from an answer has
// `rank_position: null` and `sentiment.score: null`, never 0.

/** The flat price (product-spec.md section 11, "Visibility Scan - 10 credits"). One sample per engine, so the cell count is fixed. */
export const VISIBILITY_SCAN_CREDITS = 10;

/** FR-VS-03, in the words the payload carries. */
export const SCAN_SAMPLE_STATEMENT = "One sample per engine: each figure comes from a single answer at a single moment, so every figure is an estimate.";

/** The brand, the query, and optionally the brand's URL and the competitors the caller already knows. There is no engine field: no picker (FR-TL-07). */
export const visibilityScanRequestSchema = z
  .object({
    brand_name: z.string().trim().min(1).max(200),
    brand_url: z.url({ protocol: /^https?$/ }).max(2048).optional(),
    query_text: z.string().trim().min(1).max(500),
    competitors: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  })
  .strict();

const scanEngineNameSchema = z.object({ engine_key: z.string().min(1), display_name: z.string().min(1) }).strict();

/** The free estimate: the price, the engines it will use, and nothing selectable. */
export const visibilityScanEstimateResponseSchema = z
  .object({
    tool_key: z.literal("visibility_scan"),
    credits: z.number().int().nonnegative(),
    rate: z.literal("flat"),
    /** Named BEFORE the run (FR-TL-07). Empty only when no engine this plan may use can capture yet; the scan is then refused, not charged. */
    engines: z.array(scanEngineNameSchema),
    engines_selectable: z.literal(false),
    sample_statement: z.string().min(1),
    wallet: z.object({ available: z.number().int().nonnegative(), available_after: z.number().int(), shortfall: z.number().int().nonnegative() }).strict(),
    consumes: z.object({ project_slots: z.literal(0), prompt_slots: z.literal(0), scheduled_envelope: z.literal(false) }).strict(),
  })
  .strict();

/** Why one engine did not answer, in operator-readable terms (AC "naming which engines failed and why"). */
export const scanEngineFailureSchema = z
  .object({
    engine: z.string().min(1),
    code: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

/** `scan.engine_result` on the wire: section 9's fields, with the not-in-this-answer cases made explicit and the estimate flag added. */
export const scanStreamEngineResultSchema = scanEngineResultEventSchema
  .extend({
    sentiment: z
      .object({
        label: z.enum(["positive", "neutral", "negative", "absent"]),
        /** `null` when the brand is absent from the answer: nothing was scored. */
        score: z.number().min(-1).max(1).nullable(),
      })
      .strict(),
    /** How old the answer is when it came from cache; 0 for a live capture. `captured_at` is the engine answer's own time, never the run's. */
    age_ms: z.number().int().nonnegative(),
    estimated: z.literal(true),
    /**
     * A citation the engine returned as a redirect wrapper (Gemini's grounding redirect) is not fetched on the interactive path, so its real host is only
     * a HINT (the engine's own title for the source) or unknown: `domain` / `is_owned` are `null` - not a foreign source, and not an owned one - when
     * the hint is missing. The wrapper's own host is never reported as a source.
     */
    citations: z.array(z.object({ slot: z.number().int().positive(), domain: z.string().min(1).nullable(), is_owned: z.boolean().nullable() }).strict()),
  })
  .strict();

export const scanStreamAcceptedSchema = z
  .object({
    tool_run_id: z.uuid(),
    engines: z.array(z.string().min(1)),
    credits: z.object({ reserved: z.number().int().nonnegative(), rate: z.literal("flat"), available_after: z.number().int() }).strict(),
    one_sample_per_engine: z.literal(true),
    sample_statement: z.string().min(1),
  })
  .strict();

const scanAggregateSchema = z
  .object({
    sov_estimate: z.number().min(0).max(1).nullable(),
    citation_count: z.number().int().nonnegative().nullable(),
    owned_citation_count: z.number().int().nonnegative().nullable(),
    sentiment_label: z.enum(["positive", "neutral", "negative", "absent"]).nullable(),
    brand_present: z.boolean().nullable(),
    engines_succeeded: z.array(z.string().min(1)),
    engines_failed: z.array(z.string().min(1)),
    estimated_fields: z.array(toolHeadlineFieldSchema),
  })
  .strict();

const scanConvertCtaSchema = z
  .object({
    endpoint: z.string().min(1),
    prefill: z
      .object({
        project_name: z.string().nullable(),
        root_url: z.string().nullable(),
        prompts: z.array(z.string().min(1)),
        competitors: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();

/** The terminal event, emitted in EVERY case (including all engines failed): a client never waits on a dead stream. */
export const scanStreamCompletedSchema = z
  .object({
    tool_run_id: z.uuid(),
    /** `running` only when `settled` is false (the stream's deadline ended it before the worker settled the run). */
    status: z.enum(["completed", "partial", "failed", "running"]),
    duration_ms: z.number().int().nonnegative(),
    aggregate: scanAggregateSchema,
    engine_failures: z.array(scanEngineFailureSchema),
    /**
     * `false` only on the terminal event the STREAM synthesises when its own deadline (or a fault) ends it before the worker has settled the run: the
     * money is then not yet final, so `credits.charged` / `credits.refunded` are `null` (unknown, not 0) and the run resource holds the final figure.
     */
    settled: z.boolean(),
    credits: z.object({ charged: z.number().int().nonnegative().nullable(), refunded: z.number().int().nonnegative().nullable() }).strict(),
    /** True when the latency deadline ended the run with engines still outstanding: what landed is returned (a partial), not nothing. */
    deadline_reached: z.boolean(),
    not_tracked: z.literal(true),
    did_not_check: z.string().min(1),
    sample_statement: z.string().min(1),
    convert_cta: scanConvertCtaSchema.nullable(),
  })
  .strict();

/** `tool_runs.result_json` for a scan (jsonb, <= 24 KB). `competitors` is the key the shared conversion contract reads. */
export const visibilityScanResultSchema = z
  .object({
    schema_version: z.literal(1),
    sample_statement: z.string().min(1),
    one_sample_per_engine: z.literal(true),
    engines: z.array(scanStreamEngineResultSchema),
    engine_failures: z.array(scanEngineFailureSchema),
    competitors: z.array(z.string().min(1)),
    deadline_reached: z.boolean(),
  })
  .strict();

/** The signed `lookup.execute` job payload (the signing layer adds `workspaceId` and `kid`). */
export const lookupExecuteJobPayloadSchema = z
  .object({
    toolRunId: z.uuid(),
    brandName: z.string().min(1),
    brandUrl: z.string().nullable(),
    queryText: z.string().min(1),
    competitors: z.array(z.string()),
    engines: z.array(z.string().min(1)).min(1),
    /** False when the workspace's plan carries `no_shared_cache`: no read from, and no seed of, the cross-tenant L1. Absent (an older job) means false: fail closed. */
    sharedCacheEnabled: z.boolean().default(false),
    locale: z.string().min(1),
    startedAt: z.iso.datetime(),
  })
  .passthrough();

export type VisibilityScanRequest = z.infer<typeof visibilityScanRequestSchema>;
export type VisibilityScanEstimateResponse = z.infer<typeof visibilityScanEstimateResponseSchema>;
export type ScanEngineFailure = z.infer<typeof scanEngineFailureSchema>;
export type ScanStreamEngineResult = z.infer<typeof scanStreamEngineResultSchema>;
export type ScanStreamAccepted = z.infer<typeof scanStreamAcceptedSchema>;
export type ScanStreamCompleted = z.infer<typeof scanStreamCompletedSchema>;
export type VisibilityScanResult = z.infer<typeof visibilityScanResultSchema>;
export type LookupExecuteJobPayload = z.infer<typeof lookupExecuteJobPayloadSchema>;
