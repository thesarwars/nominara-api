import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { measuredImpactSchema, type TaskVerificationOutcome } from "../../../contracts/tasks/task-verification.schema.js";
import { cancelReasonFor } from "../capture/verification-run.js";
import { CROSS_ENGINE_KEY } from "../rollup/roll-up-day.js";
import { validTimezoneSql } from "../rollup/timezone.js";
import { SCORING_VERSION } from "../scoring/index.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { sourceSeededSourceId } from "../sources/verify-presence.js";
import { computeImpact, impactWindowDates, shiftDay, type DayPoint } from "./impact-attribution.js";

// STORY-067 - settling a verification: the step after its capture run, and where the impact is computed and WRITTEN.
//
// The hourly capture sweep finds `running` rows on the OWNER connection (ids only) and settles each in ITS OWN tenant transaction.
// Nothing here makes a network call, so no transaction is held across an external await (ADR-0003).
//
//   short horizon  - settled `captured` once its run is terminal, or `no_capture` when it had nothing to capture.
//   long horizon   - once its run is terminal AND the after-window has closed AND its last day has had its closed-day rollup
//                    (past the workspace-local day after the window's last day, or that day's row computed after 00:20),
//                    the impact is computed from `metric_daily` and written onto the MILESTONE (`milestones.measured_impact`), so the
//                    growth map and the task list read one figure (AC8). A thin sample writes NOTHING (AC7).
//
// A row whose task was reopened/deleted, or whose project was paused/deleted, since it was scheduled is cancelled here instead of
// measured (AC9, AC10), whichever path made the change.

const logger = new Logger("task.verification.settle");
const tracer = trace.getTracer("nominara-api");
const DAY_MS = 86_400_000;
const BATCH_LIMIT = 200;

export class VerificationSweepBlindError extends Error {
  constructor(who: string) {
    super(`verification settling refused: role "${who}" cannot see across tenants (needs the owner connection)`);
    this.name = "VerificationSweepBlindError";
  }
}

export type SettleResult = TaskVerificationOutcome | "canceled" | "waiting" | "skipped";

export interface VerificationSettleSummary {
  readonly settled: number;
  readonly waiting: number;
  readonly failed: number;
}

/** `client` is the sweep's OWNER connection with no transaction open. */
export async function settleVerifications(client: ClientBase, now: Date): Promise<VerificationSettleSummary> {
  const role = await client.query<{ can_see: boolean; who: string }>(
    "SELECT (rolsuper OR rolbypassrls) AS can_see, rolname AS who FROM pg_roles WHERE rolname = current_user",
  );
  if (role.rows[0]?.can_see !== true) throw new VerificationSweepBlindError(role.rows[0]?.who ?? "unknown");
  const candidates = await client.query<{ id: string; workspace_id: string }>(
    "SELECT id, workspace_id FROM task_verifications WHERE status = 'running' ORDER BY created_at, id LIMIT $1",
    [BATCH_LIMIT],
  );
  let settled = 0;
  let waiting = 0;
  let failed = 0;
  for (const candidate of candidates.rows) {
    try {
      const result = await withTenantContext(client, { workspaceId: candidate.workspace_id, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        settleVerification(tx, candidate.id, now),
      );
      if (result === "waiting" || result === "skipped") waiting += 1;
      else settled += 1;
    } catch (error) {
      failed += 1;
      incrementCounter("nominara_tasks_verification_settle_failed_total", {});
      logger.error({ event: "task.verification.settle_failed", workspace_id: candidate.workspace_id, verification_id: candidate.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { settled, waiting, failed };
}

interface SettleRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly milestone_id: string;
  readonly horizon: string;
  readonly due_at: Date;
  readonly run_id: string | null;
  readonly run_status: string | null;
  readonly project_status: string | null;
  readonly project_deleted: boolean;
  readonly task_status: string | null;
  readonly task_deleted: boolean;
  readonly occurred_at: Date;
  readonly completion_day: string;
  readonly today: string;
  readonly tz: string;
}

/** Settles ONE `running` verification inside the caller's tenant transaction. */
export async function settleVerification(tx: ClientBase, verificationId: string, now: Date): Promise<SettleResult> {
  return tracer.startActiveSpan("tasks.verification.settle", async (span) => {
    try {
      const result = await settle(tx, verificationId, now);
      span.setAttribute("nominara.tasks.verification.result", result);
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function settle(tx: ClientBase, verificationId: string, now: Date): Promise<SettleResult> {
  const found = await tx.query<SettleRow>(
    `SELECT v.id, v.project_id, v.task_id, v.milestone_id, v.horizon, v.due_at, v.run_id, r.status AS run_status,
            p.status AS project_status, (p.deleted_at IS NOT NULL) AS project_deleted,
            t.status AS task_status, (t.deleted_at IS NOT NULL) AS task_deleted,
            m.occurred_at,
            to_char((m.occurred_at AT TIME ZONE z.tz)::date, 'YYYY-MM-DD') AS completion_day,
            to_char(($2::timestamptz AT TIME ZONE z.tz)::date, 'YYYY-MM-DD') AS today, z.tz
       FROM task_verifications v
       JOIN milestones m ON m.id = v.milestone_id
       JOIN workspaces w ON w.id = v.workspace_id
       CROSS JOIN LATERAL (SELECT CASE WHEN ${validTimezoneSql("w.timezone")} THEN w.timezone ELSE 'UTC' END AS tz) z
       LEFT JOIN projects p ON p.id = v.project_id
       LEFT JOIN tasks t ON t.id = v.task_id
       LEFT JOIN capture_runs r ON r.id = v.run_id
      WHERE v.id = $1 AND v.status = 'running' AND v.workspace_id = app.current_workspace()
        FOR UPDATE OF v`,
    [verificationId, now],
  );
  const row = found.rows[0];
  if (row === undefined) return "skipped";

  const reason = cancelReasonFor(row);
  if (reason !== null) {
    await tx.query("UPDATE task_verifications SET status = 'canceled', cancel_reason = $2, settled_at = $3 WHERE id = $1", [row.id, reason, now]);
    incrementCounter("nominara_tasks_verifications_cancelled_total", { reason });
    logger.log({ event: "task.verification.canceled", verification_id: row.id, task_id: row.task_id, reason });
    return "canceled";
  }
  // The run is still in flight: wait. (The stuck-run and stale-run reapers finalise one that never ends.)
  if (row.run_status === "queued" || row.run_status === "running") return "waiting";

  const finish = async (outcome: TaskVerificationOutcome): Promise<SettleResult> => {
    await tx.query("UPDATE task_verifications SET status = 'done', outcome = $2, settled_at = $3 WHERE id = $1", [row.id, outcome, now]);
    incrementCounter("nominara_tasks_verifications_settled_total", { horizon: row.horizon, outcome });
    // IDs and the outcome only - never a task title, a prompt or an engine answer.
    logger.log({ event: "task.verification.settled", verification_id: row.id, task_id: row.task_id, project_id: row.project_id, horizon: row.horizon, outcome });
    return outcome;
  };

  if (row.horizon === "short") return finish(row.run_id === null ? "no_capture" : "captured");

  // THE LONG HORIZON. The window length is the interval the row was scheduled with (due_at - completion), so a later change to the
  // configured horizon cannot make a pending row's two windows unequal.
  const windowDays = Math.max(1, Math.round((row.due_at.getTime() - row.occurred_at.getTime()) / DAY_MS));
  const windows = impactWindowDates(row.completion_day, windowDays);
  // The after-window must have CLOSED: today (workspace-local) is past its last day. Until then the mean would be of a partial window.
  if (row.today <= windows.after.to) return "waiting";

  // ONE scoring version across both windows: a day scored under another version is a GAP, not a stand-in, so a cut-over inside the
  // span can never put a formula change into the delta (it would read as insufficient_sample instead). `rolled` says whether the
  // day's row was computed after that day closed (the 00:20 closed-day rollup), not from the intra-day refreshes of the open day.
  const series = await tx.query<{ metric_date: string; visibility_score: string; cells_total: number; rolled: boolean }>(
    `SELECT to_char(metric_date, 'YYYY-MM-DD') AS metric_date, visibility_score::text, cells_total,
            (computed_at >= ((metric_date + 1)::timestamp + interval '20 minutes') AT TIME ZONE $6) AS rolled
       FROM metric_daily
      WHERE workspace_id = app.current_workspace()
        AND project_id = $1 AND engine_key = $2 AND entity_type = 'brand' AND entity_id = $1
        AND metric_date BETWEEN $3::date AND $4::date AND scoring_version = $5
      ORDER BY metric_date`,
    [row.project_id, CROSS_ENGINE_KEY, windows.before.from, windows.after.to, SCORING_VERSION, row.tz],
  );
  // The day after the window's last: until the closed-day rollup has rewritten that last day, its row may be a partial one that
  // would then be frozen into the milestone for good. Past that day, the rollup (or the dirty-date sweep) has had its chance.
  if (row.today <= shiftDay(windows.after.to, 1)) {
    const last = series.rows.find((r) => r.metric_date === windows.after.to);
    if (last === undefined || !last.rolled) return "waiting";
  }
  const points: DayPoint[] = series.rows.map((r) => ({ date: r.metric_date, score: Number(r.visibility_score), cells: r.cells_total }));
  // Other milestones nearby. The task's own milestone is excluded by id, and so is the `source_seeded` one a seeding task pins at the
  // SAME instant (by its deterministic source id, not by timestamp: an unrelated milestone at the same instant still counts).
  const others = await tx.query<{ within_7d: string; in_window: string }>(
    `SELECT count(*) FILTER (WHERE abs(extract(epoch FROM occurred_at - $3::timestamptz)) <= 7 * 86400)::text AS within_7d,
            count(*)::text AS in_window
       FROM milestones
      WHERE workspace_id = app.current_workspace()
        AND project_id = $1 AND id <> $2 AND (source_type = 'system' AND source_id = $5::uuid) IS NOT TRUE
        AND occurred_at BETWEEN $3::timestamptz - make_interval(days => $4) AND $3::timestamptz + make_interval(days => $4)`,
    [row.project_id, row.milestone_id, row.occurred_at, windowDays, sourceSeededSourceId(row.project_id, row.task_id)],
  );
  const result = computeImpact({
    before: points.filter((p) => p.date >= windows.before.from && p.date <= windows.before.to),
    after: points.filter((p) => p.date >= windows.after.from && p.date <= windows.after.to),
    windowDays,
    otherMilestonesWithin7d: Number(others.rows[0]?.within_7d ?? 0),
    otherMilestonesInWindow: Number(others.rows[0]?.in_window ?? 0),
  });

  if (result.status === "insufficient_sample") {
    // AC7 - NO delta, and nothing written onto the milestone. Never a wide interval, never zero.
    return finish("insufficient_sample");
  }
  const impact = measuredImpactSchema.parse(result.impact);
  await tx.query("UPDATE milestones SET measured_impact = $2::jsonb WHERE id = $1 AND workspace_id = app.current_workspace()", [row.milestone_id, JSON.stringify(impact)]);
  return finish("measured");
}
