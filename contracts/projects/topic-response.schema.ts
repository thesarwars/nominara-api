import { z } from "zod";

// NEW-B-3 — `GET /v1/projects/{id}/topics` and the `PATCH /v1/topics/{id}`
// response. api-specification.md §3: "clusters with per-topic visibility,
// ownership, gap priority; rename". Table: schemas/projects-and-prompts.md
// `topic_clusters`.
//
// EVERY PERFORMANCE MEMBER IS NULLABLE, AND NULL IS NOT ZERO. The columns are
// denormalised by the rollup and are NULL until it has run; `0` would assert a
// measured score of zero, which is a different and false claim.
//
// `label_source` is `auto | user` because that is the table's CHECK. The
// story prose says "human"; the reference wins — see rename-topic-request.
//
// `leader_entity_id` is the id of who owns the topic. Resolving it to a
// display name needs the entity read, which is not this story's.

export const topicLabelSourceSchema = z.enum(["auto", "user"]);

export const topicSchema = z
  .object({
    topic_id: z.string().uuid(),
    project_id: z.string().uuid(),
    label: z.string(),
    label_source: topicLabelSourceSchema,
    prompt_count: z.number().int().nonnegative(),
    commercial_intent: z.number(),
    visibility_score: z.number().nullable(),
    authority_rank: z.number().int().nullable(),
    leader_entity_id: z.string().uuid().nullable(),
    gap_priority: z.number().nullable(),
    achievability: z.number().nullable(),
    computed_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

/** An empty `topics` array is the honest answer for a project nothing has clustered. */
export const topicListResponseSchema = z.object({ topics: z.array(topicSchema) }).strict();

export type Topic = z.infer<typeof topicSchema>;
export type TopicListResponse = z.infer<typeof topicListResponseSchema>;
