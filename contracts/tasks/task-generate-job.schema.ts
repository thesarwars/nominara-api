import { z } from "zod";

// STORY-063 / STORY-052 — the payload of a `task.generate` job. Not an HTTP body: it crosses the queue boundary, from its
// two producers (the rollup handler after each day's rollup, and the AUX finding lifecycle after an audit commits) to
// `task-generate.handler.ts`, the one consumer. Strict, so an unknown key fails the job at the boundary instead of being
// silently dropped.
//
// The idempotency key is the producer's (topology: `taskgen:{project}:...`), and generation is itself idempotent
// (task fingerprint), so a redelivered or duplicated job writes nothing twice.

/**
 * The values `task_generation_rules.trigger_kind` can hold: the CHECK of migration 0004 (no later migration amends it), pinned equal to
 * `pg_constraint` by `test/integration/task-generation.spec.ts`. `generate.ts` filters rules with `trigger_kind = ANY($2)`, so this is the
 * vocabulary a producer's `triggerKinds` must use.
 *
 * BORROWED KINDS (owner decision 98c, 2026-11-12; no CHECK change). Some seeded rules carry the existing CHECK member nearest their
 * subject, not a member of their own: `entity_node` (TG-ENTITY-ALIAS, 0150), `schema_missing` (TG-STRUCTURE-TEMPLATE, 0150; it feeds
 * `rendering_quality` through GOAL_METRIC_TRIGGERS), `sentiment_negative` (TG-SENTIMENT-REASON, 0152) and the alignment rule of 0176.
 * They are accepted as they are. A producer narrowing to one of them narrows to the rules that borrow it.
 */
export const TASK_TRIGGER_KINDS = [
  "aux_finding",
  "sov_drop",
  "presence_loss",
  "citation_gap",
  "sentiment_negative",
  "competitor_gain",
  "source_absence",
  "stale_content",
  "schema_missing",
  "displacement",
  "divergence",
  "topic_gap",
  "entity_node",
  "render_downgrade",
  "prompt_unstable",
] as const;

/** The `kind`s of `taskGenerationConditionSchema` (the predicate templates a rule's `condition` can name); a different vocabulary from the column's. */
export const TASK_CONDITION_KINDS = [
  "metric_window",
  "competitor_overtake",
  "displacement",
  "aux_finding",
  "source_gap",
  "prompt_stability",
  "pending_analysis",
  "geo_finding",
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
