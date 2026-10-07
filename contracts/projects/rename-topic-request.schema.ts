import { z } from "zod";

// NEW-B-3 — `PATCH /v1/topics/{id}` (STORY-047: "the rename endpoint records
// that the label source is human"). Recorded as `label_source = 'user'`, the
// value `topic_clusters`' CHECK allows; a recomputation preserves it.
//
// `trim()` before `min(1)`: a label of spaces is empty. The 120 ceiling keeps
// a label a phrase a customer would recognise, not a paragraph.

export const TOPIC_LABEL_MAX = 120;

export const renameTopicRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(TOPIC_LABEL_MAX),
  })
  .strict();

export type RenameTopicRequest = z.infer<typeof renameTopicRequestSchema>;
