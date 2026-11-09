import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// `PUT /v1/projects/{id}/engines` — a project's per-engine overrides
// (api-specification.md, Projects & configuration; schemas/projects-and-prompts.md
// `project_engines`). The bounds are the table's own CHECKs: weight in (0, 5],
// sample_count 1..5. `project_engines` holds OVERRIDES only, so an engine not
// listed here is left as it was, and a listed engine must already be entitled.
//
// `.strict()` at both levels, so an unknown key is a 400 and never a silent drop.
// Each entry must change something: an entry that is only a key is a mistake.
export const projectEngineOverrideSchema = z
  .object({
    engine_key: z.string().min(1).max(64),
    enabled: z.boolean().optional(),
    weight: z.number().gt(0).max(5).optional(),
    sample_count: z.number().int().min(1).max(5).optional(),
  })
  .strict()
  .refine((entry) => entry.enabled !== undefined || entry.weight !== undefined || entry.sample_count !== undefined, {
    message: "name at least one of enabled, weight or sample_count",
  });

export const updateProjectEnginesRequestSchema = z
  .object({
    engines: z.array(projectEngineOverrideSchema).min(1).max(10),
  })
  .strict()
  .refine((body) => new Set(body.engines.map((entry) => entry.engine_key)).size === body.engines.length, {
    message: "engine_key may appear once",
    path: ["engines"],
  });

// The effective set after the write, read from `project_entitled_engines` so it
// is the same answer the scheduler and the scorecards get: an engine with no
// override row shows the defaults (enabled, weight 1, one sample).
export const projectEngineStateSchema = z
  .object({
    engine_key: z.string(),
    display_name: z.string(),
    enabled: z.boolean(),
    weight: z.number(),
    sample_count: z.number().int(),
  })
  .strict();

export const updateProjectEnginesResponseSchema = z
  .object({
    project_id: z.string().uuid(),
    engines: z.array(projectEngineStateSchema),
  })
  .strict();

export type UpdateProjectEnginesRequest = z.infer<typeof updateProjectEnginesRequestSchema>;
export type ProjectEngineState = z.infer<typeof projectEngineStateSchema>;
export type UpdateProjectEnginesResponse = z.infer<typeof updateProjectEnginesResponseSchema>;

// The :id of `PUT /projects/{id}/engines`. Validated at the boundary so a non-UUID is a 400, not a uuid-cast 500 deeper in.
export const updateProjectEnginesParamsSchema = z.object({ id: lowercaseUuidSchema }).strict();

export type UpdateProjectEnginesParams = z.infer<typeof updateProjectEnginesParamsSchema>;
