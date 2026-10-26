import { z } from "zod";

// STORY-063 / STORY-052 — the payload of a `task.generate` job. Not an HTTP body: it crosses the queue boundary, from its
// two producers (the rollup handler after each day's rollup, and the AUX finding lifecycle after an audit commits) to
// `task-generate.handler.ts`, the one consumer. Strict, so an unknown key fails the job at the boundary instead of being
// silently dropped.
//
// The idempotency key is the producer's (topology: `taskgen:{project}:...`), and generation is itself idempotent
// (task fingerprint), so a redelivered or duplicated job writes nothing twice.

/** The `trigger_kind`s a task rule can have: the discriminator of `taskGenerationConditionSchema` (pinned equal by a spec). */
export const TASK_TRIGGER_KINDS = [
  "metric_window",
  "competitor_overtake",
  "displacement",
  "aux_finding",
  "source_gap",
  "prompt_stability",
  "pending_analysis",
] as const;

export const taskGenerateJobPayloadSchema = z
  .object({
    // Added by the producer for every tenant-scoped queue.
    workspaceId: z.string().uuid(),
    kid: z.string(),
    projectId: z.string().uuid(),
    /** `YYYY-MM-DD`, workspace-local. Absent means "today in the workspace's zone". */
    metricDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    /**
     * A producer that knows only one kind of change narrows the rules evaluated to that trigger kind. The AUX audit sends
     * `['aux_finding']`; the rollup sends nothing, because a rollup changes the facts every trigger kind reads.
     */
    triggerKinds: z.array(z.enum(TASK_TRIGGER_KINDS)).min(1).optional(),
  })
  .strict();

export type TaskGenerateJobPayload = z.infer<typeof taskGenerateJobPayloadSchema>;
