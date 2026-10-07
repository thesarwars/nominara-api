import { z } from "zod";
import { taskStatusSchema } from "./task-list-query.schema.js";
import { actionItemEffortSchema, actionItemKindSchema, actionItemSeveritySchema, actionItemSourceSchema } from "./action-item-response.schema.js";

// STORY-064 (task API, step A) — one task on the wire.
//
// schemas/tasks-and-goals.md `tasks`: four statuses, "No ordering column
// exists anywhere". Accordingly this schema carries NO position, rank, order,
// lane or sort-index member of any kind; `priority` and `impact_score` are
// measured attributes the list is READ by, not places a task has been put.
//
// `severity` has no column on `tasks`; it is derived exactly as
// `TasksService.listActionItems` derives it (aux_findings.severity, then
// project_source_index.gap_severity, else null) — null is "no signal", never
// a fabricated value.
export const taskPrioritySchema = z.number().int().min(1).max(5);

export const taskSchema = z
  .object({
    id: z.string().uuid(),
    short_ref: z.string(),
    project_id: z.string().uuid(),
    goal_id: z.string().uuid().nullable(),
    title: z.string(),
    description: z.string(),
    kind: actionItemKindSchema,
    origin: z.enum(["auto", "manual", "command_bar"]),
    status: taskStatusSchema,
    severity: actionItemSeveritySchema.nullable(),
    source: actionItemSourceSchema,
    rule_code: z.string().nullable(),
    /** 1-5; higher is more important (same direction `ix_tasks_open` orders by). */
    priority: taskPrioritySchema,
    /** 0..100 — THE default sort. */
    impact_score: z.number(),
    effort: actionItemEffortSchema.nullable(),
    assignee_id: z.string().uuid().nullable(),
    due_at: z.string().nullable(),
    dismissed_reason: z.string().nullable(),
    resurface_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    affected_url: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type Task = z.infer<typeof taskSchema>;

export const taskListResponseSchema = z.array(taskSchema);
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;
