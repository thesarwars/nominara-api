import { z } from "zod";

// STORY-078 - the six tools, the lifecycle states and the headline metrics they share. Values are the `tool_runs` CHECK members
// verbatim (schemas/tools-attribution-agency.md), so a value the database would refuse cannot be named here.
export const TOOL_KEYS = ["visibility_scan", "prompt_research", "competitor_finder", "aux_audit", "schema_builder", "compare_runs"] as const;
export const toolKeySchema = z.enum(TOOL_KEYS);
export type ToolKey = z.infer<typeof toolKeySchema>;

/** The two tools that can never record a debit (`ck_tr_free_tools`). */
export const FREE_TOOL_KEYS = ["schema_builder", "compare_runs"] as const;

export const TOOL_RUN_STATUSES = ["running", "completed", "partial", "failed", "expired"] as const;
export const toolRunStatusSchema = z.enum(TOOL_RUN_STATUSES);
export type ToolRunStatus = z.infer<typeof toolRunStatusSchema>;

/** The states a run is written to exactly once, from `running` (`app.tool_run_status_write_once`). */
export const TOOL_RUN_TERMINAL_STATUSES = ["completed", "partial", "failed"] as const;

export const TOOL_SENTIMENT_LABELS = ["positive", "neutral", "negative", "absent"] as const;

/** The denormalised headline metrics. `null` is "this tool produces none / nothing measured"; `0` is a measured zero. */
export const TOOL_HEADLINE_FIELDS = [
  "sov_estimate",
  "citation_count",
  "sentiment_label",
  "brand_present",
  "aux_score",
  "entities_found",
  "pages_scanned",
  "items_kept",
] as const;
export const toolHeadlineFieldSchema = z.enum(TOOL_HEADLINE_FIELDS);
export type ToolHeadlineField = z.infer<typeof toolHeadlineFieldSchema>;
