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
// STORY-064 AC10 — the dedup half of FR-GD-02. Tasks sharing a rule code AND an
// affected URL across projects collapse into ONE row: the highest-impact task is
// the row, `project_count` counts the projects it stands for and `projects` names
// them. A task with no code or no URL never collapses (`project_count` 1). Only
// projects the caller can read are counted, so the badge cannot reveal a project
// outside a scoped role's reach.
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
 * See tasks.service.ts `derivePrimaryAction` for the exact derivation
 * precedence, which is a documented judgement call: the spec names the
 * source columns and `playbook_slug` as the derivation's inputs but not the
 * mapping itself. The lead's decision (STORY-169 review): ONE documented
 * meaning of `target` per `kind`, stated here so a client reads it from the
 * contract rather than inferring it from a code comment.
 */
export const actionItemPrimaryActionSchema = z
  .object({
    kind: actionItemPrimaryActionKindSchema,
    /**
     * The meaning is fixed by `kind`, never ambiguous within one kind.
     * `kind` is chosen by precedence — `playbook_slug` is checked BEFORE
     * `source_finding_id`/`source_displacement_id` (see tasks.service.ts
     * `derivePrimaryAction`) — so a task can be AUX-finding-derived
     * (`source` = `"aux"`) and still emit `open_playbook`, when that same
     * task also carries a playbook slug (e.g. an authority task an AUX
     * finding recommended):
     * - `open_playbook`  → `source_domains`-scoped playbook slug. Emitted
     *                      whenever `tasks.playbook_slug` is set, checked
     *                      FIRST — regardless of whether the task also
     *                      carries a finding or displacement id.
     * - `diagnose`       → `displacements.id` (the share-of-voice drop to
     *                      diagnose). Only when no playbook slug is set.
     * - `copy_patch`     → `aux_findings.id` (the finding to fetch the
     *                      copy-ready patch for; never patch text itself).
     *                      Only when no playbook slug or displacement is
     *                      set.
     * - `open_task`      → `tasks.id` itself (no more specific evidence
     *                      link exists).
     */
    target: z.string().min(1).describe(
      "Bare id, meaning fixed by `kind`, checked in this precedence order: playbook_slug set -> " +
        "open_playbook, target the playbook slug (checked FIRST, even for an AUX-finding-derived task " +
        "that also carries a finding or displacement id); else source_displacement_id set -> diagnose, " +
        "target displacements.id; else source_finding_id set -> copy_patch, target aux_findings.id; " +
        "else open_task, target tasks.id. Never a URL or patch text.",
    ),
    /**
     * STORY-089 (Actions AC2) — the playbook route is keyed by DOMAIN
     * (`GET /projects/{id}/sources/{domain}/playbook`), and a slug cannot be
     * resolved to one client-side. So `open_playbook` carries the domain the
     * task's `source_domain_id` names (`source_domains.domain`), and the
     * client opens that playbook. Present on `open_playbook` ONLY — absent on
     * every other kind. `null` when the task carries a playbook slug but no
     * source domain: there is no playbook to open, and the client falls back
     * to the project's Sources section rather than invent a domain.
     */
    domain: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "open_playbook only (absent on every other kind): source_domains.domain of the task's source_domain_id, the key of " +
          "GET /projects/{id}/sources/{domain}/playbook. Null when the task names no source domain.",
      ),
  })
  .strict()
  .refine((a) => a.kind === "open_playbook" || a.domain === undefined, {
    message: "domain is carried by open_playbook only",
    path: ["domain"],
  });

/** One project a collapsed queue row stands for. */
export const actionItemProjectSchema = z
  .object({ id: z.string().uuid(), name: z.string(), slug: z.string() })
  .strict();
export type ActionItemProject = z.infer<typeof actionItemProjectSchema>;

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
    /** >= 1. 1 is an uncollapsed row; more is the number of readable projects sharing this rule code and affected URL. */
    project_count: z.number().int().min(1),
    /** Every readable project the row stands for, the row's own project first, then by name. Length equals `project_count`. */
    projects: z.array(actionItemProjectSchema).min(1),
  })
  .strict();

export type ActionItem = z.infer<typeof actionItemSchema>;

export const actionItemListResponseSchema = z.array(actionItemSchema);
export type ActionItemListResponse = z.infer<typeof actionItemListResponseSchema>;
