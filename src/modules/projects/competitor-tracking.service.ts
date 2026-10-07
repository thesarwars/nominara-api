import { Injectable, Logger } from "@nestjs/common";
import type { TrackCompetitorRequest, TrackCompetitorResponse } from "../../../contracts/projects/index.js";
import { ConflictError, EntitlementExceededError, NotFoundError } from "../../api/errors/domain-errors.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { lockProjectCompetitors } from "./competitor-cap-lock.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { afterCommit, currentTenantStore } from "../../tenancy/tenant-context.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";

// NEW-C-2 — track and untrack a competitor (STORY-092 AC3/5/6, FR-CO-02,
// FR-CO-06).
//
// PROMOTION REWRITES PARSER OUTPUT. Every detected entity is stored from the
// beginning, tracked or not, as `entity_type='other'`. Tracking one re-labels
// those stored rows — in this project only — to `competitor` with the new
// entity id. That is the whole backfill: no capture is made and no credit is
// touched, which is why this file imports neither the credit ledger nor the
// capture planner. The re-tag, the competitor row and the milestone commit
// together or not at all.
//
// REMOVAL REWRITES NOTHING. The competitor is soft-deleted and its facts keep
// the `competitor` tag they earned; a removal is a configuration change, and
// history is not edited to hide one.
//
// BOTH WRITE A MILESTONE, because the share-of-voice denominator moves with
// the tracked set and an unannotated move reads as performance (FR-CO-06).
// `competitor_added` is the only competitor kind the CHECK allows; a removal
// carries it with a title that says so, as the demo seed does.
const COMPETITOR_CAP_KEY = "competitors.max_per_project";

interface BackfillSpan {
  days: number;
  from: string | null;
  to: string | null;
}

@Injectable()
export class CompetitorTrackingService {
  private readonly logger = new Logger(CompetitorTrackingService.name);

  constructor(
    private readonly queues: QueueProducer,
    private readonly entitlements: EntitlementResolver,
  ) {}

  async track(
    workspaceId: string,
    actorId: string,
    projectId: string,
    input: TrackCompetitorRequest,
  ): Promise<TrackCompetitorResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("CompetitorTrackingService requires an active tenant context");
    const tx = store.client;

    // RLS is the guarantee; the workspace predicate is belt and braces.
    const project = await tx.query<{ timezone: string }>(
      `SELECT w.timezone FROM projects p JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.id = $1 AND p.workspace_id = $2 AND p.deleted_at IS NULL`,
      [projectId, workspaceId],
    );
    const timezone = project.rows[0]?.timezone;
    if (timezone === undefined) throw new NotFoundError({ message: "no such project" });

    // Serialise per project BEFORE counting: under READ COMMITTED, concurrent
    // requests would all see the same live count and each pass the cap (and the
    // duplicate-name check). Transaction-scoped, released at COMMIT/ROLLBACK.
    await lockProjectCompetitors(tx, projectId);

    const live = await tx.query<{ name: string }>(
      "SELECT name FROM competitors WHERE project_id = $1 AND workspace_id = $2 AND deleted_at IS NULL",
      [projectId, workspaceId],
    );
    const wanted = input.name.toLowerCase();
    if (live.rows.some((row) => row.name.toLowerCase() === wanted)) {
      throw new ConflictError({ message: "this competitor is already tracked" });
    }

    const resolved = await this.entitlements.resolveForWorkspace(workspaceId);
    const limit = structuralLimitFrom(resolved.entitlements[COMPETITOR_CAP_KEY]?.value as EntitlementValue);
    // An unclassified value fails closed at 0, never open.
    const ceiling = limit === undefined ? 0 : limit.kind === "unlimited" ? Number.POSITIVE_INFINITY : limit.limit;
    if (live.rows.length >= ceiling) {
      throw new EntitlementExceededError({
        message: `this plan allows ${String(ceiling)} tracked competitors per project`,
        details: { key: COMPETITOR_CAP_KEY, limit: ceiling, current: live.rows.length },
      });
    }

    // A competitor removed earlier under this name is revived under its own id
    // so the facts it already carries stay connected to it.
    const revived = await tx.query<{ id: string }>(
      `UPDATE competitors SET deleted_at = NULL, root_domain = $3, aliases = $4
        WHERE id = (SELECT id FROM competitors
                     WHERE project_id = $1 AND workspace_id = $5 AND lower(name) = $2 AND deleted_at IS NOT NULL
                     ORDER BY deleted_at DESC LIMIT 1)
        RETURNING id`,
      [projectId, wanted, input.root_domain ?? null, input.aliases ?? [], workspaceId],
    );
    let entityId = revived.rows[0]?.id;
    if (entityId === undefined) {
      entityId = uuidV7();
      try {
        await tx.query(
          `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source)
           VALUES ($1,$2,$3,$4,$5,$6,'user')`,
          [entityId, workspaceId, projectId, input.name, input.root_domain ?? null, input.aliases ?? []],
        );
      } catch (error) {
        if (isUniqueViolation(error, "ux_competitors_project_name")) {
          throw new ConflictError({ message: "this competitor is already tracked" });
        }
        throw error;
      }
    }

    const names = [wanted, ...(input.aliases ?? []).map((alias) => alias.toLowerCase())];
    const backfill = await tx.query<{ days: number; from_date: string | null; to_date: string | null }>(
      `WITH moved AS (
         UPDATE mention_facts
            SET entity_type = 'competitor', entity_id = $2
          WHERE project_id = $1
            AND workspace_id = $5
            AND entity_type = 'other'
            AND entity_id IS NULL
            AND (lower(entity_label) = ANY($3::text[]) OR lower(matched_alias) = ANY($3::text[]))
        RETURNING captured_at
       )
       SELECT count(DISTINCT (captured_at AT TIME ZONE $4)::date)::int                       AS days,
              to_char(min((captured_at AT TIME ZONE $4)::date), 'YYYY-MM-DD')               AS from_date,
              to_char(max((captured_at AT TIME ZONE $4)::date), 'YYYY-MM-DD')               AS to_date
         FROM moved`,
      [projectId, entityId, names, timezone, workspaceId],
    );
    const span: BackfillSpan = {
      days: backfill.rows[0]!.days,
      from: backfill.rows[0]!.from_date,
      to: backfill.rows[0]!.to_date,
    };

    await this.annotate(
      tx,
      workspaceId,
      projectId,
      actorId,
      `Competitor added: ${input.name}`,
      `Tracked set is now ${String(live.rows.length + 1)}. Share-of-voice moves from this point are a configuration change, not performance.`,
    );

    if (span.from !== null && span.to !== null) {
      this.requestRecompute(workspaceId, projectId, entityId, span.from, span.to);
    }

    incrementCounter("nominara_competitors_tracked_total", { backfilled: span.days > 0 ? "yes" : "no" });
    this.logger.log({
      event: "competitor.tracked",
      workspace_id: workspaceId,
      project_id: projectId,
      entity_id: entityId,
      backfilled_days: span.days,
    });
    return { entity_id: entityId, name: input.name, backfilled_days: span.days, credits_charged: 0 };
  }

  async untrack(workspaceId: string, actorId: string, projectId: string, competitorId: string): Promise<void> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("CompetitorTrackingService requires an active tenant context");
    const tx = store.client;

    const removed = await tx.query<{ name: string }>(
      `UPDATE competitors SET deleted_at = now()
        WHERE id = $1 AND project_id = $2 AND workspace_id = $3 AND deleted_at IS NULL
        RETURNING name`,
      [competitorId, projectId, workspaceId],
    );
    const name = removed.rows[0]?.name;
    if (name === undefined) throw new NotFoundError({ message: "no such competitor" });

    const remaining = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM competitors WHERE project_id = $1 AND workspace_id = $2 AND deleted_at IS NULL",
      [projectId, workspaceId],
    );
    await this.annotate(
      tx,
      workspaceId,
      projectId,
      actorId,
      `Competitor removed: ${name}`,
      `Tracked set is now ${String(remaining.rows[0]!.n)}. Share-of-voice moves from this point are a configuration change, not performance.`,
    );

    incrementCounter("nominara_competitors_untracked_total");
    this.logger.log({ event: "competitor.untracked", workspace_id: workspaceId, project_id: projectId, entity_id: competitorId });
  }

  private async annotate(
    tx: { query: (sql: string, params: unknown[]) => Promise<unknown> },
    workspaceId: string,
    projectId: string,
    actorId: string,
    title: string,
    detail: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO milestones (id, workspace_id, project_id, occurred_at, kind, title, detail, source_type, created_by)
       VALUES ($1,$2,$3,now(),'competitor_added',$4,$5,'user',$6)`,
      [uuidV7(), workspaceId, projectId, title, detail, actorId],
    );
  }

  /**
   * The key carries a nonce: a revive reuses the competitor's id, and the
   * queue's dedup window would otherwise swallow the second recompute while
   * the dates it re-tagged are still stale.
   *
   * After COMMIT: a job enqueued from inside the transaction could run against rows that are not yet visible. */
  private requestRecompute(workspaceId: string, projectId: string, entityId: string, fromDate: string, toDate: string): void {
    afterCommit(() => {
      void this.queues
        .enqueueTenantJob(
          "rollup.metric_daily",
          workspaceId,
          { projectId, fromDate, toDate, reason: "competitor_tracked" },
          { idempotencyKey: `rollup:${projectId}:competitor-tracked:${entityId}:${uuidV7()}` },
        )
        .catch((error: unknown) => {
          this.logger.error(`failed to enqueue recompute for project ${projectId}: ${String(error)}`);
        });
    });
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const pgError = error as { code?: unknown; constraint?: unknown };
  return pgError.code === "23505" && pgError.constraint === constraint;
}
