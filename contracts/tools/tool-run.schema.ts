import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";
import { paginationRequestSchema } from "../common/pagination.schema.js";
import { TOOL_SENTIMENT_LABELS, toolHeadlineFieldSchema, toolKeySchema, toolRunStatusSchema } from "./tool-key.schema.js";

// STORY-078 - a stored tool run on the wire: one shape for the timeline row, the re-opened run, and the expired metrics-only row.
//
//   GET   /v1/tools/runs         the shared timeline (cursor-paged, filterable, searchable by brand)
//   GET   /v1/tools/runs/{id}    one run, free forever, carries an ETag
//   PATCH /v1/tools/runs/{id}    {pinned}
//
// `null` and `0` stay distinct in every headline metric: `null` is "this tool produces none / nothing measured", `0` is a
// measured zero (a scan that found the brand in no answer reports `citation_count: 0`).

/** The headline metrics that survive expiry. Each is `null` where the tool produces none. */
export const toolRunHeadlineSchema = z
  .object({
    sov_estimate: z.number().min(0).max(1).nullable(),
    citation_count: z.number().int().nonnegative().nullable(),
    sentiment_label: z.enum(TOOL_SENTIMENT_LABELS).nullable(),
    brand_present: z.boolean().nullable(),
    aux_score: z.number().int().min(0).max(100).nullable(),
    entities_found: z.number().int().nonnegative().nullable(),
    pages_scanned: z.number().int().nonnegative().nullable(),
    items_kept: z.number().int().nonnegative().nullable(),
  })
  .strict();

/** Inputs, kept verbatim on the row so the conversion modal can pre-fill exactly. They survive expiry. */
export const toolRunInputsSchema = z
  .object({
    brand_name: z.string().nullable(),
    brand_url: z.string().nullable(),
    target_url: z.string().nullable(),
    query_text: z.string().nullable(),
    prompt_texts: z.array(z.string()).nullable(),
    engine_keys: z.array(z.string()),
    locale: z.string(),
  })
  .strict();

/**
 * FR-TL-08 - on EVERY result envelope, whatever the tool: the `not tracked` marker, a one-line statement of what the tool did
 * not check, and the headline figures that are ESTIMATES (flagged here, in the payload, so a client cannot render one as exact).
 */
export const toolRunPresentationSchema = z
  .object({
    not_tracked: z.literal(true),
    not_tracked_note: z.string().min(1),
    did_not_check: z.string().min(1),
    estimated_fields: z.array(toolHeadlineFieldSchema),
  })
  .strict();

/**
 * STORY-095 AC9 - the presentation notes a run is STORED with, in `tool_runs.result_json` under `presentation_notes`, written once at the
 * run's own write time (`ToolsService.startRun` / `finishRun`). A re-opened run serves these, not whatever wording this build composes, so a
 * stored result carries its own caveats forever. The key lives beside the tool's own result and is removed from the `result` a read returns.
 * A run stored with no result (a failed or empty run) holds no notes, and a run stored before this key existed reads the composed ones.
 */
export const PRESENTATION_NOTES_KEY = "presentation_notes";
export const storedPresentationNotesSchema = z
  .object({
    not_tracked_note: z.string().min(1),
    did_not_check: z.string().min(1),
  })
  .strict();
export type StoredPresentationNotes = z.infer<typeof storedPresentationNotesSchema>;

/** FR-TL-06 - what an expired run says about itself: what was removed, and when. Absent (`null`) on a run that has not expired. */
export const toolRunExpiredSchema = z
  .object({
    removed: z.literal("result"),
    removed_at: z.iso.datetime(),
    summary: z.string().min(1),
  })
  .strict();

/**
 * What converting a run would do, from the run alone (the same fields on every read, so the entity tag of a re-opened run does not
 * move when an unrelated project is created). The plan-dependent cost is `toolRunConversionPreviewSchema`.
 */
export const toolRunConversionSchema = z
  .object({
    state: z.enum(["available", "converted", "unavailable"]),
    /** Why it is `unavailable`; `null` otherwise. */
    reason: z.enum(["run_not_finished", "run_failed", "no_url"]).nullable(),
    /** Converting costs nothing, and neither does tracking thereafter (FR-TL-09). */
    credits: z.literal(0),
    prefill: z
      .object({
        project_name: z.string().nullable(),
        root_url: z.string().nullable(),
        prompts: z.array(z.string()),
        /** The competitor names the run found (`result_json.competitors`); empty for a tool that finds none, and once the payload has expired. */
        competitors: z.array(z.string()),
        /** The engines that answered the run, as engine keys, to suggest on the conversion panel (FR-SCAN-01g); empty for a tool that ran none. Informational: a project's engines come from its plan. */
        engines: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

/** The slot cost of converting a run, stated BEFORE the click: which project slot, how many prompt slots. */
export const toolRunConversionPreviewSchema = toolRunConversionSchema
  .extend({
    project_slot: z.object({ used: z.number().int().nonnegative(), max: z.number().int().nonnegative().nullable(), free: z.boolean() }).strict(),
    prompt_slots: z.object({ carried: z.number().int().nonnegative(), cap: z.number().int().nonnegative().nullable() }).strict(),
    /** `carried` is what will be created: the competitors found, up to `competitors.max_per_project`. */
    competitor_slots: z.object({ carried: z.number().int().nonnegative(), cap: z.number().int().nonnegative().nullable() }).strict(),
  })
  .strict();

export const toolRunSchema = z
  .object({
    id: z.uuid(),
    tool_key: toolKeySchema,
    status: toolRunStatusSchema,
    created_by: z.uuid().nullable(),
    created_at: z.iso.datetime(),
    /** Set at insert from the plan's retention; never computed at read time. */
    expires_at: z.iso.datetime(),
    /** A pinned run surfaces through the `?pinned=true` filter (a separate section, not a re-sort of the timeline); it still expires. */
    pinned: z.boolean(),
    inputs: toolRunInputsSchema,
    headline: toolRunHeadlineSchema,
    engines_succeeded: z.array(z.string()),
    engines_failed: z.array(z.string()),
    credits_charged: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative().nullable(),
    cache_layer: z.enum(["live", "l1"]),
    error_code: z.string().nullable(),
    diff_base_run_id: z.uuid().nullable(),
    diff_compare_run_id: z.uuid().nullable(),
    converted_project_id: z.uuid().nullable(),
    converted_at: z.iso.datetime().nullable(),
    presentation: toolRunPresentationSchema,
    expired: toolRunExpiredSchema.nullable(),
  })
  .strict();

/** The `data` of GET /tools/runs: a listOf operation's responseSchema is the array of items (the cursor envelope adds `pagination`). */
export const toolRunListResponseSchema = z.array(toolRunSchema);

/**
 * `tool_runs.result_json` (jsonb, <= 24 KB by trigger). Its inner shape belongs to each tool's own story; the shared core only
 * guarantees it is an object, so a tool cannot park a bare scalar or array in the timeline's payload column.
 */
export const toolRunResultSchema = z.record(z.string(), z.unknown());

export const toolRunDetailSchema = toolRunSchema
  .extend({
    /** `null` once the run has expired (see `expired`), or for a run that stored none. */
    result: toolRunResultSchema.nullable(),
    conversion: toolRunConversionSchema,
  })
  .strict();

export const toolRunListQuerySchema = paginationRequestSchema
  .extend({
    tool_key: toolKeySchema.optional(),
    /** Trigram match on the brand name. */
    brand: z.string().trim().min(1).max(200).optional(),
    created_by: lowercaseUuidSchema.optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    pinned: z.enum(["true", "false"]).optional(),
  })
  .strict();

/** The `{id}` path parameter: a uuid, so a malformed one is a 400 rather than a database cast error. */
export const toolRunIdSchema = lowercaseUuidSchema;

export const updateToolRunRequestSchema = z.object({ pinned: z.boolean() }).strict();

export type ToolRunHeadline = z.infer<typeof toolRunHeadlineSchema>;
export type ToolRunInputs = z.infer<typeof toolRunInputsSchema>;
export type ToolRunPresentation = z.infer<typeof toolRunPresentationSchema>;
export type ToolRunExpired = z.infer<typeof toolRunExpiredSchema>;
export type ToolRunConversion = z.infer<typeof toolRunConversionSchema>;
export type ToolRunConversionPreview = z.infer<typeof toolRunConversionPreviewSchema>;
export type ToolRun = z.infer<typeof toolRunSchema>;
export type ToolRunResult = z.infer<typeof toolRunResultSchema>;
export type ToolRunDetail = z.infer<typeof toolRunDetailSchema>;
export type ToolRunListQuery = z.infer<typeof toolRunListQuerySchema>;
export type UpdateToolRunRequest = z.infer<typeof updateToolRunRequestSchema>;
