import { Injectable, Logger } from "@nestjs/common";
import {
  citationGapSchema,
  conceptGapSchema,
  displacedBySchema,
  type DisplacementDismissalResponse,
  type DisplacementFeedQuery,
  type DisplacementItem,
} from "../../../contracts/analytics/index.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import { ConflictError, NotFoundError } from "../../api/errors/domain-errors.js";
import { DEMO_SEED_MARKER } from "../../db/seed/demo/constants.js";
import { dataSourceOf } from "../../lib/analytics/data-source.js";
import { actionableAuthorityDomains, authorityTargets, authorityTaskFingerprint, linkDisplacementToTask, recoveryTaskCount } from "../../lib/analytics/displacement-recovery.js";
import type { Task } from "../../../contracts/tasks/index.js";
import { acquireAdvisoryXactLock, projectQueueLockKey } from "../../lib/queue/locks.js";
import { TasksService } from "../tasks/tasks.service.js";
import { SOURCE_INDEX_WINDOWS } from "../../lib/rollup/refresh-project-source-index.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { ProjectOutOfScopeException } from "../../tenancy/errors.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// NEW-C-5 — the displacement feed, and dismiss / restore (STORY-092 AC 7, 9, 15; FR-CO-04).
//
// EVERY ROW HAS ITS EVIDENCE. The feed INNER JOINs both captures, so a row whose
// before- or after-capture is not stored is not returned at all: a diagnosis with
// no capture behind it is a guess, and the contract makes it inexpressible.
//
// DISMISS IS A MARK, NOT A DELETE. `dismissed_at` / `dismissed_by` are set and
// cleared; the row, its gaps and its task link are never touched, so a restore
// brings back exactly what was set aside. `acknowledged_at` is a different
// meaning ("seen") and is left alone.
//
// TENANCY. Displacement ids are global uuids. RLS makes another workspace's row
// absent, so the lookup is a 404; a row in this workspace but outside a scoped
// member's project scope is a 403 naming the scope (a denial is never a 404).

const logger = new Logger("displacement");

/** The widest source-index window: the one an authority task is gated on (STORY-054 AC10). */
const AUTHORITY_TASK_WINDOW_DAYS = Math.max(...SOURCE_INDEX_WINDOWS);

interface FeedRow {
  id: string;
  project_id: string;
  prompt_id: string;
  engine_key: string;
  detected_at: Date;
  kind: DisplacementItem["kind"];
  before_result_id: string;
  after_result_id: string;
  before_position: number | null;
  after_position: number | null;
  before_position_class: string | null;
  after_position_class: string | null;
  displaced_by: unknown;
  citation_gap: unknown;
  concept_gap: unknown;
  impact_score: number;
  impact_key: string;
  recovered_at: Date | null;
  dismissed_at: Date | null;
  task_id: string | null;
  demo_captures: number;
  live_captures: number;
}

interface StateRow {
  id: string;
  project_id: string;
  dismissed_at: Date | null;
  citation_gap: unknown;
  task_id: string | null;
  in_scope: boolean;
}

@Injectable()
export class DisplacementService {
  // `tasks` has ONE owning service (coding-standards §1): the recovery plan inserts through it, never into the table.
  constructor(private readonly tasks: TasksService) {}

  async feed(projectId: string, query: DisplacementFeedQuery): Promise<Page<DisplacementItem>> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("DisplacementService requires an active tenant context");
    const { client, context } = store;

    const project = await client.query<{ id: string; in_scope: boolean }>(
      `SELECT id, (cardinality(app.current_scope_projects()) = 0 OR id = ANY(app.current_scope_projects())) AS in_scope
         FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [projectId, context.workspaceId],
    );
    const found = project.rows[0];
    if (found === undefined) throw new NotFoundError({ message: "no such project" });
    if (!found.in_scope) throw new ProjectOutOfScopeException();

    // The cursor key is (impact_score as text, id): a float cannot be a cursor element, and real -> text -> real round-trips exactly.
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, "analytics.displacement", 2);
    const result = await client.query<FeedRow>(
      `SELECT e.id, e.project_id, e.prompt_id, e.engine_key, e.detected_at, e.kind,
              e.before_result_id, e.after_result_id, e.before_position, e.after_position,
              e.before_position_class, e.after_position_class,
              e.displaced_by, e.citation_gap, e.concept_gap,
              e.impact_score, e.impact_score::text AS impact_key,
              e.recovered_at, e.dismissed_at, e.task_id,
              ((b.normalizer_version = $7)::int + (a.normalizer_version = $7)::int) AS demo_captures,
              ((b.normalizer_version <> $7)::int + (a.normalizer_version <> $7)::int) AS live_captures
         FROM displacement_events e
         JOIN answer_captures b ON b.id = e.before_result_id
         JOIN answer_captures a ON a.id = e.after_result_id
        WHERE e.project_id = $1 AND e.workspace_id = $2
          AND ($3::text IS NULL OR e.engine_key = $3)
          AND ($4::text IS NULL OR e.kind = $4)
          AND ($5::boolean OR e.dismissed_at IS NULL)
          AND ($8::real IS NULL OR (e.impact_score, e.id) < ($8::real, $9::uuid))
        ORDER BY e.impact_score DESC, e.id DESC
        LIMIT $6`,
      [
        projectId, context.workspaceId, query.engine ?? null, query.kind ?? null, query.include_dismissed === "true",
        query.limit + 1, DEMO_SEED_MARKER, after?.[0] ?? null, after?.[1] ?? null,
      ],
    );

    // Only the page's rows are read for seedability: one query, keyed by domain.
    const visible = result.rows.slice(0, query.limit);
    const parsed = visible.map((row) => ({
      row,
      takers: displacedBySchema.parse(row.displaced_by),
      citationGap: citationGapSchema.parse(row.citation_gap),
      conceptGap: conceptGapSchema.parse(row.concept_gap),
    }));
    const domains = [...new Set(parsed.flatMap((p) => p.citationGap.map((g) => g.domain.toLowerCase())))];
    const seedable = new Set((await this.actionableDomains(projectId, domains)).keys());
    const byId = new Map(parsed.map((p) => [p.row.id, p]));

    incrementCounter("nominara_displacement_feed_reads_total");
    return pageFrom(
      result.rows,
      query.limit,
      "analytics.displacement",
      (row): DisplacementItem => {
        const p = byId.get(row.id)!;
        return {
          id: row.id,
          project_id: row.project_id,
          prompt_id: row.prompt_id,
          engine_key: row.engine_key,
          detected_at: row.detected_at.toISOString(),
          kind: row.kind,
          before_result_id: row.before_result_id,
          after_result_id: row.after_result_id,
          before_position: row.before_position,
          after_position: row.after_position,
          before_position_class: row.before_position_class,
          after_position_class: row.after_position_class,
          takers: p.takers,
          citation_gap: p.citationGap,
          concept_gap: p.conceptGap,
          impact_score: row.impact_score,
          recovered_at: row.recovered_at?.toISOString() ?? null,
          dismissed_at: row.dismissed_at?.toISOString() ?? null,
          task_id: row.task_id,
          recovery_task_count: recoveryTaskCount(p.citationGap, p.conceptGap, seedable),
          data_source: dataSourceOf(Number(row.live_captures), Number(row.demo_captures)),
        };
      },
      (row) => [row.impact_key, row.id],
    );
  }

  /** Idempotent: an already-dismissed row keeps its first timestamp and actor. */
  async dismiss(displacementId: string): Promise<DisplacementDismissalResponse> {
    const { client, context } = this.store();
    const state = await this.lock(displacementId);
    if (state.dismissed_at !== null) {
      return { id: state.id, dismissed_at: state.dismissed_at.toISOString() };
    }
    const updated = await client.query<{ id: string; dismissed_at: Date }>(
      `UPDATE displacement_events SET dismissed_at = now(), dismissed_by = $3
        WHERE id = $1 AND workspace_id = $2 RETURNING id, dismissed_at`,
      [displacementId, context.workspaceId, context.actorId],
    );
    const row = updated.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such displacement" });
    this.record("dismissed", context.workspaceId, displacementId);
    return { id: row.id, dismissed_at: row.dismissed_at.toISOString() };
  }

  /** Restoring a row that is not dismissed is a 409: the request cannot do what it says. */
  async restore(displacementId: string): Promise<DisplacementDismissalResponse> {
    const { client, context } = this.store();
    const state = await this.lock(displacementId);
    if (state.dismissed_at === null) {
      throw new ConflictError({ message: "this displacement is not dismissed" });
    }
    await client.query(
      `UPDATE displacement_events SET dismissed_at = NULL, dismissed_by = NULL
        WHERE id = $1 AND workspace_id = $2 RETURNING id, dismissed_at`,
      [displacementId, context.workspaceId],
    );
    this.record("restored", context.workspaceId, displacementId);
    return { id: state.id, dismissed_at: null };
  }

  /**
   * NEW-C-6 — `POST /displacements/{id}/recovery-plan` (STORY-057 AC6-AC9). One authority task per SEEDABLE
   * citation gap, through `TasksService.createGeneratedTask`; a non-seedable gap stays on the record and in the
   * feed but makes no task. Concept tasks are zero until STORY-058 stores concepts.
   *
   * IDEMPOTENT. The fingerprint is `sha256('authority:{project_id}:{domain}')`, so a repeat call (or a second
   * displacement on the same domain) finds the open task and returns it: no duplicate, no consumed reference.
   * The displacement row is locked FOR UPDATE first, so concurrent plans for it run one after the other.
   * Everything runs in the request's tenant transaction: a task that fails to insert rolls the whole plan back.
   */
  async recoveryPlan(displacementId: string): Promise<Task[]> {
    const { client, context } = this.store();
    // LOCK ORDER (the worker's, STORY-063): the project's task.generate lock, THEN the fingerprint locks and the displacement row.
    // The generator takes them in that order; taking the displacement row first here would let a recovery plan and a generation
    // job each hold what the other wants (40P01). The project is read unlocked only to name the lock; `lock()` re-reads it.
    const peek = await client.query<{ project_id: string }>("SELECT project_id FROM displacement_events WHERE id = $1 AND workspace_id = $2", [
      displacementId, context.workspaceId,
    ]);
    if (peek.rows[0] !== undefined) await acquireAdvisoryXactLock(client, projectQueueLockKey("task.generate", peek.rows[0].project_id));
    const state = await this.lock(displacementId);
    const gap = citationGapSchema.parse(state.citation_gap);

    const domains = [...new Set(gap.map((g) => g.domain.toLowerCase()))];
    const seedable = await this.actionableDomains(state.project_id, domains);

    const tasks: Task[] = [];
    let created = 0;
    for (const entry of authorityTargets(gap, new Set(seedable.keys()))) {
      const domain = entry.domain.toLowerCase();
      const result = await this.tasks.createGeneratedTask({
        projectId: state.project_id,
        kind: "authority",
        origin: "auto",
        ruleCode: null,
        fingerprint: authorityTaskFingerprint(state.project_id, domain),
        title: `Earn a citation on ${domain}`,
        description: `${entry.held_by.join(", ")} ${entry.held_by.length === 1 ? "is" : "are"} cited at ${entry.url}; your brand is not. Get cited on ${domain}.`,
        sourceDisplacementId: displacementId,
        sourceDomainId: seedable.get(domain) ?? null,
        affectedUrl: entry.url,
      });
      tasks.push(result.task);
      if (result.created) created += 1;
    }

    // The displacement's `task_id` is the plan's first task, set once and never replaced.
    if (tasks.length > 0 && state.task_id === null) {
      await linkDisplacementToTask(client, context.workspaceId, displacementId, tasks[0]!.id);
    }

    incrementCounter("nominara_displacement_recovery_plans_total", { outcome: created > 0 ? "created" : "unchanged" });
    logger.log({
      message: "displacement recovery plan",
      workspace_id: context.workspaceId,
      displacement_id: displacementId,
      tasks_created: created,
      tasks_existing: tasks.length - created,
    });
    return tasks;
  }

  /**
   * STORY-054 AC10 (owner decision 2026-10-13) — the domains an authority task may be made for: SEEDABLE in this
   * workspace AND at a critical or high gap severity on the project's `project_source_index` row at engine 'all',
   * widest (90-day) window. No row, no task. The feed's count and the plan both read THIS set, so they cannot disagree.
   * Returns lower-cased domain to `source_domains.id`.
   */
  private async actionableDomains(projectId: string, domains: readonly string[]): Promise<Map<string, string>> {
    const { client, context } = this.store();
    return actionableAuthorityDomains(client, context.workspaceId, projectId, domains, AUTHORITY_TASK_WINDOW_DAYS);
  }

  private store() {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("DisplacementService requires an active tenant context");
    return store;
  }

  /** Row-lock the displacement so two concurrent changes serialise; absent under RLS = 404, out of scope = 403. */
  private async lock(displacementId: string): Promise<StateRow> {
    const { client, context } = this.store();
    const found = await client.query<StateRow>(
      `SELECT id, project_id, dismissed_at, citation_gap, task_id,
              (cardinality(app.current_scope_projects()) = 0 OR project_id = ANY(app.current_scope_projects())) AS in_scope
         FROM displacement_events WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [displacementId, context.workspaceId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such displacement" });
    if (!row.in_scope) throw new ProjectOutOfScopeException();
    return row;
  }

  private record(action: "dismissed" | "restored", workspaceId: string, displacementId: string): void {
    incrementCounter("nominara_displacement_state_changes_total", { action });
    logger.log({ message: `displacement ${action}`, workspace_id: workspaceId, displacement_id: displacementId });
  }
}
