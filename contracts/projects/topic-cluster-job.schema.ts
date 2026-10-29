import { z } from "zod";

// STORY-047 — the payload of a `topic.cluster` job. Not an HTTP body: it crosses the queue boundary from its producer (the
// topic-cluster sweep) to `topic-cluster.handler.ts`, the one consumer. Strict, so an unknown key fails the job at the boundary
// instead of being silently dropped.
//
// The idempotency key is the producer's (topology: `topic:{project}:{prompt_set_hash}`). Recomputation is itself idempotent over an
// unchanged prompt set, so a redelivered or duplicated job writes the same clusters.

/** Why a recomputation was asked for. Telemetry only: the handler recomputes the same way for every reason. */
export const TOPIC_CLUSTER_REASONS = ["initial", "prompt_set_change", "weekly"] as const;

export const topicClusterJobPayloadSchema = z
  .object({
    // Added by the producer for every tenant-scoped queue.
    workspaceId: z.string().uuid(),
    kid: z.string(),
    projectId: z.string().uuid(),
    reason: z.enum(TOPIC_CLUSTER_REASONS),
  })
  .strict();

export type TopicClusterJobPayload = z.infer<typeof topicClusterJobPayloadSchema>;
