import { z } from "zod";
import { actionItemKindSchema } from "./action-item-response.schema.js";

// STORY-064 (step C) — POST /v1/projects/{id}/tasks: a MANUAL task.
//
// api-specification.md §3: `task:create`. Title, optional kind and optional
// goal. Nothing here can express an order (`.strict()` makes one a 400), and
// nothing server-derived is accepted: origin is always `manual`, status
// `todo`, the reference is allocated from `ref_counters`, impact is 0.
export const TASK_TITLE_MAX = 200;

export const createTaskRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(TASK_TITLE_MAX),
    /** Defaults to `content` server-side when absent. */
    kind: actionItemKindSchema.optional(),
    goal_id: z.string().uuid().optional(),
  })
  .strict();

export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
