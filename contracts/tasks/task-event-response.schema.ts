import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";

// STORY-064 (step C) — GET /v1/tasks/{id}/events: the one timeline, newest
// first, state changes and comments together (schemas/tasks-and-goals.md
// `task_events`). The enum is the table's CHECK list.
export const TASK_EVENT_KINDS = [
  "created",
  "status_changed",
  "assigned",
  "commented",
  "priority_changed",
  "goal_linked",
  "completed",
  "reopened",
  "dismissed",
  "evidence_refreshed",
  "due_changed",
  "verification_submitted",
  "verification_failed",
] as const;
export const taskEventKindSchema = z.enum(TASK_EVENT_KINDS);
export type TaskEventKind = z.infer<typeof taskEventKindSchema>;

export const taskEventActorSchema = z
  .object({
    /** Null for a system actor with no user row, or an erased user. */
    id: z.string().uuid().nullable(),
    /** `users.full_name`; null when unset. An e-mail address is never substituted. */
    display_name: z.string().nullable(),
    type: z.enum(["user", "system"]),
  })
  .strict();

export const taskEventSchema = z
  .object({
    id: z.string().uuid(),
    task_id: z.string().uuid(),
    event: taskEventKindSchema,
    actor: taskEventActorSchema,
    from_value: z.string().nullable(),
    to_value: z.string().nullable(),
    comment_body: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()).nullable(),
    occurred_at: z.string(),
  })
  .strict();
export type TaskEvent = z.infer<typeof taskEventSchema>;

export const taskEventListQuerySchema = paginationRequestSchema;
export type TaskEventListQuery = z.infer<typeof taskEventListQuerySchema>;

export const taskEventListResponseSchema = z.array(taskEventSchema);
