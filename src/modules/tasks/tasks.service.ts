import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { RealtimeEventPayloads } from "../../../contracts/events/catalog.schema.js";
import type {
  CompleteTaskResponse,
  CreateCommentRequest,
  CreateTaskRequest,
  Task,
  TaskEvent,
  TaskEventListQuery,
  TaskListQuery,
  TaskSort,
  UpdateTaskRequest,
} from "../../../contracts/tasks/index.js";
import { ConflictError, NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { ProjectOutOfScopeException } from "../../tenancy/errors.js";
import {
  taskBaselineMetricsSchema,
  taskEvidenceRefreshPayloadSchema,
  taskPlaybookPayloadSchema,
  type TaskBaselineMetrics,
  type TaskPlaybookPayload,
} from "../../../contracts/tasks/index.js";
import { refreshProjectTaskCounts } from "../../lib/rollup/refresh-project-task-counts.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import type { ActionItem, ActionItemEffort, ActionItemPrimaryActionKind, ActionItemSource } from "../../../contracts/tasks/index.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import type { PaginationRequest } from "../../../contracts/common/pagination.schema.js";
import { SOURCE_INDEX_ENGINE_KEY, SOURCE_INDEX_WINDOW_DAYS } from "../../lib/rollup/refresh-project-task-counts.js";

/** NEW-E-099b — each portal task list is capped; the portal shows a client's progress, not the whole backlog. */
export const PORTAL_TASKS_LIMIT = 100;

export interface PortalCompletedRow {
  title: string;
  completed_at: Date | null;
  /** `milestones.measured_impact` — free jsonb, validated by the caller, never trusted. */
  measured_impact: unknown;
}
export interface PortalOpenRow {
  title: string;
  severity: "critical" | "high" | "medium" | "low" | null;
  status: "todo" | "in_progress";
}
export interface PortalTasksRead {
  completed: PortalCompletedRow[];
  open: PortalOpenRow[];
}

/** What `insertTask` writes. `goalId` is only ever set by a manual create. */
interface TaskInsert {
  kind: "content" | "technical" | "authority" | "monitoring";
  origin: "auto" | "manual" | "command_bar";
  ruleCode: string | null;
  fingerprint: Buffer;
  title: string;
  description: string;
  goalId?: string | null;
  sourceDisplacementId: string | null;
  sourceDomainId: string | null;
  affectedUrl: string | null;
  /** STORY-063 — what a rule-generated task records at creation. Absent for a manual task and a recovery-plan task. */
  readonly generation?: TaskGenerationFields;
}

/**
 * STORY-063 — the columns only the generation engine writes. All optional: a column left out takes its table default
 * (impact 0, effort `m`, priority 3, no evidence links), exactly as before this story.
 */
export interface TaskGenerationFields {
  readonly sourceFindingId?: string | null;
  readonly sourceGeoAnalysis?: string | null;
  readonly affectedEngines?: readonly string[];
  readonly affectedPromptIds?: readonly string[];
  readonly playbookSlug?: string | null;
  readonly playbookPayload?: TaskPlaybookPayload | null;
  /** Captured AT CREATION. Never rewritten by a recurrence or by completion. */
  readonly baselineMetrics?: TaskBaselineMetrics | null;
  readonly impactScore?: number;
  readonly effortBand?: "xs" | "s" | "m" | "l" | "xl";
  readonly priority?: number;
  /** The end of the metric day the evidence is from; it seeds `last_evidence_at`. */
  readonly evidenceAt?: Date;
  /** The `created` event is a system event (a worker has no user), with a null actor. */
  readonly systemActor?: boolean;
}

/** STORY-063 — what `createGeneratedTask` did. `created` is true only for `created`. */
export type GeneratedTaskOutcome = "created" | "deduplicated" | "refreshed" | "suppressed";

/** NEW-C-6 — the input of `TasksService.createGeneratedTask`: a generated task is never a goal task and always carries a deterministic fingerprint. */
export interface GeneratedTaskInput extends Omit<TaskInsert, "goalId"> {
  projectId: string;
  /**
   * STORY-063 — a rule's `cooldown_days`. Applies only when no OPEN task has the fingerprint: a task of the same
   * fingerprint created inside the window (in ANY state, deleted included) suppresses a new one. 0 or absent: none.
   */
  readonly cooldownDays?: number;
  /**
   * STORY-063 — set by the generation engine. When an open task already has the fingerprint, evidence that is NEWER than
   * the task's `last_evidence_at` refreshes it, bumps `recurrence_count` and writes an `evidence_refreshed` event; evidence
   * that is not newer (a re-run of the same day) writes nothing. Absent (the recovery plan): an open task is returned untouched.
   */
  readonly refresh?: TaskEvidenceRefresh;
}

/** The evidence a recurrence carries. */
export interface TaskEvidenceRefresh {
  /** End of the evaluated metric day. */
  readonly evidenceAt: Date;
  readonly metricDate: string;
  readonly impactScore: number;
  readonly affectedEngines: readonly string[];
  readonly affectedPromptIds: readonly string[];
  /**
   * A discrete event (a displacement) that is consumed exactly once. Present: the recurrence counts even when the metric day is not
   * newer than the task's evidence (a second loss on the same domain the same day), and the impact never moves down.
   */
  readonly sourceDisplacementId?: string;
  /**
   * Any other discrete event (an AUX regression, a re-verified source gap): counted once even within the evidence's metric day.
   * The caller's own absorption predicate (the recurrence event's wall-clock time) is what stops a second count.
   */
  readonly discreteEvent?: boolean;
}

/** schemas/tasks-and-goals.md: a dismissed task re-surfaces after 180 days. */
export const TASK_RESURFACE_DAYS = 180;
import { afterCommit, currentTenantStore } from "../../tenancy/tenant-context.js";
import { REALTIME_PUBLISHER, type RealtimePublisher } from "../../lib/cache/realtime-publisher.js";

// STORY-169 (API step 2/3) — `GET /v1/workspaces/{id}/action-items`. Owns
// `tasks` (coding-standards.md §1 "one table, one owning service") — this
// is why `WorkspacesController` calls IN to this service rather than
// querying `tasks` itself.
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  // STORY-064 (step D): `task.moved` / `task.created` are published to the
  // workspace room AFTER the transaction commits (`afterCommit`), never from
  // inside it, so a rolled-back change announces nothing.
  constructor(@Inject(REALTIME_PUBLISHER) private readonly realtime: RealtimePublisher) {}

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

    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, "tasks.tasks", 5);
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

    return pageFrom(result.rows, query.limit, "tasks.tasks", toTask, (row) => [row.k1_key, row.k2_key, row.k3_key, row.k4_key, row.id]);
  }

  /**
   * NEW-E-099b — the client portal's task read (STORY-099 s8, s14). TWO bounded statements on the ambient transaction,
   * which on the portal path is the READ ONLY `nominara_portal` one: RLS (`portal_scope_tasks`, `portal_scope_milestones`,
   * ...) scopes the project independently of anything here.
   *
   * Reads `tasks` and the rows it points at (`milestones` for the measured impact, `aux_findings` and
   * `project_source_index` for severity) and NOTHING from the fact tables — asserted by a unit test over the SQL text
   * and by the integration trace. Only the fields the portal shows are selected: no description, assignee, impact
   * score, credit or capture column leaves this method.
   *
   * - completed: status `done`, newest first; the measurement comes from the task's milestone, and a milestone hidden
   *   from the portal (`visible_in_portal = false`) contributes none — filtered here, not in the view.
   * - open: `todo` / `in_progress`, ordered by impact (a READ ordering — no stored position exists); dismissed is not open.
   * - `completedSince` bounds completed work to a token's timeframe lock; null is unbounded.
   * - `hideCompetitors` excludes a task born of a displacement event: it names a competitor by construction.
   */
  async portalTasks(projectId: string, opts: { hideCompetitors: boolean; completedSince: Date | null }): Promise<PortalTasksRead> {
    const client = currentTenantStore()!.client;
    const completed = await client.query<PortalCompletedRow>(
      `SELECT t.title, t.completed_at, m.measured_impact
         FROM tasks t
         LEFT JOIN milestones m ON m.id = t.milestone_id AND m.visible_in_portal = true
        WHERE t.project_id = $1
          AND t.deleted_at IS NULL
          AND t.status = 'done'
          AND ($2::timestamptz IS NULL OR t.completed_at >= $2::timestamptz)
          AND ($3::boolean = false OR t.source_displacement_id IS NULL)
        ORDER BY t.completed_at DESC NULLS LAST, t.id
        LIMIT $4`,
      [projectId, opts.completedSince, opts.hideCompetitors, PORTAL_TASKS_LIMIT],
    );
    const open = await client.query<PortalOpenRow>(
      `SELECT t.title,
              CASE WHEN COALESCE(af.severity, psi.gap_severity) IN ('critical', 'high', 'medium', 'low')
                   THEN COALESCE(af.severity, psi.gap_severity)
              END AS severity,
              t.status
         FROM tasks t
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
          AND t.status IN ('todo', 'in_progress')
          AND ($4::boolean = false OR t.source_displacement_id IS NULL)
        ORDER BY t.impact_score DESC, t.priority DESC, t.created_at, t.id
        LIMIT $5`,
      [projectId, SOURCE_INDEX_ENGINE_KEY, SOURCE_INDEX_WINDOW_DAYS, opts.hideCompetitors, PORTAL_TASKS_LIMIT],
    );
    return { completed: completed.rows, open: open.rows };
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
          `INSERT INTO task_events (workspace_id, task_id, actor_id, actor_type, event, from_value, to_value, payload, occurred_at)
           VALUES (app.current_workspace(), $1, $2, 'user', $3, $4, $5, $6::jsonb, clock_timestamp())`,
          [taskId, actorId, e.event, e.from, e.to, e.payload === undefined ? null : JSON.stringify(e.payload)],
        );
        incrementCounter("nominara_tasks_events_written_total", { event: e.event });
      }
      if (events.some((e) => e.event === "dismissed" || e.event === "reopened" || e.event === "status_changed")) {
        await refreshProjectTaskCounts(client, current.project_id);
      }
      const moved = events.find((e) => e.event === "dismissed" || e.event === "reopened" || e.event === "status_changed");
      if (moved !== undefined && actorId !== undefined) {
        this.publishMoved(store.context.workspaceId, { task_id: taskId, project_id: current.project_id });
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

    return this.readTask(client, taskId);
  }

  private async readTask(client: ClientBase, taskId: string): Promise<Task> {
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
   * `POST /v1/projects/{id}/tasks` — STORY-064 (step C). A MANUAL task.
   *
   * ONE TRANSACTION (the ambient one): the reference allocation, the task row,
   * its `created` event and the open-count refresh commit or roll back together,
   * so a rolled-back create never consumes a reference (gapless).
   *
   * THE REFERENCE. `ref_counters (workspace_id, prefix)` is incremented with
   * `UPDATE ... RETURNING` inside this transaction (schemas/tasks-and-goals.md).
   * The row is first ensured with `INSERT ... ON CONFLICT DO NOTHING` at
   * next_value 1, so there is exactly ONE increment path: two concurrent first
   * creates serialise on the inserted row and then on the UPDATE's row lock,
   * and neither can skip a number. (The demo seeder's insert-at-2-then-update
   * path would skip 1; it is single-threaded and not this code's pattern.)
   *
   * DEFAULTS (the plan's recommendation; the owner may override): the
   * `dedupe_fingerprint` of a manual task is sha256 of a fresh random id, so a
   * manual task NEVER collapses into another (two people may file the same
   * title); `description` is the empty string (the column is NOT NULL) and
   * `kind` defaults to `content`. Impact is 0 — a manual task has no measured
   * impact until a verification run gives it one.
   */
  async createTask(projectId: string, body: CreateTaskRequest): Promise<Task> {
    const store = currentTenantStore()!;
    const client = store.client;

    const project = await client.query<{ id: string; name: string; in_scope: boolean }>(
      `SELECT id, name,
              (cardinality(app.current_scope_projects()) = 0 OR id = ANY(app.current_scope_projects())) AS in_scope
         FROM projects WHERE id = $1 AND deleted_at IS NULL`,
      [projectId],
    );
    const found = project.rows[0];
    if (found === undefined) throw new NotFoundError({ message: "no such project" });
    if (!found.in_scope) throw new ProjectOutOfScopeException();

    if (body.goal_id !== undefined) await this.assertGoalOfProject(client, body.goal_id, projectId);

    return this.insertTask(client, projectId, found.name, {
      kind: body.kind ?? "content",
      origin: "manual",
      ruleCode: null,
      fingerprint: createHash("sha256").update(`manual:${randomUUID()}`).digest(),
      title: body.title,
      description: "",
      goalId: body.goal_id ?? null,
      sourceDisplacementId: null,
      sourceDomainId: null,
      affectedUrl: null,
    });
  }

  /**
   * NEW-C-6 — the SHARED task-insert method for generated (non-manual) tasks. A module that turns its own
   * finding into a task (the displacement recovery plan today, the STORY-063 generator next) calls this; it
   * never writes `INSERT INTO tasks` itself, because `tasks` has one owning service.
   *
   * IDEMPOTENT BY FINGERPRINT. If an open (not done, not deleted) task already has this project + fingerprint
   * - the `ux_tasks_dedupe` partial index - it is returned with `created: false` and NOTHING is written: no
   * row, no reference consumed (references are gapless), no event. A transaction-scoped advisory lock keyed on
   * the fingerprint serialises two concurrent callers, so the loser finds the winner's row rather than
   * burning a reference on an insert that would conflict.
   *
   * Runs in the ambient tenant transaction; a failure after the insert rolls the task back with the caller.
   */
  async createGeneratedTask(input: GeneratedTaskInput): Promise<{ task: Task; created: boolean; outcome: GeneratedTaskOutcome }> {
    const store = currentTenantStore()!;
    const client = store.client;

    const project = await client.query<{ id: string; name: string; in_scope: boolean }>(
      `SELECT id, name,
              (cardinality(app.current_scope_projects()) = 0 OR id = ANY(app.current_scope_projects())) AS in_scope
         FROM projects WHERE id = $1 AND deleted_at IS NULL`,
      [input.projectId],
    );
    const found = project.rows[0];
    if (found === undefined) throw new NotFoundError({ message: "no such project" });
    if (!found.in_scope) throw new ProjectOutOfScopeException();

    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${input.projectId}:${input.fingerprint.toString("hex")}`,
    ]);
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM tasks
        WHERE project_id = $1 AND dedupe_fingerprint = $2 AND status <> 'done' AND deleted_at IS NULL`,
      [input.projectId, input.fingerprint],
    );
    if (existing.rows[0] !== undefined) {
      incrementCounter("nominara_tasks_generated_deduplicated_total", { origin: input.origin });
      const refreshed = input.refresh === undefined ? false : await this.refreshEvidence(client, existing.rows[0].id, input.refresh);
      return { task: await this.readTask(client, existing.rows[0].id), created: false, outcome: refreshed ? "refreshed" : "deduplicated" };
    }
    if (input.cooldownDays !== undefined && input.cooldownDays > 0) {
      const recent = await client.query<{ id: string }>(
        `SELECT id FROM tasks
          WHERE project_id = $1 AND dedupe_fingerprint = $2 AND created_at > now() - make_interval(days => $3::int)
          ORDER BY created_at DESC LIMIT 1`,
        [input.projectId, input.fingerprint, input.cooldownDays],
      );
      if (recent.rows[0] !== undefined) {
        return { task: await this.readTask(client, recent.rows[0].id), created: false, outcome: "suppressed" };
      }
    }
    const task = await this.insertTask(client, input.projectId, found.name, input);
    return { task, created: true, outcome: "created" };
  }

  /**
   * STORY-063 AC6 — a recurrence on an OPEN (todo / in progress) task. The conditional UPDATE is the idempotency: it only
   * matches when the evidence is newer than what the task already holds, so the same rollup re-run any number of times
   * (and an out-of-order older date) changes nothing. A dismissed task is left exactly as dismissed. `baseline_metrics` is
   * never touched: the before must predate the work.
   */
  private async refreshEvidence(client: ClientBase, taskId: string, refresh: TaskEvidenceRefresh): Promise<boolean> {
    const everyEvent = refresh.sourceDisplacementId !== undefined || refresh.discreteEvent === true;
    const updated = await client.query<{ recurrence_count: number }>(
      `UPDATE tasks
          SET recurrence_count = recurrence_count + 1,
              last_evidence_at = GREATEST(COALESCE(last_evidence_at, $2), $2),
              impact_score = CASE WHEN $6::boolean THEN GREATEST(impact_score, $3::real) ELSE $3::real END,
              affected_engines = CASE WHEN $6::boolean THEN ARRAY(SELECT DISTINCT e FROM unnest(affected_engines || $4::text[]) AS e ORDER BY e) ELSE $4::text[] END,
              affected_prompt_ids = CASE WHEN $6::boolean THEN ARRAY(SELECT DISTINCT p FROM unnest(affected_prompt_ids || $5::uuid[]) AS p ORDER BY p) ELSE $5::uuid[] END
        WHERE id = $1 AND status IN ('todo', 'in_progress')
          AND ($6::boolean OR last_evidence_at IS NULL OR last_evidence_at < $2)
        RETURNING recurrence_count`,
      [taskId, refresh.evidenceAt, refresh.impactScore, [...refresh.affectedEngines], [...refresh.affectedPromptIds], everyEvent],
    );
    const row = updated.rows[0];
    if (row === undefined) return false;
    const payload = taskEvidenceRefreshPayloadSchema.parse({
      metric_date: refresh.metricDate,
      recurrence_count: row.recurrence_count,
      impact_score: refresh.impactScore,
      affected_engines: [...refresh.affectedEngines],
      ...(refresh.sourceDisplacementId === undefined ? {} : { source_displacement_id: refresh.sourceDisplacementId }),
    });
    await client.query(
      `INSERT INTO task_events (workspace_id, task_id, actor_id, actor_type, event, payload, occurred_at)
       VALUES (app.current_workspace(), $1, NULL, 'system', 'evidence_refreshed', $2::jsonb, clock_timestamp())`,
      [taskId, JSON.stringify(payload)],
    );
    incrementCounter("nominara_tasks_events_written_total", { event: "evidence_refreshed" });
    incrementCounter("nominara_tasks_recurrence_total", {});
    return true;
  }

  /** The one `INSERT INTO tasks` for new tasks: reference, row, `created` event, open counts, metric, log, realtime. */
  private async insertTask(client: ClientBase, projectId: string, projectName: string, input: TaskInsert): Promise<Task> {
    const store = currentTenantStore()!;
    const shortRef = await nextShortRef(client, store.context.workspaceId, shortRefPrefix(projectName));
    const g = input.generation;
    // Optional generation fields fall back to the table defaults (COALESCE of a NULL parameter), so a manual task and a
    // recovery-plan task are written exactly as before.
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, origin, rule_code, dedupe_fingerprint, title, description,
                          goal_id, source_displacement_id, source_domain_id, affected_url,
                          source_finding_id, source_geo_analysis, affected_engines, affected_prompt_ids, playbook_slug, playbook_payload,
                          baseline_metrics, impact_score, effort_band, priority, last_evidence_at)
       VALUES (app.current_workspace(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, COALESCE($15::text[], '{}'::text[]), COALESCE($16::uuid[], '{}'::uuid[]), $17, $18::jsonb,
               $19::jsonb, COALESCE($20::real, 0), COALESCE($21::text, 'm'), COALESCE($22::smallint, 3), $23)
       RETURNING id`,
      [
        projectId, shortRef, input.kind, input.origin, input.ruleCode, input.fingerprint, input.title, input.description,
        input.goalId ?? null, input.sourceDisplacementId, input.sourceDomainId, input.affectedUrl,
        g?.sourceFindingId ?? null, g?.sourceGeoAnalysis ?? null,
        g?.affectedEngines === undefined ? null : [...g.affectedEngines],
        g?.affectedPromptIds === undefined ? null : [...g.affectedPromptIds],
        g?.playbookSlug ?? null,
        // The owning service validates the jsonb it writes; a caller's type is not the guarantee.
        g?.playbookPayload === undefined || g.playbookPayload === null ? null : JSON.stringify(taskPlaybookPayloadSchema.parse(g.playbookPayload)),
        g?.baselineMetrics === undefined || g.baselineMetrics === null ? null : JSON.stringify(taskBaselineMetricsSchema.parse(g.baselineMetrics)),
        g?.impactScore ?? null, g?.effortBand ?? null, g?.priority ?? null, g?.evidenceAt ?? null,
      ],
    );
    const taskId = inserted.rows[0]!.id;
    const systemActor = g?.systemActor === true;
    await client.query(
      `INSERT INTO task_events (workspace_id, task_id, actor_id, actor_type, event, to_value, occurred_at)
       VALUES (app.current_workspace(), $1, $2, $3, 'created', 'todo', clock_timestamp())`,
      [taskId, systemActor ? null : store.context.actorId, systemActor ? "system" : "user"],
    );
    await refreshProjectTaskCounts(client, projectId);

    incrementCounter("nominara_tasks_created_total", { origin: input.origin });
    incrementCounter("nominara_tasks_events_written_total", { event: "created" });
    // Workspace/task/project IDs only — never the title.
    this.logger.log({ message: "task created", workspace_id: store.context.workspaceId, task_id: taskId, project_id: projectId });
    const created = await this.readTask(client, taskId);
    const workspaceId = store.context.workspaceId;
    afterCommit(() => {
      // IDs only: the workspace room includes members scoped away from this
      // project, so no title or other task content may ride the event.
      this.realtime.toWorkspace(workspaceId, "task.created", { task_id: created.id, project_id: created.project_id });
    });
    return created;
  }

  private publishMoved(workspaceId: string, payload: RealtimeEventPayloads["task.moved"]): void {
    afterCommit(() => {
      this.realtime.toWorkspace(workspaceId, "task.moved", payload);
    });
  }

  /**
   * `POST /v1/tasks/{id}/complete` — STORY-064 (step D). Completion is a
   * workflow event, not a status flip (schemas/tasks-and-goals.md).
   *
   * ONE TRANSACTION (the ambient one): the row lock, the `done` write
   * (`completed_at`/`completed_by`), the `task_completed` milestone, the
   * `completed` event and the open-count refresh commit or roll back together.
   * The row is locked `FOR UPDATE`, so two concurrent completions serialise and
   * the loser sees `done` and gets the 409 — one milestone, never two.
   *
   * `baseline_metrics` is NOT written: it was captured at CREATION (the before
   * must predate the work). Nothing here re-measures — `verification` is null
   * until STORY-067's scheduler exists, rather than a promise this code
   * cannot keep.
   *
   * A `done` or `dismissed` task is a 409 carrying `current_state`.
   */
  async completeTask(taskId: string): Promise<CompleteTaskResponse> {
    const store = currentTenantStore()!;
    const client = store.client;
    const actorId = store.context.actorId;

    const found = await client.query<{ project_id: string; status: string; title: string; in_scope: boolean }>(
      `SELECT t.project_id, t.status, t.title,
              (cardinality(app.current_scope_projects()) = 0 OR t.project_id = ANY(app.current_scope_projects())) AS in_scope
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
        WHERE t.id = $1 AND t.deleted_at IS NULL AND p.deleted_at IS NULL
        FOR UPDATE OF t`,
      [taskId],
    );
    const current = found.rows[0];
    if (current === undefined) throw new NotFoundError({ message: "no such task" });
    if (!current.in_scope) throw new ProjectOutOfScopeException();
    if (current.status !== "todo" && current.status !== "in_progress") {
      throw new ConflictError({ message: `a ${current.status} task cannot be completed`, details: { current_state: current.status } });
    }

    const milestone = await client.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, severity, source_type, source_id, created_by)
       VALUES (app.current_workspace(), $1, clock_timestamp(), 'task_completed', $2, 'positive', 'task', $3, $4)
       RETURNING id, occurred_at`,
      [current.project_id, current.title, taskId, actorId],
    );
    const pinned = milestone.rows[0]!;
    await client.query(
      `UPDATE tasks SET status = 'done', completed_at = $2, completed_by = $3, milestone_id = $4 WHERE id = $1`,
      [taskId, pinned.occurred_at, actorId, pinned.id],
    );
    await client.query(
      `INSERT INTO task_events (workspace_id, task_id, actor_id, actor_type, event, from_value, to_value, occurred_at)
       VALUES (app.current_workspace(), $1, $2, 'user', 'completed', $3, 'done', clock_timestamp())`,
      [taskId, actorId, current.status],
    );
    await refreshProjectTaskCounts(client, current.project_id);

    incrementCounter("nominara_tasks_events_written_total", { event: "completed" });
    incrementCounter("nominara_tasks_completed_total", {});
    // IDs only — never the title.
    this.logger.log({ message: "task completed", workspace_id: store.context.workspaceId, task_id: taskId, project_id: current.project_id, milestone_id: pinned.id });
    this.publishMoved(store.context.workspaceId, { task_id: taskId, project_id: current.project_id });

    return {
      task: await this.readTask(client, taskId),
      milestone: { id: pinned.id, kind: "task_completed", occurred_at: pinned.occurred_at.toISOString() },
      verification: null,
    };
  }

  /**
   * `POST /v1/tasks/{id}/comments` — a comment is an event, so one timeline
   * carries both history and conversation. 404 for a foreign-tenant task
   * (absent under RLS), the scope 403 for an out-of-scope one.
   */
  async createComment(taskId: string, body: CreateCommentRequest): Promise<TaskEvent> {
    const store = currentTenantStore()!;
    const client = store.client;
    await this.assertTaskReadable(client, taskId);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO task_events (workspace_id, task_id, actor_id, actor_type, event, comment_body, occurred_at)
       VALUES (app.current_workspace(), $1, $2, 'user', 'commented', $3, clock_timestamp())
       RETURNING id`,
      [taskId, store.context.actorId, body.body],
    );
    incrementCounter("nominara_tasks_events_written_total", { event: "commented" });
    // IDs only — the comment text is the customer's record and never reaches a log line.
    this.logger.log({ message: "task comment added", workspace_id: store.context.workspaceId, task_id: taskId });

    const row = await client.query<TaskEventRow>(`${TASK_EVENT_SELECT} WHERE e.id = $1`, [inserted.rows[0]!.id]);
    return toTaskEvent(row.rows[0] as TaskEventRow);
  }

  /** `GET /v1/tasks/{id}/events` — the timeline, newest first, keyset-paginated on (occurred_at, id). */
  async listTaskEvents(taskId: string, query: TaskEventListQuery): Promise<Page<TaskEvent>> {
    const client = currentTenantStore()!.client;
    await this.assertTaskReadable(client, taskId);

    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, "tasks.task_events", 2);
    const result = await client.query<TaskEventRow>(
      `${TASK_EVENT_SELECT}
        WHERE e.task_id = $1
          AND ($2::timestamptz IS NULL OR (e.occurred_at, e.id) < ($2::timestamptz, $3::uuid))
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT $4`,
      [taskId, after?.[0] ?? null, after?.[1] ?? null, query.limit + 1],
    );
    incrementCounter("nominara_tasks_events_list_total", {});
    return pageFrom(result.rows, query.limit, "tasks.task_events", toTaskEvent, (row) => [row.occurred_key, row.id]);
  }

  /** 404 for an absent/other-tenant/soft-deleted task or a task of a soft-deleted project; the scope 403 for an in-tenant task outside the caller's scope. */
  private async assertTaskReadable(client: ClientBase, taskId: string): Promise<void> {
    const found = await client.query<{ in_scope: boolean }>(
      `SELECT (cardinality(app.current_scope_projects()) = 0 OR t.project_id = ANY(app.current_scope_projects())) AS in_scope
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
        WHERE t.id = $1 AND t.deleted_at IS NULL AND p.deleted_at IS NULL`,
      [taskId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such task" });
    if (!row.in_scope) throw new ProjectOutOfScopeException();
  }

  private async assertGoalOfProject(client: ClientBase, goalId: string, projectId: string): Promise<void> {
    const goal = await client.query(`SELECT 1 FROM goals WHERE id = $1 AND project_id = $2`, [goalId, projectId]);
    if (goal.rows.length === 0) {
      throw new ValidationFailedError({ message: "goal_id must be a goal of this task's project", details: { issues: [{ path: ["goal_id"], message: "not a goal of this task's project" }] } });
    }
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
   * The `task.generate` handler exists now (STORY-063), but its catalog is
   * per-project work and nothing yet produces two tasks sharing a rule code
   * and `affected_url` across projects to prove a dedup query against;
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
    const after = pagination.cursor === undefined ? undefined : decodeCursor(pagination.cursor, "tasks.action_items", 4);

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

    return pageFrom(result.rows, pagination.limit, "tasks.action_items", toActionItem, (row) => [
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

/** The prefix `ref_counters` tracks for a project — the first 3 letters of its name, uppercased, alpha-only (the demo seeder's derivation). */
export function shortRefPrefix(projectName: string): string {
  const letters = projectName.toUpperCase().replace(/[^A-Z]/gu, "");
  return (letters.slice(0, 3) || "TSK").padEnd(3, "X");
}

/** Gapless: ensure the counter row exists, then increment it with UPDATE ... RETURNING in the caller's transaction. */
async function nextShortRef(client: ClientBase, workspaceId: string, prefix: string): Promise<string> {
  await client.query(
    `INSERT INTO ref_counters (workspace_id, prefix, next_value) VALUES ($1, $2, 1) ON CONFLICT (workspace_id, prefix) DO NOTHING`,
    [workspaceId, prefix],
  );
  const updated = await client.query<{ used: number }>(
    `UPDATE ref_counters SET next_value = next_value + 1 WHERE workspace_id = $1 AND prefix = $2
     RETURNING next_value - 1 AS used`,
    [workspaceId, prefix],
  );
  return `${prefix}-${String(updated.rows[0]!.used)}`;
}

interface TaskEventRow {
  id: string;
  task_id: string;
  event: string;
  actor_id: string | null;
  actor_type: string;
  full_name: string | null;
  from_value: string | null;
  to_value: string | null;
  comment_body: string | null;
  payload: Record<string, unknown> | null;
  occurred_at: Date;
  occurred_key: string;
}

const TASK_EVENT_SELECT = `SELECT e.id, e.task_id, e.event, e.actor_id, e.actor_type, u.full_name, e.from_value, e.to_value,
       e.comment_body, e.payload, e.occurred_at, e.occurred_at::text AS occurred_key
  FROM task_events e
  LEFT JOIN users u ON u.id = e.actor_id`;

function toTaskEvent(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    task_id: row.task_id,
    event: row.event as TaskEvent["event"],
    actor: { id: row.actor_id, display_name: row.full_name, type: row.actor_type === "system" ? "system" : "user" },
    from_value: row.from_value,
    to_value: row.to_value,
    comment_body: row.comment_body,
    payload: row.payload,
    occurred_at: row.occurred_at.toISOString(),
  };
}
