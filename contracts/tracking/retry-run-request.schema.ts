import { z } from "zod";

// STORY-195 AC4 - `POST /projects/{id}/runs/retry`. An empty body: the retry's scope is the first run's, never the caller's. Its own
// schema, not the manual trigger's, so the two endpoints can diverge without one silently changing the other.
export const retryRunRequestSchema = z.object({}).strict();

export type RetryRunRequest = z.infer<typeof retryRunRequestSchema>;
