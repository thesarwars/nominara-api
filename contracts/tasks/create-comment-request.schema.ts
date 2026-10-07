import { z } from "zod";

// STORY-064 (step C) — POST /v1/tasks/{id}/comments. A comment is an event on
// the one timeline (`task_events.event = 'commented'`), 1..4000 characters.
export const TASK_COMMENT_MAX = 4000;

export const createCommentRequestSchema = z
  .object({
    body: z.string().trim().min(1).max(TASK_COMMENT_MAX),
  })
  .strict();

export type CreateCommentRequest = z.infer<typeof createCommentRequestSchema>;
