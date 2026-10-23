import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";
import { taskSchema } from "./task-response.schema.js";
import { TASK_DISMISS_REASON_MAX } from "./update-task-request.schema.js";

// STORY-064 AC12 — POST /v1/workspaces/{id}/tasks/bulk: bulk assign, status change and snooze.
//
// api-specification.md carries no bulk route; the planner's recommendation (decisions in the STORY-064 plan) is the
// workspace route, because the cross-project queue is where a batch is chosen. The route is `task:move`, and EVERY id is
// checked against RLS and the caller's project scope: the batch is ALL-OR-NOTHING, so a mixed batch cannot touch an
// out-of-scope task.
//
// Three actions, one discriminator. Each member is `.strict()`, so a field that belongs to another action (a `reason`
// on an assignment) is a 400 rather than a silent drop.
//
// SNOOZE IS A DISMISSAL WITH A CALLER-CHOSEN RE-SURFACE DATE (no new column, no fifth status): the task leaves the open
// count, is audited with a `dismissed` event marked `{snooze: true}`, and re-surfaces through the same sweep as a
// dismissal. The reason and the date are BOTH required; the date is checked against the clock in the service (it must
// be in the future, with no upper bound because none is specified).
//
// `status` offers `todo` and `in_progress` only. `done` is its own endpoint (completion captures a baseline), and a
// bulk dismissal is a snooze, which carries its own date.
export const TASK_BULK_MAX = 100;

const taskIdsSchema = z
  .array(lowercaseUuidSchema)
  .min(1)
  .max(TASK_BULK_MAX)
  .refine((ids) => new Set(ids).size === ids.length, { message: "task_ids must be unique" });

export const bulkTaskRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), task_ids: taskIdsSchema, assignee_id: lowercaseUuidSchema.nullable() }).strict(),
  z.object({ action: z.literal("status"), task_ids: taskIdsSchema, status: z.enum(["todo", "in_progress"]) }).strict(),
  z
    .object({
      action: z.literal("snooze"),
      task_ids: taskIdsSchema,
      reason: z.string().trim().min(1).max(TASK_DISMISS_REASON_MAX),
      snooze_until: z.string().datetime({ offset: true }),
    })
    .strict(),
]);
export type BulkTaskRequest = z.infer<typeof bulkTaskRequestSchema>;

export const bulkTaskResponseSchema = z
  .object({
    /** Tasks whose state changed. A task already in the requested state is unchanged: no write, no event. */
    updated: z.number().int().min(0),
    /** Every requested task, in request order, as it stands after the batch. */
    tasks: z.array(taskSchema),
  })
  .strict();
export type BulkTaskResponse = z.infer<typeof bulkTaskResponseSchema>;
