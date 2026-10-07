import { z } from "zod";
import { dataSourceSchema } from "../analytics/data-source.schema.js";
import { projectEngineScoreSchema, projectListItemSchema } from "../projects/project-list-response.schema.js";

// NEW-B-2 — `GET /v1/workspaces/{id}/summary`. api-specification.md §3:
// "Command Center matrix". FR-DASH-01: "Renders from ONE GET
// /workspaces/{id}/summary" — the matrix, the health strip and the engine
// filter options all arrive in this payload, so no per-project request exists.
//
// THE WINDOW IS 30 DAYS AND THE CONTRACT SAYS SO. Every score, delta and the
// sparkline are read from `projects`' denormalised columns, which are 30-day
// windows only. A 7- or 90-day view would need `metric_daily`, which costs the
// one-request budget. `window_days` is a literal rather than a number so a
// client cannot render a "7 days" selector this payload cannot honour.
//
// `data_source` IS PER ENGINE, NOT PER RESPONSE, and it is CAPTURE PROVENANCE:
// derived from `answer_captures.normalizer_version` over the 30-day window, not
// from whether an adapter is configured. `live|demo|mixed`, and `null` when
// nothing was measured for that engine (absence, never "demo").
//
// NULL IS NOT ZERO throughout (see project-list-response.schema.ts): a limit
// of `null` is "no numeric cap" (custom/uncapped), `credits: null` is "the
// plan's grant is negotiated, not a figure" — never 0.

export const summaryEngineScoreSchema = projectEngineScoreSchema
  .extend({ data_source: dataSourceSchema.nullable() })
  .strict();

export const summaryProjectSchema = projectListItemSchema
  .omit({ engine_scores: true })
  .extend({ engine_scores: z.array(summaryEngineScoreSchema).nullable() })
  .strict();

export const summaryEngineSchema = z
  .object({ engine_key: z.string().min(1), data_source: dataSourceSchema.nullable() })
  .strict();

export const summaryCreditsSchema = z
  .object({
    available: z.number().int().nonnegative(),
    expiring_soon: z
      .object({ credits: z.number().int().positive(), expires_at: z.string() })
      .strict()
      .nullable(),
    cycle_end: z.string(),
  })
  .strict();

export const summaryHealthSchema = z
  .object({
    /** The caller's SCOPED project count — a scoped role never learns the workspace total. */
    projects_used: z.number().int().nonnegative(),
    projects_limit: z.number().int().nonnegative().nullable(),
    /** Sum of `prompts_active` over the same scoped set. */
    prompts_used: z.number().int().nonnegative(),
    prompts_limit: z.number().int().nonnegative().nullable(),
    credits: summaryCreditsSchema.nullable(),
  })
  .strict();

export const workspaceSummaryResponseSchema = z
  .object({
    workspace_id: z.string().uuid(),
    plan_key: z.string().min(1),
    window_days: z.literal(30),
    projects: z.array(summaryProjectSchema),
    /** The engines the scoped projects are entitled to — the engine filter's options. */
    engines: z.array(summaryEngineSchema),
    health: summaryHealthSchema,
  })
  .strict();

export type WorkspaceSummaryResponse = z.infer<typeof workspaceSummaryResponseSchema>;
export type SummaryProject = z.infer<typeof summaryProjectSchema>;
