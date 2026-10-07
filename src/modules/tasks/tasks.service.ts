import { Injectable, Logger } from "@nestjs/common";
import type { Task, TaskListQuery, TaskSort, UpdateTaskRequest } from "../../../contracts/tasks/index.js";
import { ConflictError, NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { ProjectOutOfScopeException } from "../../tenancy/errors.js";
import { refreshProjectTaskCounts } from "../../lib/rollup/refresh-project-task-counts.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import type { ActionItem, ActionItemEffort, ActionItemPrimaryActionKind, ActionItemSource } from "../../../contracts/tasks/index.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import type { PaginationRequest } from "../../../contracts/common/pagination.schema.js";
import { SOURCE_INDEX_ENGINE_KEY, SOURCE_INDEX_WINDOW_DAYS } from "../../lib/rollup/refresh-project-task-counts.js";

/** schemas/tasks-and-goals.md: a dismissed task re-surfaces after 180 days. */
export const TASK_RESURFACE_DAYS = 180;
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-169 (API step 2/3) — `GET /v1/workspaces/{id}/action-items`. Owns
// `tasks` (coding-standards.md §1 "one table, one owning service") — this
// is why `WorkspacesController` calls IN to this service rather than
// querying `tasks` itself.
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  /**
   * `GET /v1/projects/{id}/tasks` — STORY-064 (step A). api-specification.md
   * §3: "list grouped by status, ordered by `impact_score`". Read-only.
   *
   * THE PROJECT LOOKUP IS THE 404. `projects` is RLS-scoped to the workspace,
   * so another tenant's project is simply absent (never a 403 that confirms
   * it exists), and the same `app.current_scope_projects()` predicate
   * `listActionItems` uses makes an out-of-scope project absent too. (On the
   * HTTP path RbacGuard's `@ProjectParam` refuses an out-of-scope id with the
   * 403 naming the permission first; this is the in-depth layer.)
   *
   * ORDERING IS A READ, NEVER A STORED POSITION. Every sort is expressed as
   * five ASCENDING keys (descending measures are negated) so one row-wise
   * comparison `(k1..k5) > cursor` is a correct keyset predicate for all four
   * sorts, with `id` as the unique last key. See task-list-query.schema.ts.
   *
   * SEVERITY: same derivation as `listActionItems` (aux finding, then source
   * index gap, whitelisted to four values, else null).
   */
  async listProjectTasks(projectId: string, query: TaskListQuery): Promise<Page<Task>> {
    const client = currentTenantStore()!.client;
    const project = await client.query<{ id: string }>(
      `SELECT id FROM projects
        WHERE id = $1 AND deleted_at IS NULL
          AND (cardinality(app.current_scope_projects()) = 0 OR id = ANY(app.current_scope_projects()))`,
      [projectId],
    );
    if (project.rows.length === 0) throw new NotFoundError({ message: "no such project" });

    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, 5);
    const result = await client.query<TaskRow>(
      `WITH items AS (
         SELECT
           t.id, t.short_ref, t.project_id, t.goal_id, t.title, t.description, t.kind, t.origin, t.status,
           CASE WHEN COALESCE(af.severity, psi.gap_severity) IN ('critical', 'high', 'medium', 'low')
                THEN COALESCE(af.severity, psi.gap_severity)
           END AS severity,
           t.source_finding_id, t.source_domain_id, t.source_displacement_id,
           t.rule_code, t.priority, t.impact_score, t.effort_band, t.assignee_id, t.due_at,
           t.dismissed_reason, t.resurface_at, t.completed_at, t.affected_url, t.created_at, t.updated_at,
           ${SORT_KEYS[query.sort]}
         FROM tasks t
         LEFT JOIN goals g ON g.id = t.goal_id
         LEFT JOIN aux_findings af ON af.id = t.source_finding_id
         LEFT JOIN LATERAL (
           SELECT gap_severity
             FROM project_source_index
            WHERE source_domain_id = t.source_domain_id
              AND project_id = t.project_id
              AND engine_key = $2
              AND window_days = $3
            ORDER BY window_start DESC
            LIMIT 1
         ) psi ON t.source_domain_id IS NOT NULL
         WHERE t.project_id = $1
           AND t.deleted_at IS NULL
           AND ($4::text IS NULL OR t.status = $4::text)
       )
       SELECT *, k1::text AS k1_key, k2::text AS k2_key, k3::text AS k3_key, k4::text AS k4_key
         FROM items
        WHERE $5::float8 IS NULL
           OR (k1, k2, k3, k4, id) > ($5::float8, $6::float8, $7::float8, $8::timestamptz, $9::uuid)
        ORDER BY k1, k2, k3, k4, id
        LIMIT $10`,
      [
        projectId,
        SOURCE_INDEX_ENGINE_KEY,
        SOURCE_INDEX_WINDOW_DAYS,
        query.status ?? null,
        after?.[0] ?? null,
        after?.[1] ?? null,
        after?.[2] ?? null,
        after?.[3] ?? null,
        after?.[4] ?? null,
        query.limit + 1,
      ],
    );

    incrementCounter("nominara_tasks_list_total", { sort: query.sort });
    // Workspace/project IDs only — never a task title or description.
    this.logger.log({
      message: "project tasks listed",
      workspace_id: currentTenantStore()!.context.workspaceId,
      project_id: projectId,
      sort: query.sort,
      returned: Math.min(result.rows.length, query.limit),
    });

    return pageFrom(result.rows, query.limit, toTask, (row) => [row.k1_key, row.k2_key, row.k3_key, row.k4_key, row.id]);
  }

  /**
   * `PATCH /v1/tasks/{id}` — STORY-064 (step B). Status, assignee, priority,
   * due date, goal; dismissal with a reason. Nothing here can express an order.
   *
   * ONE TRANSACTION. The caller's ambient context-carrying transaction holds the
   * row lock (`FOR UPDATE`), the UPDATE, every `task_events` INSERT and the
   * open-count refresh, so a timeline entry can never exist without its change
   * (or the reverse), and two concurrent patches serialise on the task row so
   * each event's `from_value` is the value the other left behind.
   *
   * 404 for an absent/other-tenant/soft-deleted task (RLS makes a foreign task
   * absent). An in-tenant task in a project outside a scoped caller's scope is
   * the 403 that names the scope — never a 404.
   *
   * A field patched to its current value is a no-op: no write, no event.
   * `done` is never set here (409): completion captures a baseline and
   * schedules re-measurement, so it has its own endpoint; a `done` task's status
   * is likewise not reopened through PATCH.
   */
  async updateTask(taskId: string, body: UpdateTaskRequest): Promise<Task> {
    const store = currentTenantStore()!;
    const client = store.client;
    const actorId = store.context.actorId;

    if (body.status === "done") {
      throw new ConflictError({ message: "completion is its own endpoint: POST /v1/tasks/{id}/complete" });
    }

    const found = await client.query<CurrentTaskRow>(
      `SELECT t.id, t.project_id, t.status, t.assignee_id, t.priority, t.due_at, t.goal_id, t.dismissed_reason,
              (cardinality(app.current_scope_projects()) = 0 OR t.project_id = ANY(app.current_scope_projects())) AS in_scope
         FROM tasks t
        WHERE t.id = $1 AND t.deleted_at IS NULL
        FOR UPDATE OF t`,
      [taskId],
    );
    const current = found.rows[0];
    if (current === undefined) throw new NotFoundError({ message: "no such task" });
    if (!current.in_scope) throw new ProjectOutOfScopeException();

    if (current.status === "done" && body.status !== undefined) {
      throw new ConflictError({ message: "a completed task is not reopened through PATCH" });
    }

    const sets: string[] = [];
    const params: unknown[] = [taskId];
    const events: TaskEventInput[] = [];
    const set = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (body.status !== undefined) {
      const redismiss = body.status === "dismissed" && current.status === "dismissed" && body.dismiss_reason !== current.dismissed_reason;
      if (body.status !== current.status || redismiss) {
        set("status", body.status);
        if (body.status === "dismissed") {
          set("dismissed_reason", body.dismiss_reason);
          sets.push(`resurface_at = now() + make_interval(days => ${TASK_RESURFACE_DAYS})`);
          events.push({ event: "dismissed", from: current.status, to: "dismissed", payload: { reason: body.dismiss_reason, resurface_days: TASK_RESURFACE_DAYS } });
        } else {
          if (current.status === "dismissed") {
            sets.push("dismissed_reason = NULL", "resurface_at = NULL");
          }
          events.push({ event: current.status === "dismissed" ? "reopened" : "status_changed", from: current.status, to: body.status });
        }
      }
    }

    if (body.assignee_id !== undefined && body.assignee_id !== current.assignee_id) {
      if (body.assignee_id !== null) {
        const member = await client.query(
          `SELECT 1 FROM workspace_members WHERE user_id = $1 AND status = 'active' AND workspace_id = app.current_workspace()`,
          [body.assignee_id],
        );
        if (member.rows.length === 0) {
          throw new ValidationFailedError({ message: "assignee_id must be an active member of this workspace", details: { issues: [{ path: ["assignee_id"], message: "not an active member of this workspace" }] } });
        }
      }
      set("assignee_id", body.assignee_id);
      events.push({ event: "assigned", from: current.assignee_id, to: body.assignee_id });
    }

    if (body.priority !== undefined && body.priority !== current.priority) {
      set("priority", body.priority);
      events.push({ event: "priority_changed", from: String(current.priority), to: String(body.priority) });
    }

    if (body.due_at !== undefined) {
      const next = body.due_at === null ? null : new Date(body.due_at);
      if ((next?.getTime() ?? null) !== (current.due_at?.getTime() ?? null)) {
        set("due_at", next);
        events.push({ event: "due_changed", from: current.due_at?.toISOString() ?? null, to: next?.toISOString() ?? null });
      }
    }

    if (body.goal_id !== undefined && body.goal_id !== current.goal_id) {
      if (body.goal_id !== null) {
        const goal = await client.query(`SELECT 1 FROM goals WHERE id = $1 AND project_id = $2`, [body.goal_id, current.project_id]);
        if (goal.rows.length === 0) {
          throw new ValidationFailedError({ message: "goal_id must be a goal of this task's project", details: { issues: [{ path: ["goal_id"], message: "not a goal of this task's project" }] } });
        }
      }
      set("goal_id", body.goal_id);
      events.push({ event: "goal_linked", from: current.goal_id, to: body.goal_id });
    }

    if (sets.length > 0) {
      await client.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $1`, params);
      for (const e of events) {
        await client.query(
          `INSERT INTO task_events (workspace_id, task_id, actor_id, actor_type, event, from_value, to_value, payload)
           VALUES (app.current_workspace(), $1, $2, 'user', $3, $4, $5, $6::jsonb)`,
          [taskId, actorId, e.event, e.from, e.to, e.payload === undefined ? null : JSON.stringify(e.payload)],
        );
        incrementCounter("nominara_tasks_events_written_total", { event: e.event });
      }
      if (events.some((e) => e.event === "dismissed" || e.event === "reopened" || e.event === "status_changed")) {
        await refreshProjectTaskCounts(client, current.project_id);
      }
    }

    incrementCounter("nominara_tasks_update_total", { changed: events.length > 0 ? "true" : "false" });
    // Workspace/task IDs and the event names only — never a title or a dismissal reason.
    this.logger.log({
      message: "task updated",
      workspace_id: store.context.workspaceId,
      task_id: taskId,
      events: events.map((e) => e.event),
    });

    const row = await client.query<TaskRow>(
      `SELECT t.id, t.short_ref, t.project_id, t.goal_id, t.title, t.description, t.kind, t.origin, t.status,
              CASE WHEN COALESCE(af.severity, psi.gap_severity) IN ('critical', 'high', 'medium', 'low')
                   THEN COALESCE(af.severity, psi.gap_severity) END AS severity,
              t.source_finding_id, t.source_domain_id, t.source_displacement_id,
              t.rule_code, t.priority, t.impact_score, t.effort_band, t.assignee_id, t.due_at,
              t.dismissed_reason, t.resurface_at, t.completed_at, t.affected_url, t.created_at, t.updated_at
         FROM tasks t
         LEFT JOIN aux_findings af ON af.id = t.source_finding_id
         LEFT JOIN LATERAL (
           SELECT gap_severity FROM project_source_index
            WHERE source_domain_id = t.source_domain_id AND project_id = t.project_id
              AND engine_key = $2 AND window_days = $3
            ORDER BY window_start DESC LIMIT 1
         ) psi ON t.source_domain_id IS NOT NULL
        WHERE t.id = $1`,
      [taskId, SOURCE_INDEX_ENGINE_KEY, SOURCE_INDEX_WINDOW_DAYS],
    );
    return toTask(row.rows[0] as TaskRow);
  }

  /**
   * The cross-project action queue. api-specification.md §3:
   * "GET /workspaces/{id}/summary · /action-items — project:read /
   * task:read — Command Center matrix; cross-project queue."
   * product-spec.md `FR-GD-02`: "one prioritized queue merging tasks
   * across every readable project, ranked by impact score then severity
   * then age".
   *
   * TWO THINGS DO THE SCOPING, AND ONLY ONE OF THEM IS RLS — the exact shape
   * `ProjectsService.list` documents at length. RLS's `ws_isolation_tasks`
   * (and `..._projects`) scope by `app.current_workspace()`, which is why
   * there is no `workspace_id` predicate below. The PROJECT scope is not
   * RLS's job for `nominara_app` — only `portal_scope_*` binds
   * `nominara_portal` — so a manager or viewer restricted to fewer than
   * every project (FR-DASH-04, ISO-08) is scoped by THIS query, via
   * `app.current_scope_projects()`, copied verbatim from
   * `ProjectsService.list` so the two can never disagree about who is
   * in scope.
   *
   * FIXED (STORY-169 review): this predicate can only narrow rows that
   * reach it, and until `@ScopedByQuery()` existed, NO scoped manager or
   * viewer ever did. `RbacGuard.assertInScope` refuses a "scoped"
   * permission on any route with no `@ProjectParam()` by default —
   * `WorkspacesController.listActionItems`'s URL names a WORKSPACE, not a
   * project, so it has none, and the guard threw `ProjectOutOfScopeException`
   * for EVERY project-scoped manager/viewer, including one scoped to many
   * projects, not zero. `GET /v1/projects` had the identical gap. Both
   * routes now carry `@ScopedByQuery()`, which lets a NON-EMPTY scope
   * through so this predicate is the thing that actually narrows the rows
   * — and still refuses a scope of zero projects outright, because an empty
   * scope never reaches `set_config` (`tenant-context.ts`) and would
   * otherwise read as "unrestricted" here. `rbac.guard.spec.ts`'s "STORY-169
   * review" scenarios and `test/integration/action-items.spec.ts`'s scope
   * tests cover both routes.
   *
   * ORDERING CONFLICT, RESOLVED TOWARD THE REFERENCE (spec-navigation: a
   * reference beats a story). product-spec.md `FR-GD-02` ranks "impact
   * score then severity then age" — impact first. `STORY-089`'s AC reads
   * "impact within severity", i.e. severity first, and the client's own
   * fixture sorts that way too. `ix_tasks_open (workspace_id, impact_score
   * DESC, priority DESC)` is impact-first, which is the tell that FR-GD-02
   * is the intended behaviour and STORY-089's prose is the one that is
   * wrong. This implements FR-GD-02's order; STORY-089 needs a matching
   * fix, carried to the docs repo by hand (no `.git` in the snapshot here).
   *
   * DEDUP IS DEFERRED. FR-GD-02's second sentence — "deduplicated across
   * projects when the same rule code and affected URL recur, collapsing
   * into one row with a project-count badge" — is NOT implemented here.
   * There is no `task.generate` handler yet (STORY-063/064 are Backlog per
   * the story snapshot), so no two real tasks can currently share a rule
   * code and `affected_url` across projects to prove a dedup query against;
   * building it now would be exercised by nothing. Each task is its own row.
   *
   * SEVERITY has no column on `tasks` (`priority` is a 1-5 ranking, not a
   * severity — schemas/tasks-and-goals.md). The only two derivations the
   * spec names are on `tasks` itself: `aux_findings.severity` via
   * `source_finding_id`, and `project_source_index.gap_severity` via
   * `source_domain_id` — the finding taking precedence, and the SAME
   * "current" reading (`engine_key='all'`, `window_days=30`, most recent
   * `window_start`) `refreshProjectTaskCounts` already uses for
   * `projects.open_tasks_by_severity`, imported from there rather than
   * re-declared so the two constants cannot drift apart. A task deriving
   * neither, or whose only signal is `gap_severity = 'none'` ("no gap",
   * not "no data"), gets a null severity.
   *
   * `severity` IS WHITELISTED, not merely `NULLIF(..., 'none')`.
   * `aux_findings.severity`'s own CHECK allows `'info'` (schemas/aux-and-
   * geo-analysis.md — a real, low-priority finding, not a data gap), which
   * `NULLIF(..., 'none')` would pass straight through onto the wire. The
   * contract's `actionItemSeveritySchema` is `critical|high|medium|low` —
   * four members, not five — so an 'info'-severity finding's task would
   * publish a value the enum does not carry, failing every strict client
   * parse of the whole page. The `CASE WHEN ... IN (...)` below only ever
   * emits one of the four contract members or SQL NULL, matching
   * `refreshProjectTaskCounts`'s own `FILTER (WHERE severity = ...)` counts,
   * which already put `'info'` in no bucket the same way.
   */
  async listActionItems(pagination: PaginationRequest): Promise<Page<ActionItem>> {
    const client = currentTenantStore()!.client;
    const after = pagination.cursor === undefined ? undefined : decodeCursor(pagination.cursor, 4);

    const result = await client.query<ActionItemRow>(
      `WITH items AS (
         SELECT
           t.id,
           t.short_ref,
           t.project_id,
           p.name AS project_name,
           p.slug::text AS project_slug,
           COALESCE(af.rule_code, t.rule_code) AS code,
           t.title,
           CASE WHEN COALESCE(af.severity, psi.gap_severity) IN ('critical', 'high', 'medium', 'low')
                THEN COALESCE(af.severity, psi.gap_severity)
           END AS severity,
           CASE COALESCE(af.severity, psi.gap_severity)
             WHEN 'critical' THEN 0
             WHEN 'high'     THEN 1
             WHEN 'medium'   THEN 2
             WHEN 'low'      THEN 3
             ELSE 4
           END AS severity_rank,
           t.kind,
           t.impact_score,
           t.impact_score::text AS impact_key,
           t.effort_band,
           t.playbook_slug,
           t.source_finding_id,
           t.source_domain_id,
           t.source_displacement_id,
           t.created_at,
           t.created_at::text AS created_at_key
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN aux_findings af ON af.id = t.source_finding_id
         LEFT JOIN LATERAL (
           SELECT gap_severity
             FROM project_source_index
            WHERE source_domain_id = t.source_domain_id
              AND project_id = t.project_id
              AND engine_key = $1
              AND window_days = $2
            ORDER BY window_start DESC
            LIMIT 1
         ) psi ON t.source_domain_id IS NOT NULL
         WHERE t.status IN ('todo', 'in_progress')
           AND t.deleted_at IS NULL
           AND p.deleted_at IS NULL
           AND (cardinality(app.current_scope_projects()) = 0
                OR p.id = ANY(app.current_scope_projects()))
       )
       SELECT *
         FROM items
        WHERE ($3::real IS NULL
               OR impact_score < $3::real
               OR (impact_score = $3::real AND severity_rank > $4::int)
               OR (impact_score = $3::real AND severity_rank = $4::int AND created_at > $5::timestamptz)
               OR (impact_score = $3::real AND severity_rank = $4::int AND created_at = $5::timestamptz AND id > $6::uuid))
        ORDER BY impact_score DESC, severity_rank ASC, created_at ASC, id ASC
        LIMIT $7`,
      [
        SOURCE_INDEX_ENGINE_KEY,
        SOURCE_INDEX_WINDOW_DAYS,
        after?.[0] ?? null,
        after?.[1] ?? null,
        after?.[2] ?? null,
        after?.[3] ?? null,
        pagination.limit + 1,
      ],
    );

    return pageFrom(result.rows, pagination.limit, toActionItem, (row) => [
      row.impact_key,
      row.severity_rank,
      row.created_at_key,
      row.id,
    ]);
  }
}

interface CurrentTaskRow {
  id: string;
  project_id: string;
  status: string;
  assignee_id: string | null;
  priority: number;
  due_at: Date | null;
  goal_id: string | null;
  dismissed_reason: string | null;
  in_scope: boolean;
}

interface TaskEventInput {
  readonly event: "status_changed" | "assigned" | "priority_changed" | "goal_linked" | "reopened" | "dismissed" | "due_changed";
  readonly from: string | null;
  readonly to: string | null;
  readonly payload?: Record<string, unknown>;
}

interface ActionItemRow {
  id: string;
  short_ref: string | null;
  project_id: string;
  project_name: string;
  project_slug: string;
  code: string | null;
  title: string;
  severity: string | null;
  severity_rank: number;
  kind: string;
  impact_score: number | null;
  impact_key: string;
  effort_band: string | null;
  playbook_slug: string | null;
  source_finding_id: string | null;
  source_domain_id: string | null;
  source_displacement_id: string | null;
  created_at: Date;
  created_at_key: string;
}

const VALID_SEVERITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low"]);

/**
 * Second, defensive check on top of the SQL whitelist (the `CASE WHEN ...
 * IN (...)` above) — `aux_findings.severity`'s CHECK constraint allows
 * `'info'`, one value outside the contract's four-member enum. Belt and
 * suspenders: an unchecked `row.severity as ActionItem["severity"]` cast
 * would silently start publishing a fifth value again the moment the SQL
 * and this mapper drift, with no compiler or runtime error either side of
 * the wire — exactly the failure mode this whole finding was.
 */
function normalizeSeverity(raw: string | null): ActionItem["severity"] {
  if (raw === null) return null;
  return VALID_SEVERITIES.has(raw) ? (raw as ActionItem["severity"]) : null;
}

const VALID_EFFORT_BANDS: ReadonlySet<string> = new Set(["xs", "s", "m", "l", "xl"]);

/**
 * `tasks.effort_band` carries no CHECK constraint (schemas/tasks-and-
 * goals.md — see refreshProjectTaskCounts's own note on `tasks` columns
 * with no enforcement). A value that is not exactly one of the five bands,
 * once lowercased, is honestly null rather than guessed at or passed
 * through unlowercased.
 */
function normalizeEffort(raw: string | null): ActionItemEffort | null {
  if (raw === null) return null;
  const lowered = raw.toLowerCase();
  return VALID_EFFORT_BANDS.has(lowered) ? (lowered as ActionItemEffort) : null;
}

/** Which evidence table a task traces back to — `tasks.source_*`, aux > source > displacement > content. */
function deriveSource(row: Pick<ActionItemRow, "source_finding_id" | "source_domain_id" | "source_displacement_id">): ActionItemSource {
  if (row.source_finding_id !== null) return "aux";
  if (row.source_domain_id !== null) return "source";
  if (row.source_displacement_id !== null) return "displacement";
  return "content";
}

/**
 * DOCUMENTED JUDGEMENT CALL — the spec (api-specification.md §3's action-
 * items entry, page-inventory.md's wireframe, FR-GD-02) names the inputs
 * ("source columns / playbook_slug") but not the mapping to the 4-member
 * `primary_action.kind` enum, so this is a design decision, not a spec
 * transcription:
 *
 *   1. `playbook_slug` set           -> `open_playbook`, target the slug.
 *      `source_domains.is_seedable` gates a playbook (sources-and-
 *      rollups.md); source-seeding/authority tasks carry one on `tasks`
 *      directly. Checked FIRST because it is the most concrete next step
 *      available — a guided fix — and a task can carry a playbook alongside
 *      a displacement or a finding id (e.g. an authority task an AUX
 *      finding recommended); the playbook wins when one exists.
 *   2. `source_displacement_id` set  -> `diagnose`, target the displacement.
 *      Matches ui-ux-guidelines.md's own "Diagnose displacement" action and
 *      page-inventory.md's wireframe ("Diagnose →" on a share-of-voice row).
 *      A displacement has no guided fix of its own — diagnosis is the most
 *      concrete action available once there is no playbook to jump to.
 *   3. `source_finding_id` set       -> `copy_patch`, target the finding.
 *      AUX findings carry copy-ready patches (`FR-AX-04`,
 *      `aux_findings.suggested_fix`). This is the one visible mismatch
 *      against page-inventory.md's wireframe, which labels an AUX-R-001
 *      (robots.txt) row "Fix now" — a label this 4-member enum has no exact
 *      match for; `copy_patch` is the nearest of the four.
 *   4. otherwise                     -> `open_task`, target the task itself.
 *      Manual/command_bar-origin tasks, and any task with no more specific
 *      evidence link.
 */
function derivePrimaryAction(row: ActionItemRow): { kind: ActionItemPrimaryActionKind; target: string } {
  if (row.playbook_slug !== null) return { kind: "open_playbook", target: row.playbook_slug };
  if (row.source_displacement_id !== null) return { kind: "diagnose", target: row.source_displacement_id };
  if (row.source_finding_id !== null) return { kind: "copy_patch", target: row.source_finding_id };
  return { kind: "open_task", target: row.id };
}

function toActionItem(row: ActionItemRow): ActionItem {
  return {
    id: row.id,
    short_ref: row.short_ref,
    project_id: row.project_id,
    project_name: row.project_name,
    project_slug: row.project_slug,
    code: row.code,
    title: row.title,
    severity: normalizeSeverity(row.severity),
    source: deriveSource(row),
    kind: row.kind as ActionItem["kind"],
    impact: row.impact_score,
    effort: normalizeEffort(row.effort_band),
    primary_action: derivePrimaryAction(row),
    created_at: row.created_at.toISOString(),
  };
}

/**
 * The five ascending keys per sort (the fifth is `id`, appended by the query).
 * Descending measures are negated so ONE row-wise `>` is the keyset predicate
 * for every sort. Static constants indexed by the validated `TaskSort` enum —
 * no request value is ever interpolated into SQL.
 *
 *   impact   -impact, -priority, 0,            created_at
 *   priority -priority, -impact, 0,            created_at
 *   age      0, 0, 0,                          created_at   (oldest first)
 *   goal     unlinked-flag, goal created epoch, -impact, created_at
 */
const SORT_KEYS: Record<TaskSort, string> = {
  impact: "(-t.impact_score)::float8 AS k1, (-t.priority)::float8 AS k2, 0::float8 AS k3, t.created_at AS k4",
  priority: "(-t.priority)::float8 AS k1, (-t.impact_score)::float8 AS k2, 0::float8 AS k3, t.created_at AS k4",
  age: "0::float8 AS k1, 0::float8 AS k2, 0::float8 AS k3, t.created_at AS k4",
  goal:
    "(CASE WHEN t.goal_id IS NULL THEN 1 ELSE 0 END)::float8 AS k1, " +
    "COALESCE(EXTRACT(EPOCH FROM g.created_at), 0)::float8 AS k2, (-t.impact_score)::float8 AS k3, t.created_at AS k4",
};

interface TaskRow {
  id: string;
  short_ref: string;
  project_id: string;
  goal_id: string | null;
  title: string;
  description: string;
  kind: string;
  origin: string;
  status: string;
  severity: string | null;
  source_finding_id: string | null;
  source_domain_id: string | null;
  source_displacement_id: string | null;
  rule_code: string | null;
  priority: number;
  impact_score: number;
  effort_band: string | null;
  assignee_id: string | null;
  due_at: Date | null;
  dismissed_reason: string | null;
  resurface_at: Date | null;
  completed_at: Date | null;
  affected_url: string | null;
  created_at: Date;
  updated_at: Date;
  k1_key: string;
  k2_key: string;
  k3_key: string;
  k4_key: string;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    short_ref: row.short_ref,
    project_id: row.project_id,
    goal_id: row.goal_id,
    title: row.title,
    description: row.description,
    kind: row.kind as Task["kind"],
    origin: row.origin as Task["origin"],
    status: row.status as Task["status"],
    severity: normalizeSeverity(row.severity),
    source: deriveSource(row),
    rule_code: row.rule_code,
    priority: row.priority,
    impact_score: row.impact_score,
    effort: normalizeEffort(row.effort_band),
    assignee_id: row.assignee_id,
    due_at: row.due_at?.toISOString() ?? null,
    dismissed_reason: row.dismissed_reason,
    resurface_at: row.resurface_at?.toISOString() ?? null,
    completed_at: row.completed_at?.toISOString() ?? null,
    affected_url: row.affected_url,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
