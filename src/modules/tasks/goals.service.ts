import { Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { CreateGoalRequest, Goal, GoalListQuery, UpdateGoalRequest } from "../../../contracts/tasks/index.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { pageFrom, type Page } from "../../api/pagination/page.js";
import { ConflictError, NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { ProjectOutOfScopeException } from "../../tenancy/errors.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

import { goalDirectionOf, GOAL_MIN_CELLS, isSufficientMeasurement, measureGoal } from "../../lib/rollup/refresh-project-goals.js";

// scoring-models.md "Confidence band": a goal metric under `GOAL_MIN_CELLS` cells (or unmeasured) is `insufficient`.
// Defined beside the refresh that also needs it; re-exported for the callers that already import it from here.
export { GOAL_MIN_CELLS };

interface Measurement {
  value: number | null;
  cells: number | null;
  at: string;
}

interface GoalRow {
  id: string;
  project_id: string;
  title: string;
  kind: Goal["kind"];
  target: Goal["target"];
  baseline: Measurement | null;
  current: Measurement | null;
  progress_pct: string;
  target_date: string | null;
  status: Goal["status"];
  achieved_at: Date | null;
  created_at: Date;
  created_at_key: string;
  tasks_done: string;
  tasks_total: string;
}

// STORY-065 — owns `goals` (schemas/tasks-and-goals.md). Goals are a
// RECORD: nothing here deletes one, and a read never recomputes progress —
// `current`, `progress_pct` and `achieved` change only through the rollup step
// (`lib/rollup/refresh-project-goals.ts`), so two reads with no rollup between
// them are identical (STORY-065 test #12).
@Injectable()
export class GoalsService {
  private readonly logger = new Logger(GoalsService.name);

  /**
   * `GET /v1/projects/{id}/goals`. Read-only; newest first, keyset-paginated on
   * (created_at DESC, id DESC). The cursor carries the FULL-PRECISION
   * (microsecond) created_at, not the published millisecond one: a truncated
   * key would skip rows created within the same millisecond.
   */
  async listGoals(projectId: string, query: GoalListQuery): Promise<Page<Goal>> {
    const client = currentTenantStore()!.client;
    await this.assertProject(client, projectId);
    const after = query.cursor === undefined ? undefined : cursorKeyOf(query.cursor);
    const result = await client.query<GoalRow>(
      `${SELECT_GOALS}
        WHERE g.project_id = $1 AND ($2::timestamptz IS NULL OR (g.created_at, g.id) < ($2::timestamptz, $3::uuid))
        ORDER BY g.created_at DESC, g.id DESC
        LIMIT $4`,
      [projectId, after?.[0] ?? null, after?.[1] ?? null, query.limit + 1],
    );
    return pageFrom(result.rows, query.limit, "tasks.goals", toGoal, (row) => [row.created_at_key, row.id]);
  }

  /**
   * `POST /v1/projects/{id}/goals`. THE BASELINE IS CAPTURED HERE, from the stored measured value (with its cell count) of the
   * kind's own metric, never from the caller — `measureGoal` is the same function the rollup step uses for `current`, so baseline
   * and current are one measurement taken at two times. `current` starts as the same snapshot; only the rollup moves it.
   *
   * `direction` comes from the metric (`GOAL_METRIC_DIRECTION`, all `up`) and is stored in the target jsonb; the request cannot
   * carry it (the contract is strict). A target at or below a sufficiently measured baseline is a 400. A cluster must belong to THIS project (a foreign, other-tenant or unknown cluster is a
   * 400, never a goal on nothing) and an `engine_key` must name a catalogued engine.
   */
  async createGoal(projectId: string, body: CreateGoalRequest): Promise<Goal> {
    const store = currentTenantStore()!;
    const client = store.client;
    await this.assertProject(client, projectId);

    if (body.target.prompt_cluster_id !== undefined) {
      const cluster = await client.query(`SELECT 1 FROM topic_clusters WHERE id = $1 AND project_id = $2`, [body.target.prompt_cluster_id, projectId]);
      if (cluster.rows.length === 0) {
        throw new ValidationFailedError({
          message: "prompt_cluster_id must be a topic cluster of this project",
          details: { issues: [{ path: ["target", "prompt_cluster_id"], message: "not a topic cluster of this project" }] },
        });
      }
    }
    if (body.target.engine_key !== undefined) {
      const engine = await client.query(`SELECT 1 FROM engines WHERE key = $1`, [body.target.engine_key]);
      if (engine.rows.length === 0) {
        throw new ValidationFailedError({
          message: "engine_key must be a known engine",
          details: { issues: [{ path: ["target", "engine_key"], message: "not a known engine" }] },
        });
      }
    }

    const measured = await measureGoal(client, projectId, body);
    const snapshot: Measurement = { value: measured.value, cells: measured.cells, at: new Date().toISOString() };
    // Every goal metric is higher-is-better, so a target at or below a baseline measured on a sufficient sample is already met or
    // behind it: refused, never stored as a goal that regressing would "achieve". An unmeasured or under-sampled baseline cannot
    // say so (null/insufficient is not a number), so the goal is created and judged only once a sufficient sample exists.
    if (isSufficientMeasurement(measured) && body.target.target_value <= (measured.value as number)) {
      throw new ValidationFailedError({
        message: "target_value must be above the current measured value",
        details: { issues: [{ path: ["target", "target_value"], message: "at or below the current measured value" }] },
      });
    }
    const target = { ...body.target, direction: goalDirectionOf(body.target.metric) };

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO goals (workspace_id, project_id, title, kind, target, baseline, current, target_date, created_by)
       VALUES (app.current_workspace(), $1, $2, $3, $4::jsonb, $5::jsonb, $5::jsonb, $6, $7)
       RETURNING id`,
      [projectId, body.title, body.kind, JSON.stringify(target), JSON.stringify(snapshot), body.target_date ?? null, store.context.actorId],
    );
    const goal = await this.readGoal(client, inserted.rows[0]!.id);
    incrementCounter("nominara_goals_created_total", { kind: body.kind, sample_state: goal.sample_state });
    // Workspace/project/goal IDs only — never the title.
    this.logger.log({ message: "goal created", workspace_id: store.context.workspaceId, project_id: projectId, goal_id: goal.id, kind: body.kind });
    return goal;
  }

  /**
   * `PATCH /v1/projects/{id}/goals/{goalId}` — abandon. No reason is asked
   * for; the audit row (route `@Audit`) is the record. An achieved or already
   * abandoned goal is a 409 carrying `current_state`: achieved is a record.
   * The goal is addressed THROUGH its project, so a goal of another project
   * is a 404.
   */
  async updateGoal(projectId: string, goalId: string, _body: UpdateGoalRequest): Promise<Goal> {
    const store = currentTenantStore()!;
    const client = store.client;
    await this.assertProject(client, projectId);
    const locked = await client.query<{ status: Goal["status"] }>(
      `SELECT status FROM goals WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [goalId, projectId],
    );
    const found = locked.rows[0];
    if (found === undefined) throw new NotFoundError({ message: "no such goal" });
    if (found.status !== "active") {
      throw new ConflictError({ message: `a ${found.status} goal cannot be abandoned`, details: { current_state: found.status } });
    }
    await client.query(`UPDATE goals SET status = 'abandoned', updated_at = now() WHERE id = $1`, [goalId]);
    incrementCounter("nominara_goals_abandoned_total");
    this.logger.log({ message: "goal abandoned", workspace_id: store.context.workspaceId, project_id: projectId, goal_id: goalId });
    return this.readGoal(client, goalId);
  }

  private async assertProject(client: ClientBase, projectId: string): Promise<void> {
    const project = await client.query<{ in_scope: boolean }>(
      `SELECT (cardinality(app.current_scope_projects()) = 0 OR id = ANY(app.current_scope_projects())) AS in_scope
         FROM projects WHERE id = $1 AND deleted_at IS NULL`,
      [projectId],
    );
    const found = project.rows[0];
    if (found === undefined) throw new NotFoundError({ message: "no such project" });
    if (!found.in_scope) throw new ProjectOutOfScopeException();
  }

  private async readGoal(client: ClientBase, goalId: string): Promise<Goal> {
    const result = await client.query<GoalRow>(`${SELECT_GOALS} WHERE g.id = $1`, [goalId]);
    return toGoal(result.rows[0]!);
  }
}

const SELECT_GOALS = `
  SELECT g.id, g.project_id, g.title, g.kind, g.target, g.baseline, g.current, g.progress_pct,
         to_char(g.target_date, 'YYYY-MM-DD') AS target_date, g.status, g.achieved_at, g.created_at,
         to_char(g.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_key,
         (SELECT count(*) FROM tasks t WHERE t.goal_id = g.id AND t.deleted_at IS NULL AND t.status = 'done') AS tasks_done,
         (SELECT count(*) FROM tasks t WHERE t.goal_id = g.id AND t.deleted_at IS NULL) AS tasks_total
    FROM goals g`;

function toGoal(row: GoalRow): Goal {
  const measured = row.current;
  const sufficient = measured !== null && measured.value !== null && measured.cells !== null && measured.cells >= GOAL_MIN_CELLS;
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    kind: row.kind,
    target: row.target,
    baseline: row.baseline,
    current: row.current,
    // null, never 0, when the sample cannot support a percentage — or when there was no measured baseline to measure from (an
    // achieved goal is 100 by definition).
    progress_pct: sufficient && (row.baseline?.value != null || row.status === "achieved") ? Number(row.progress_pct) : null,
    sample_state: sufficient ? "sufficient" : "insufficient",
    status: row.status,
    target_date: row.target_date,
    achieved_at: row.achieved_at === null ? null : row.achieved_at.toISOString(),
    tasks_done: Number(row.tasks_done),
    tasks_total: Number(row.tasks_total),
    created_at: row.created_at.toISOString(),
  };
}

const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function cursorKeyOf(cursor: string): [string, string] {
  const [createdAt, id] = decodeCursor(cursor, "tasks.goals", 2);
  if (typeof createdAt !== "string" || !ISO_MICROS.test(createdAt) || typeof id !== "string" || !UUID.test(id)) {
    throw new ValidationFailedError({
      message: "invalid pagination cursor",
      details: { issues: [{ path: ["cursor"], message: "cursor was not issued for this list" }] },
    });
  }
  return [createdAt, id];
}
