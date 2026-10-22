import { z } from "zod";
import { PAGINATION_LIMIT_DEFAULT, PAGINATION_LIMIT_MAX } from "../common/pagination.schema.js";

// STORY-064 (task API, step A) — GET /v1/projects/{id}/tasks.
//
// product-spec.md FR-AP-03 / page-inventory.md FR-AP-UI-01: "ordered by impact
// score by default, sortable by priority, age, or goal. No manual ordering
// exists." `sort` names a READ ORDERING over measured fields; it is not, and
// must never become, a stored position. There is no field on this query (or on
// the response, or the `tasks` table) that carries one — test #3 asserts it.
//
//   impact   (default)  impact_score DESC, priority DESC, oldest first
//   priority            priority DESC, impact_score DESC, oldest first
//   age                 oldest first (created_at ASC)
//   goal                goal-linked tasks first, grouped by goal; within a goal, tasks that feed the goal's metric first
//                       (contribution, STORY-065), then the rest; impact DESC within each tier
export const TASK_SORTS = ["impact", "priority", "age", "goal"] as const;
export const taskSortSchema = z.enum(TASK_SORTS);
export type TaskSort = z.infer<typeof taskSortSchema>;

export const TASK_STATUSES = ["todo", "in_progress", "done", "dismissed"] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

// Re-declared in full (not `paginationRequestSchema.extend`) only to keep the
// shape explicit; the clamp semantics are the shared ones.
export const taskListQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .overwrite((value) => Math.min(value, PAGINATION_LIMIT_MAX))
      .max(PAGINATION_LIMIT_MAX)
      .default(PAGINATION_LIMIT_DEFAULT),
    sort: taskSortSchema.default("impact"),
    /** Omitted = every status ("list grouped by status" is the client's grouping). */
    status: taskStatusSchema.optional(),
  })
  .strict();

export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
