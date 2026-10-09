import { z } from "zod";
import { taskPrioritySchema } from "./task-response.schema.js";

// STORY-064 (step B) — PATCH /v1/tasks/{id}.
//
// api-specification.md §3: "status, assignee, priority, due date, goal_id.
// There is no ordering field". Accordingly NO position/rank/order member
// exists here, and `.strict()` makes one a 400 rather than a silent drop.
//
// `status` offers `done` so that the refusal is a typed 409 that tells the
// caller completion is `POST /tasks/{id}/complete` (it captures a baseline and
// schedules re-measurement), instead of a generic enum 400.
//
// Dismissal: `dismiss_reason` is REQUIRED with status=dismissed and refused
// without it. The re-surface date is computed server-side (now + 180 d,
// schemas/tasks-and-goals.md), never client-supplied.
//
// `null` clears assignee_id / due_at / goal_id; an absent key leaves it alone.
export const TASK_DISMISS_REASON_MAX = 1000;

export const updateTaskRequestSchema = z
  .object({
    status: z.enum(["todo", "in_progress", "dismissed", "done"]).optional(),
    assignee_id: z.string().uuid().nullable().optional(),
    priority: taskPrioritySchema.optional(),
    due_at: z.string().datetime({ offset: true }).nullable().optional(),
    goal_id: z.string().uuid().nullable().optional(),
    dismiss_reason: z.string().trim().min(1).max(TASK_DISMISS_REASON_MAX).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: "custom", message: "at least one field is required" });
    }
    if (value.status === "dismissed" && value.dismiss_reason === undefined) {
      ctx.addIssue({ code: "custom", path: ["dismiss_reason"], message: "dismissing a task requires a reason" });
    }
    if (value.dismiss_reason !== undefined && value.status !== "dismissed") {
      ctx.addIssue({ code: "custom", path: ["dismiss_reason"], message: "dismiss_reason is only valid with status=dismissed" });
    }
  });

export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;
