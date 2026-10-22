import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import type { EnqueueRollup } from "../queue/handlers/run-rollup-request.js";
import { SCORING_VERSION } from "../scoring/index.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { measurementStatusSql } from "./aggregate-day.js";
import { RollupDirtySet, type DirtyEntry } from "./dirty-dates.js";

// STORY-042 AC2 + AC6 — the rollup worker's two sweeps, modelled on SchedulerSweepRuntime (src/lib/capture/scheduler-sweep.ts).
//
// WHY A SWEEP AND NOT A CRON. `rollup.metric_daily` is a TENANT-scoped queue: every job carries a workspace id and an
// HMAC signature that is verified before any tenant context is set, so a bare BullMQ cron (which has no workspace)
// cannot feed it — the registrar refuses that row as inert. The sweep is the producer: it reads project references
// across every workspace on the OWNER connection and enqueues ONE SIGNED job per project and date, each carrying its own
// workspace. It never writes tenant data itself.
//
// ONE TICK EVERY 15 MINUTES (ci-cd-and-environments.md: dirty-date reprocess "every 15 min, backlog depth"), serving both:
//
//   CLOSED-DAY (EC-11): the closed day of a project whose WORKSPACE-LOCAL clock has passed 00:20, that has measured cells
//   on that day and no `metric_daily` row computed after that 00:20. Keyed `rollup:{project}:closed:{date}`. The 20 minutes
//   are settling time for late cells of the day; a row written inside them does not count as the closed-day rollup.
//
//   DIRTY-DATE (EC-12): the entries a late fact left in the `rollup_dirty` set. Keyed per project, date and 15-minute
//   window. An entry is removed only AFTER its job is enqueued, so a crash re-enqueues (idempotent) and never loses a mark.
//
// Several replicas all tick; the keys make that safe. A failed enqueue is counted, logged with ids, and reported as
// `partial` — never silent; the entry (or the still-unrolled day) is simply found again next tick.
//
// NO ROW LOCKS ARE HELD: unlike the capture sweep it claims nothing, so there is no transaction to hold across the queue.

const logger = new Logger("rollup.sweep");
const tracer = trace.getTracer("nominara-api");

const QUARTER_MS = 15 * 60 * 1000;
/** EC-11 / ci-cd-and-environments.md: the daily rollup for a date runs at 00:20 workspace-local. */
export const CLOSED_DAY_GRACE_MINUTES = 20;
/** One tick's bound on closed-day projects; an unrolled backlog drains as jobs complete. */
export const CLOSED_DAY_BATCH_SIZE = 500;
const ENQUEUE_TIMEOUT_MS = 5_000;
/** One whole sweep (connect included). Every wait is bounded so the timer always re-arms. */
const DEFAULT_SWEEP_TIMEOUT_MS = 60_000;

export class RollupSweepBlindError extends Error {
  constructor(who: string) {
    super(
      `the rollup sweep is connected as "${who}", which neither bypasses row-level security nor is a superuser — ` +
        "it would see no projects, roll up no closed day and look healthy",
    );
    this.name = "RollupSweepBlindError";
  }
}

class SweepTimeoutError extends Error {
  constructor(what: string) {
    super(`${what} did not settle within its bound`);
    this.name = "SweepTimeoutError";
  }
}

export interface RollupSweepResult {
  /** `partial` when at least one enqueue failed. Never silent. */
  readonly status: "complete" | "partial";
  readonly found: number;
  readonly enqueued: number;
  readonly failed: number;
}

export function closedDayJobKey(projectId: string, metricDate: string): string {
  return `rollup:${projectId}:closed:${metricDate}`;
}

/** One key per project, date and 15-minute window: replicas ticking the same window ask for the same job. */
export function dirtyDateJobKey(projectId: string, metricDate: string, now: Date): string {
  const window = new Date(Math.floor(now.getTime() / QUARTER_MS) * QUARTER_MS).toISOString();
  return `rollup:${projectId}:dirty:${metricDate}:${window}`;
}

/** The next :00/:15/:30/:45 UTC strictly after `now`. */
export function nextRollupSweepAfter(now: Date): Date {
  return new Date((Math.floor(now.getTime() / QUARTER_MS) + 1) * QUARTER_MS);
}

function withTimeout<T>(fn: () => Promise<T>, ms: number, what = "the enqueue"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SweepTimeoutError(what)), ms);
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

async function assertSweepCanSee(client: ClientBase): Promise<void> {
  const result = await client.query<{ can_see: boolean; who: string }>(
    "SELECT (rolsuper OR rolbypassrls) AS can_see, rolname AS who FROM pg_roles WHERE rolname = current_user",
  );
  const row = result.rows[0];
  if (row?.can_see === true) return;
  incrementCounter("nominara_rollup_sweep_runs_total", { sweep: "closed_day", status: "blind" });
  throw new RollupSweepBlindError(row?.who ?? "unknown");
}

interface ClosedDayTarget {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly metricDate: string;
}

/**
 * The closed days due for a rollup at `now`. Reads ids and a date only — never a name, a prompt or a plan.
 *
 * The facts probe is bounded by a parameterised UTC window ($1 - 3 days .. $1) so the partitioned `answer_captures` is
 * pruned; the precise workspace-local day is then matched per row. A day with no measured cell is never a target (so a
 * quiet project is not re-enqueued every tick), and `measurementStatusSql` is the one definition the rollup itself uses.
 */
async function findClosedDayTargets(client: ClientBase, now: Date): Promise<ClosedDayTarget[]> {
  const result = await client.query<{ workspace_id: string; project_id: string; metric_date: string }>(
    `SELECT p.workspace_id, p.id AS project_id, to_char(t.today - 1, 'YYYY-MM-DD') AS metric_date
       FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
      CROSS JOIN LATERAL (SELECT ($1::timestamptz AT TIME ZONE w.timezone) AS local_now) ln
      CROSS JOIN LATERAL (SELECT ln.local_now::date AS today) t
      WHERE p.deleted_at IS NULL
        AND w.deleted_at IS NULL
        AND ln.local_now >= t.today::timestamp + make_interval(mins => $4::int)
        AND EXISTS (
              SELECT 1 FROM answer_captures c
               WHERE c.project_id = p.id
                 AND c.captured_at >= $1::timestamptz - interval '3 days'
                 AND c.captured_at < $1::timestamptz
                 AND (c.captured_at AT TIME ZONE w.timezone)::date = t.today - 1
                 AND ${measurementStatusSql("c.status")})
        AND NOT EXISTS (
              SELECT 1 FROM metric_daily md
               WHERE md.project_id = p.id
                 AND md.metric_date = t.today - 1
                 AND md.scoring_version = $2
                 AND md.computed_at >= (t.today::timestamp + make_interval(mins => $4::int)) AT TIME ZONE w.timezone)
      ORDER BY p.id
      LIMIT $3`,
    [now, SCORING_VERSION, CLOSED_DAY_BATCH_SIZE, CLOSED_DAY_GRACE_MINUTES],
  );
  return result.rows.map((row) => ({ workspaceId: row.workspace_id, projectId: row.project_id, metricDate: row.metric_date }));
}

async function enqueueAll<T extends { workspaceId: string; projectId: string; metricDate: string }>(
  sweep: "closed_day" | "dirty_date",
  targets: readonly T[],
  enqueue: EnqueueRollup,
  request: (target: T) => { payload: Record<string, unknown>; key: string },
  onEnqueued?: (target: T) => Promise<void>,
): Promise<{ enqueued: number; failed: number }> {
  let enqueued = 0;
  let failed = 0;
  for (const target of targets) {
    const { payload, key } = request(target);
    try {
      await withTimeout(() => enqueue("rollup.metric_daily", target.workspaceId, payload, key), ENQUEUE_TIMEOUT_MS);
      enqueued += 1;
      incrementCounter("nominara_rollup_sweep_jobs_enqueued_total", { sweep });
      // IDs only — never a workspace name or any tenant content.
      logger.log({ event: "rollup.sweep.enqueued", sweep, workspace_id: target.workspaceId, project_id: target.projectId, metric_date: target.metricDate });
      if (onEnqueued !== undefined) await onEnqueued(target);
    } catch (error) {
      failed += 1;
      incrementCounter("nominara_rollup_sweep_enqueue_failures_total", { sweep });
      logger.error({
        event: "rollup.sweep.enqueue_failed",
        sweep,
        workspace_id: target.workspaceId,
        project_id: target.projectId,
        metric_date: target.metricDate,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return { enqueued, failed };
}

function finish(sweep: "closed_day" | "dirty_date", found: number, enqueued: number, failed: number): RollupSweepResult {
  const status = failed === 0 ? "complete" : "partial";
  incrementCounter("nominara_rollup_sweep_runs_total", { sweep, status });
  // `found` is the backlog depth (ci-cd-and-environments.md: dirty-date reprocess "every 15 min, backlog depth").
  logger.log({ event: `rollup.sweep.${sweep}`, status, found, enqueued, failed });
  return { status, found, enqueued, failed };
}

/** AC2 — one tick of the closed-day sweep. `client` must be an owner-role connection (it is refused if it cannot see across tenants). */
export async function runClosedDaySweep(client: ClientBase, enqueue: EnqueueRollup, now: Date): Promise<RollupSweepResult> {
  await assertSweepCanSee(client);
  const targets = await findClosedDayTargets(client, now);
  const { enqueued, failed } = await enqueueAll("closed_day", targets, enqueue, (t) => ({
    payload: { projectId: t.projectId, metricDate: t.metricDate, reason: "closed_day" },
    key: closedDayJobKey(t.projectId, t.metricDate),
  }));
  return finish("closed_day", targets.length, enqueued, failed);
}

/** AC6 — one tick of the dirty-date sweep. An entry leaves the set only once its job is enqueued. */
export async function runDirtyDateSweep(set: RollupDirtySet, enqueue: EnqueueRollup, now: Date): Promise<RollupSweepResult> {
  const { entries, malformed } = await set.peek();
  if (malformed > 0) {
    incrementCounter("nominara_rollup_dirty_malformed_total");
    logger.warn({ event: "rollup.sweep.dirty_malformed_dropped", count: malformed });
  }
  const { enqueued, failed } = await enqueueAll<DirtyEntry>(
    "dirty_date",
    entries,
    enqueue,
    (e) => ({
      payload: { projectId: e.projectId, metricDate: e.metricDate, reason: "dirty_date" },
      key: dirtyDateJobKey(e.projectId, e.metricDate, now),
    }),
    (e) => set.clear([e]),
  );
  return finish("dirty_date", entries.length, enqueued, failed);
}

type SweepClient = ClientBase & { end(): Promise<void> };

export interface RollupSweepRuntimeOptions {
  /** A NEW owner-role connection per tick (closed by the runtime). */
  readonly connect: () => Promise<SweepClient>;
  readonly enqueue: EnqueueRollup;
  readonly dirty: RollupDirtySet;
  readonly clock?: () => Date;
  /** Each sweep (the closed-day one connect included), as a whole. */
  readonly sweepTimeoutMs?: number;
}

/**
 * The in-process timer the rollup worker owns: sleeps to the next quarter hour, ticks, re-arms. Best-effort — an outage
 * skips this tick and the next one retries; it never crashes the worker. The two sweeps are independent: a database
 * outage does not stop dirty dates being reprocessed, and a Valkey outage does not stop the closed day.
 */
export class RollupSweepRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private readonly clock: () => Date;
  private readonly sweepTimeoutMs: number;

  constructor(private readonly options: RollupSweepRuntimeOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.sweepTimeoutMs = options.sweepTimeoutMs ?? DEFAULT_SWEEP_TIMEOUT_MS;
  }

  get armed(): boolean {
    return this.running;
  }

  async tick(): Promise<{ closedDay: RollupSweepResult | null; dirtyDate: RollupSweepResult | null }> {
    return tracer.startActiveSpan("rollup.sweep.tick", async (span) => {
      try {
        const now = this.clock();
        const closedDay = await this.closedDayTick(now);
        const dirtyDate = await withTimeout(() => runDirtyDateSweep(this.options.dirty, this.options.enqueue, now), this.sweepTimeoutMs, "the dirty-date sweep").catch((error: unknown) => {
          incrementCounter("nominara_rollup_sweep_runs_total", { sweep: "dirty_date", status: "failed" });
          logger.error({ event: "rollup.sweep.dirty_failed", error: error instanceof Error ? error.name : "unknown" });
          return null;
        });
        span.setAttribute("rollup.closed_day.found", closedDay?.found ?? -1);
        span.setAttribute("rollup.dirty_date.found", dirtyDate?.found ?? -1);
        return { closedDay, dirtyDate };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async closedDayTick(now: Date): Promise<RollupSweepResult | null> {
    let client: SweepClient | undefined;
    let opening: Promise<SweepClient> | undefined;
    try {
      opening = this.options.connect();
      const opened = opening;
      return await withTimeout(
        async () => {
          client = await opened;
          return await runClosedDaySweep(client, this.options.enqueue, now);
        },
        this.sweepTimeoutMs,
        "the closed-day sweep",
      );
    } catch (error) {
      // A connection that opens after we gave up must not be left open.
      if (client === undefined) void opening?.then((late) => late.end()).catch(() => undefined);
      incrementCounter("nominara_rollup_sweep_runs_total", { sweep: "closed_day", status: "failed" });
      logger.error({ event: "rollup.sweep.closed_day_failed", error: error instanceof Error ? error.name : "unknown" });
      return null;
    } finally {
      await client?.end().catch(() => undefined);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.arm(this.clock());
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private arm(from: Date): void {
    const fireAt = nextRollupSweepAfter(from);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick()
        .catch(() => undefined)
        .finally(() => {
          // A timer can fire a hair early; arming from the later of the two stops one boundary being swept twice.
          if (this.running) this.arm(new Date(Math.max(this.clock().getTime(), fireAt.getTime())));
        });
    }, Math.max(0, fireAt.getTime() - this.clock().getTime()));
    this.timer.unref();
  }
}
