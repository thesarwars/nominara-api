import { z } from "zod";
import { projectEngineStateSchema, updateProjectEnginesParamsSchema } from "./update-project-engines.schema.js";

// `GET /v1/projects/{id}/engines` (api-specification.md, Projects & configuration; same permission as the PUT, `project:update`).
//
// `project_engines` holds OVERRIDES only, and the effective set is derived from the catalog and the plan. The read returns both, so a
// client can show what the project saved apart from what the plan gives: `overrides` is exactly the saved rows (an override of an engine
// the plan no longer entitles is still listed, because it is stored), `engines` is the same effective set the PUT answers with.
export const getProjectEnginesParamsSchema = updateProjectEnginesParamsSchema;

export const projectEngineOverrideStateSchema = z
  .object({
    engine_key: z.string(),
    enabled: z.boolean(),
    weight: z.number(),
    sample_count: z.number().int(),
  })
  .strict();

export const getProjectEnginesResponseSchema = z
  .object({
    project_id: z.string().uuid(),
    overrides: z.array(projectEngineOverrideStateSchema),
    engines: z.array(projectEngineStateSchema),
  })
  .strict();

export type GetProjectEnginesParams = z.infer<typeof getProjectEnginesParamsSchema>;
export type ProjectEngineOverrideState = z.infer<typeof projectEngineOverrideStateSchema>;
export type GetProjectEnginesResponse = z.infer<typeof getProjectEnginesResponseSchema>;
