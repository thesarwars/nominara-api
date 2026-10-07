import { z } from "zod";
import { engineDataSourceSchema, reportTimeframeSchema } from "./report-shared.schema.js";

// NEW-E-0 — GET /v1/projects/{id}/reports/methodology?timeframe=
//
// Not in api-specification §3's table; documented here by owner decision
// (planner contractMismatches: "Methodology"). NFR-AGY-05: the footer is
// generated server-side, non-removable (survives hide_nominara_brand and any
// section selection), and stored with every artifact. These are its fields.
//
// ABSENT IS NOT ZERO: `data_through` is null for a project with no rollup
// yet, and `live_capture_ratio` is null when unknown. lib/api/pending.ts types
// `data_through` as a non-null string; the frontend type must widen.

export const methodologyQuerySchema = z.object({ timeframe: reportTimeframeSchema.default("30d") }).strict();

export const methodologyEngineSourceSchema = z
  .object({ engine_key: z.string().min(1), data_source: engineDataSourceSchema })
  .strict();

export const methodologyFooterSchema = z
  .object({
    /** Latest metric_daily date for the project (a date, not a timestamp). Null when nothing has been rolled up. */
    data_through: z.iso.date().nullable(),
    /** Engine keys included — the frontend's field name and shape, unchanged. */
    engines: z.array(z.string().min(1)),
    /** Owner decision: one live/demo marker per included engine. */
    engine_data_sources: z.array(methodologyEngineSourceSchema),
    timeframe: reportTimeframeSchema,
    sample_size: z.number().int().nonnegative(),
    /** 0..1; null when unknown, never 0. */
    live_capture_ratio: z.number().min(0).max(1).nullable(),
    scoring_version: z.string().min(1),
    weight_overrides: z.record(z.string(), z.number()).nullable(),
    note: z.string().min(1),
  })
  .strict();

export type MethodologyQuery = z.infer<typeof methodologyQuerySchema>;
export type MethodologyFooter = z.infer<typeof methodologyFooterSchema>;
