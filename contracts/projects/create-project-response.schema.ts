import { z } from "zod";
import { OPTIONAL_PROJECT_FIELDS } from "./create-project-request.schema.js";

// STORY-043 — the 202 body. api-specification.md §4.4.
//
// 202, not 201: the project row exists and is readable, but the resource is
// not in its final state — discovery is still running. `poll` is how the
// client reaches the rest, and `expected_ms` is what lets it choose an
// interval instead of guessing.

export const DISCOVERY_STATUSES = ["pending", "running", "completed", "partial", "failed"] as const;

export const createProjectResponseSchema = z
  .object({
    project_id: z.string().uuid(),
    root_url: z.string(),
    root_domain: z.string(),
    status: z.string(),
    discovery_status: z.enum(DISCOVERY_STATUSES),
    prompts_cap: z.number().int().nonnegative(),
    // AC4 — echoes what the caller supplied, so a client renders "discovering"
    // only for the rest. Typed against the request's own key list, so a field
    // added there cannot be forgotten here.
    fields_supplied: z.array(z.enum(OPTIONAL_PROJECT_FIELDS)),
    poll: z
      .object({
        discovery: z.string(),
        expected_ms: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>;
export type DiscoveryStatus = (typeof DISCOVERY_STATUSES)[number];
