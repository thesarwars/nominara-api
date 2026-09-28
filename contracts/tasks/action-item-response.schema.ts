import { z } from "zod";

// STORY-169 (API step 2/3) — GET /v1/workspaces/{id}/action-items.
//
// api-specification.md §3: "GET /workspaces/{id}/summary · /action-items —
// project:read / task:read — Command Center matrix; cross-project queue."
// product-spec.md `FR-GD-02`: "Aggregate action items: one prioritized queue
// merging tasks across every readable project, ranked by impact score then
// severity then age, with the project badge and 1-2 direct actions.
// Deduplicated across projects when the same rule code and affected URL
// recur, collapsing into one row with a project-count badge."
//
// The cross-project dedup half of FR-GD-02 is DEFERRED — see
// tasks.service.ts's listActionItems for why. This schema carries no
// project-count field because of that; adding one later is additive.
//
// `tasks` HAS NO SEVERITY COLUMN (schemas/tasks-and-goals.md: `priority` is
// a 1-5 ranking, not a severity). The only two derivations the spec names
// are on `tasks` itself: `aux_findings.severity` via `source_finding_id`,
// and `project_source_index.gap_severity` via `source_domain_id` — the
// finding taking precedence when a task somehow carries both. Exactly the
// rule `refreshProjectTaskCounts` (src/lib/rollup/refresh-project-task-
// counts.ts) already uses for `projects.open_tasks_by_severity`. A task
// deriving neither has a null severity here, same as there — never a
// literal `'none'` (project_source_index.gap_severity's own "no gap" value),
// which is mapped to null before it reaches the wire.

export const actionItemSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type ActionItemSeverity = z.infer<typeof actionItemSeveritySchema>;

/** Which evidence table the task traces back to — `tasks.source_*` columns, in that precedence order. */
export const actionItemSourceSchema = z.enum(["aux", "source", "displacement", "content"]);
export type ActionItemSource = z.infer<typeof actionItemSourceSchema>;

/** `tasks.kind` — content/technical/authority/monitoring (schemas/tasks-and-goals.md), never on-page/off-page. */
export const actionItemKindSchema = z.enum(["content", "technical", "authority", "monitoring"]);
export type ActionItemKind = z.infer<typeof actionItemKindSchema>;

/** `tasks.effort_band`, lowercased. Null when the stored value is not one of these five — the column carries no CHECK constraint. */
export const actionItemEffortSchema = z.enum(["xs", "s", "m", "l", "xl"]);
export type ActionItemEffort = z.infer<typeof actionItemEffortSchema>;

export const actionItemPrimaryActionKindSchema = z.enum(["copy_patch", "diagnose", "open_playbook", "open_task"]);
export type ActionItemPrimaryActionKind = z.infer<typeof actionItemPrimaryActionKindSchema>;

/**
 * `target` is deliberately a bare string, not a URL — its meaning is keyed by
 * `kind` (a task id, a playbook slug, a finding id, a displacement id).
 * See tasks.service.ts `derivePrimaryAction` for the exact mapping, which is
 * a documented judgement call: the spec names the source columns and
 * `playbook_slug` as the derivation's inputs but not the mapping itself.
 */
export const actionItemPrimaryActionSchema = z
  .object({
    kind: actionItemPrimaryActionKindSchema,
    target: z.string().min(1),
  })
  .strict();

export const actionItemSchema = z
  .object({
    id: z.string().uuid(),
    /** `tasks.short_ref` is NOT NULL in the schema; nullable here to stay honest about a producer this story does not add. */
    short_ref: z.string().nullable(),
    project_id: z.string().uuid(),
    project_name: z.string(),
    project_slug: z.string(),
    /** `COALESCE(aux_findings.rule_code, tasks.rule_code)` — null when neither is set (a manual or command_bar task). */
    code: z.string().nullable(),
    title: z.string(),
    severity: actionItemSeveritySchema.nullable(),
    source: actionItemSourceSchema,
    kind: actionItemKindSchema,
    /** `tasks.impact_score`, 0..100. NOT NULL in the schema; nullable here matches every other score on the wire. */
    impact: z.number().nullable(),
    effort: actionItemEffortSchema.nullable(),
    primary_action: actionItemPrimaryActionSchema,
    created_at: z.string(),
  })
  .strict();

export type ActionItem = z.infer<typeof actionItemSchema>;

export const actionItemListResponseSchema = z.array(actionItemSchema);
export type ActionItemListResponse = z.infer<typeof actionItemListResponseSchema>;
