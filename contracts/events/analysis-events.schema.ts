import { z } from "zod";

// STORY-026 T19 — api-specification.md §11's AUX, task and displacement
// events. All three of the coalesced ones here are `≤ 5 / s / PROJECT`, which
// is why the coalescing table in event-name.schema.ts is keyed per event: a
// single shared budget would coalesce one project's findings against another's.

const uuid = z.uuid();

export const auxAuditCompletedEventSchema = z
  .object({
    audit_id: uuid,
    project_id: uuid,
    aux_score: z.number().min(0).max(100),
    // Signed, and nullable for the first audit of a project. "No previous
    // audit" and "no change since the last one" are different facts, and a
    // zero would report the first as the second.
    delta: z.number().nullable(),
    findings: z
      .object({
        critical: z.number().int().nonnegative(),
        high: z.number().int().nonnegative(),
        medium: z.number().int().nonnegative(),
        low: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const auxFindingCreatedEventSchema = z
  .object({
    finding_id: uuid,
    project_id: uuid,
    rule_code: z.string().min(1),
    severity: z.enum(["critical", "high", "medium", "low"]),
    url: z.url(),
  })
  .strict();

// IDS ONLY (owner decision 2026-10-08). `task.created` is delivered to the whole
// workspace room, scoped members included, and the gateway has no per-project
// delivery; a title, priority or rule code would reach members who cannot read
// the project. Clients refetch the task through the scoped REST read.
export const taskCreatedEventSchema = z
  .object({
    task_id: uuid,
    project_id: uuid,
  })
  .strict();

/**
 * `task.moved` — one of the four events this repository actually emits today's
 * epics through (`api` in §11's producer column), rather than one awaiting a
 * worker.
 */
export const taskMovedEventSchema = z
  .object({
    task_id: uuid,
    project_id: uuid,
    from_status: z.string().min(1),
    to_status: z.string().min(1),
    actor_id: uuid,
  })
  .strict();

export const displacementDetectedEventSchema = z
  .object({
    event_id: uuid,
    project_id: uuid,
    prompt_id: uuid,
    engine_key: z.string().min(1),
    kind: z.string().min(1),
    impact_score: z.number(),
  })
  .strict();

export type AuxAuditCompletedEvent = z.infer<typeof auxAuditCompletedEventSchema>;
export type AuxFindingCreatedEvent = z.infer<typeof auxFindingCreatedEventSchema>;
export type TaskCreatedEvent = z.infer<typeof taskCreatedEventSchema>;
export type TaskMovedEvent = z.infer<typeof taskMovedEventSchema>;
export type DisplacementDetectedEvent = z.infer<typeof displacementDetectedEventSchema>;
