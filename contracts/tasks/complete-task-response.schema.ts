import { z } from "zod";
import { taskSchema } from "./task-response.schema.js";

// STORY-064 (step D) — POST /v1/tasks/{id}/complete.
//
// Owner decision 30 / STORY-055: a SEEDING task (playbook or source class) is completed WITH a `url` (see
// complete-task-request.schema.ts). It goes `in_review`, not `done`: no milestone exists yet, so `milestone` is null and
// `task.review.state` is `pending`. Every other task completes exactly as before.
//
// Completing a task is a workflow event, not a status flip: it sets the task
// `done`, pins a `task_completed` milestone at that instant, and writes the
// `completed` event. The task's `baseline_metrics` were captured at CREATION
// and are not touched here — the before must predate the work.
//
// `verification` carries the due times of the two re-measurements STORY-067 scheduled in the completing transaction (+48h and +14d by
// default). It is null only while a seeding task is `in_review`: nothing is scheduled until its URL verifies and the milestone is
// pinned. The API never promises a re-measurement it has not scheduled.
export const completeTaskMilestoneSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.literal("task_completed"),
    occurred_at: z.string(),
  })
  .strict();

export const completeTaskVerificationSchema = z
  .object({
    at_48h: z.string(),
    at_14d: z.string(),
  })
  .strict();

export const completeTaskResponseSchema = z
  .object({
    task: taskSchema,
    /** Null while a seeding task is `in_review`: the `task_completed` milestone is pinned when the URL verifies. */
    milestone: completeTaskMilestoneSchema.nullable(),
    verification: completeTaskVerificationSchema.nullable(),
  })
  .strict();

export type CompleteTaskMilestone = z.infer<typeof completeTaskMilestoneSchema>;
export type CompleteTaskResponse = z.infer<typeof completeTaskResponseSchema>;
