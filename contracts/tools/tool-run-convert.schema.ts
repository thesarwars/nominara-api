import { z } from "zod";
import { toolRunConversionPreviewSchema } from "./tool-run.schema.js";

// STORY-078 - POST /v1/tools/runs/{id}/convert: ONE conversion contract for all six entry points (FR-TL-09).
// Idempotent by run: converting twice returns the first project (`already_converted: true`) and creates nothing.

/** Both optional: the run's own inputs pre-fill the project, and the caller supplies only what the run lacked (typically the URL). */
export const convertToolRunRequestSchema = z
  .object({
    root_url: z.string().url().max(2048).optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const convertToolRunResponseSchema = z
  .object({
    run_id: z.uuid(),
    project_id: z.uuid(),
    converted_at: z.iso.datetime(),
    already_converted: z.boolean(),
    /** The slot cost of the conversion that created the project; a repeat creates nothing and charges nothing. */
    slot_cost: toolRunConversionPreviewSchema.pick({ project_slot: true, prompt_slots: true, competitor_slots: true, credits: true }),
    poll: z.object({ discovery: z.string() }).strict(),
  })
  .strict();

export type ConvertToolRunRequest = z.infer<typeof convertToolRunRequestSchema>;
export type ConvertToolRunResponse = z.infer<typeof convertToolRunResponseSchema>;
