import { z } from "zod";

// NEW-C-2 — `POST /v1/projects/{id}/competitors`: track a competitor, and
// promote a "detected, not tracked" entity (STORY-092 AC3, FR-CO-02a).
//
// The request is the same three fields discovery confirmation takes for a
// competitor, and `.strict()` like every request schema, so an unknown key is
// a 400 rather than a silent drop.
export const trackCompetitorRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    root_domain: z.string().trim().min(1).max(253).optional(),
    aliases: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  })
  .strict();

// `credits_charged` is the literal 0, not a number: FR-CO-02 says promotion
// consumes no credits, and a type that cannot say anything else makes the
// claim part of the contract rather than a comment beside it.
export const trackCompetitorResponseSchema = z
  .object({
    entity_id: z.string().uuid(),
    name: z.string(),
    /** Distinct workspace-local dates whose stored mention facts were re-tagged to this competitor. 0 when nothing was stored under its name. */
    backfilled_days: z.number().int().nonnegative(),
    credits_charged: z.literal(0),
  })
  .strict();

export type TrackCompetitorRequest = z.infer<typeof trackCompetitorRequestSchema>;
export type TrackCompetitorResponse = z.infer<typeof trackCompetitorResponseSchema>;
