import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";
import { auxFindingSeveritySchema } from "../aux/site-file-finding.schema.js";

// STORY-084 - Compare Runs: POST /v1/tools/compare-runs (owner decision 79: it stays a POST; FR-TL-05b's "two GETs" is corrected).
//
// A comparison REFERENCES two stored runs by id and reads their snapshots; it copies neither payload (the row stores only the two ids), it is free
// on every tier (`credits_charged` is the literal 0, and the database refuses a debit on the row), and nothing in it captures, enqueues or fetches.
//
// ADDED OR REMOVED, NEVER A DELTA FROM ZERO. An engine present in one run only is `added` or `removed` and carries no delta: a missing engine is not a
// score of nothing. `null` and `0` stay distinct everywhere: a delta is `null` where either side measured nothing.

export const COMPARE_RUNS_STATEMENT = "This compares two saved moments, not a trend: two observations of the same input, nothing in between.";

/** Only these two tools can be compared (decision 79); every other tool is refused with a reason. */
export const COMPARABLE_TOOL_KEYS = ["visibility_scan", "aux_audit"] as const;
export const comparableToolKeySchema = z.enum(COMPARABLE_TOOL_KEYS);

export const compareRunsRequestSchema = z
  .object({
    /** The earlier run: the diff reads the compare run against it. */
    base_run_id: lowercaseUuidSchema,
    compare_run_id: lowercaseUuidSchema,
  })
  .strict();

export const compareRunRefSchema = z
  .object({
    id: z.uuid(),
    created_at: z.iso.datetime(),
    /** When this run's stored result is removed: the retention window made visible (FR-TL-05d). */
    expires_at: z.iso.datetime(),
  })
  .strict();

export const wordDiffOpSchema = z.object({ op: z.enum(["equal", "insert", "delete"]), text: z.string() }).strict();

const engineSnapshotSchema = z
  .object({
    brand_present: z.boolean(),
    /** `null`: the brand is not in the answer. Never 0. */
    rank_position: z.number().int().positive().nullable(),
    sov: z.number().min(0).max(1),
    sentiment_label: z.enum(["positive", "neutral", "negative", "absent"]),
    sentiment_score: z.number().min(-1).max(1).nullable(),
    citation_count: z.number().int().nonnegative(),
  })
  .strict();

export const scanEngineDiffSchema = z
  .object({
    engine: z.string().min(1),
    /** `added`: only in the compare run. `removed`: only in the base run. Neither has a delta. */
    presence: z.enum(["both", "added", "removed"]),
    base: engineSnapshotSchema.nullable(),
    compare: engineSnapshotSchema.nullable(),
    /** `null` unless `presence` is `both`. Each figure is compare minus base, `null` where either side has none. */
    delta: z
      .object({
        brand_presence_changed: z.boolean(),
        rank_position: z.number().int().nullable(),
        sov: z.number().nullable(),
        sentiment_changed: z.boolean(),
        sentiment_score: z.number().nullable(),
        citation_count: z.number().int(),
      })
      .strict()
      .nullable(),
    /** Word-level diff of the answer excerpt; `null` unless `presence` is `both`. */
    excerpt_diff: z.array(wordDiffOpSchema).nullable(),
    /** True when an excerpt was too long to diff in full (the diff covers its first words). */
    excerpt_diff_truncated: z.boolean(),
  })
  .strict();

export const scanComparisonSchema = z.object({ engines: z.array(scanEngineDiffSchema) }).strict();

const auditFindingRefSchema = z
  .object({ rule_code: z.string().min(1), title: z.string(), severity: auxFindingSeveritySchema, url: z.string().nullable() })
  .strict();

export const auditComparisonSchema = z
  .object({
    score: z.object({ base: z.number().nullable(), compare: z.number().nullable(), delta: z.number().nullable() }).strict(),
    /** In the base run, not in the compare run. */
    resolved: z.array(auditFindingRefSchema),
    /** Same fingerprint in both runs, a worse severity in the compare run. */
    regressed: z.array(auditFindingRefSchema.extend({ base_severity: auxFindingSeveritySchema }).strict()),
    /** In the compare run, not in the base run. */
    new: z.array(auditFindingRefSchema),
    /** A stored result keeps the findings that fit 24 KB; the rest were counted, not kept. A non-zero figure means the lists are a lower bound. */
    findings_omitted: z.object({ base: z.number().int().nonnegative(), compare: z.number().int().nonnegative() }).strict(),
  })
  .strict();

export const compareRunsResponseSchema = z
  .object({
    /** The comparison's own row on the shared timeline. */
    id: z.uuid(),
    tool_key: z.literal("compare_runs"),
    compared_tool: comparableToolKeySchema,
    base: compareRunRefSchema,
    compare: compareRunRefSchema,
    scan: scanComparisonSchema.nullable(),
    audit: auditComparisonSchema.nullable(),
    credits_charged: z.literal(0),
    /** True when the pair had already been compared: the stored comparison is re-opened, no new row. */
    reopened: z.boolean(),
    not_tracked: z.literal(true),
    not_tracked_note: z.string().min(1),
    did_not_check: z.string().min(1),
    /** States that this is two moments, not a trend. */
    statement: z.literal(COMPARE_RUNS_STATEMENT),
  })
  .strict();

/** `tool_runs.result_json` of a comparison: the two ids and the tool, never a copy of either payload. */
export const compareRunsStoredResultSchema = z
  .object({
    schema_version: z.literal(1),
    compared_tool: comparableToolKeySchema,
    base_run_id: z.uuid(),
    compare_run_id: z.uuid(),
  })
  .strict();

export type CompareRunsRequest = z.infer<typeof compareRunsRequestSchema>;
export type CompareRunsResponse = z.infer<typeof compareRunsResponseSchema>;
export type ScanEngineDiff = z.infer<typeof scanEngineDiffSchema>;
export type ScanComparison = z.infer<typeof scanComparisonSchema>;
export type AuditComparison = z.infer<typeof auditComparisonSchema>;
export type WordDiffOp = z.infer<typeof wordDiffOpSchema>;
export type CompareRunsStoredResult = z.infer<typeof compareRunsStoredResultSchema>;
