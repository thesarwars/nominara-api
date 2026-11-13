import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";
import { engineStatusEntrySchema } from "./engine-status.schema.js";

// STORY-090 AC7/AC8 - `GET /v1/projects/{id}/engine-health` (`tracking:read`): per-project engine health for the live status pip and the filter bar's engine
// multi-select, persisted (read from the catalog and the breaker), not only the realtime `engine.degraded` push, so it survives a reload.
//
// One entry per engine ENABLED for the project (the entitled, enabled set the matrix and the scorecards use), in the platform's engine order.
// `state` is derived from the same fields `GET /engines/status` serves, so the two cannot disagree:
//   unavailable   the breaker is `open`, or the catalog marks the engine `disabled`
//   degraded      the catalog marks it `degraded`, or the breaker is `half_open` (probing)
//   healthy       otherwise (`active`, or `beta`, with a `closed` breaker)
// `since` is when the breaker left `closed` for the current episode; null while healthy, and null for a `degraded`/`disabled` catalog state no breaker episode explains.
// PROVISIONAL (STORY-090 lists the shape only as `{engine_key, state, since}[]`): the three state names are this build's; a note for the docs.
export const PROJECT_ENGINE_STATES = ["healthy", "degraded", "unavailable"] as const;

export const projectEngineHealthEntrySchema = z
  .object({
    engine_key: z.string().min(1),
    state: z.enum(PROJECT_ENGINE_STATES),
    since: z.iso.datetime().nullable(),
  })
  .strict();

/** Every list takes the cursor envelope (owner decision 2026-10-09 pm #3), short ones included: `cursor`/`limit`, keyed on `engine_key`. */
export const projectEngineHealthQuerySchema = paginationRequestSchema;
export type ProjectEngineHealthQuery = z.infer<typeof projectEngineHealthQuerySchema>;

export const projectEngineHealthResponseSchema = z.array(projectEngineHealthEntrySchema);

export type ProjectEngineState = (typeof PROJECT_ENGINE_STATES)[number];
export type ProjectEngineHealthEntry = z.infer<typeof projectEngineHealthEntrySchema>;
export type ProjectEngineHealthResponse = z.infer<typeof projectEngineHealthResponseSchema>;

/** The state for one `GET /engines/status` entry. Pure, so the derivation above is one function both the route and its tests read. */
export function projectEngineState(entry: Pick<z.infer<typeof engineStatusEntrySchema>, "status" | "circuit_state">): ProjectEngineState {
  if (entry.circuit_state === "open" || entry.status === "disabled") return "unavailable";
  if (entry.status === "degraded" || entry.circuit_state === "half_open") return "degraded";
  return "healthy";
}
