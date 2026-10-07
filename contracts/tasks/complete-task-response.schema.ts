import { z } from "zod";
import { taskSchema } from "./task-response.schema.js";

// STORY-064 (step D) — POST /v1/tasks/{id}/complete. There is no request body.
//
// Completing a task is a workflow event, not a status flip: it sets the task
// `done`, pins a `task_completed` milestone at that instant, and writes the
// `completed` event. The task's `baseline_metrics` were captured at CREATION
// and are not touched here — the before must predate the work.
//
// `verification` is null until STORY-067 (the verification scheduler) exists.
// The API never promises a +48h / +14d re-measurement it has not scheduled: null
// is "not scheduled", never a fabricated timestamp.
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
    milestone: completeTaskMilestoneSchema,
    verification: completeTaskVerificationSchema.nullable(),
  })
  .strict();

export type CompleteTaskMilestone = z.infer<typeof completeTaskMilestoneSchema>;
export type CompleteTaskResponse = z.infer<typeof completeTaskResponseSchema>;
