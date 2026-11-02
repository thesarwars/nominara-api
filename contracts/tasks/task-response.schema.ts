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
/**
 * Owner decision 30 / STORY-055 AC6 + AC11 — why a task sits `in_review`. `pending`: the URL is queued or being fetched.
 * `unverified`: the fetch finished and the task STAYS in review with a specific `reason` (the customer may submit another URL).
 * Null on every task that is not `in_review`.
 */
export const TASK_VERIFICATION_REASONS = ["no_mention", "unreachable", "not_a_page", "unsafe_target", "wrong_domain", "no_brand_names", "url_echoes_brand"] as const;
export const taskVerificationReasonSchema = z.enum(TASK_VERIFICATION_REASONS);
export const taskVerificationSchema = z
  .object({
    state: z.enum(["pending", "unverified"]),
    /** The URL the customer submitted. */
    url: z.string(),
    submitted_at: z.string(),
    /** Null while `pending`; the specific reason once `unverified`. */
    reason: taskVerificationReasonSchema.nullable(),
  })
  .strict();
export type TaskVerification = z.infer<typeof taskVerificationSchema>;

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
    /**
     * STORY-055: a SEEDING task (one with a playbook or a source class - the rule `POST /tasks/{id}/complete` applies) is completed with a
     * contribution `url`. Served so the UI shows the URL form before the click instead of learning it from a 400.
     */
    seeding: z.boolean(),
    /** Owner decision 30: why a seeding task is `in_review`. Null on every other task. (Not the STORY-067 `verification` of the complete response.) */
    review: taskVerificationSchema.nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type Task = z.infer<typeof taskSchema>;

export const taskListResponseSchema = z.array(taskSchema);
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;
