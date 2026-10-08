import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { incrementCounter } from "../telemetry/metrics.js";
import { claimDueProjectRefs } from "./scheduler.js";

// NEW-A-13 — the scheduler sweep: the producer `capture.plan` has always
// declared and nothing ran. OWNER DECISION 2026-10-08, "Option A".
//
// THE SWEEP CLAIMS AND ENQUEUES; IT NEVER ADVANCES. It claims due projects
// (FOR UPDATE SKIP LOCKED, longest-waiting first) and enqueues ONE signed
// `capture.plan` job per project under the dedup key `run:{project}:{next_run_at}`
// (the topology's `run:{project}:{window}` pattern, the window being the due
// time the project is waiting on). The `capture.plan` handler (NEW-A-10) is the
// only thing that moves `next_run_at`, inside the job's tenant context.
//
// WHY NOT ADVANCE-THEN-ENQUEUE, which tracking-engine.md §5 originally said.
// The handler re-derives dueness (`claimDueProject` requires `next_run_at <=
// now`), so a project the sweep had already advanced would be found "not due"
// and every job would plan nothing. The handler stays the single advancer.
//
// WHAT "TWO TICKS NEVER ENQUEUE THE SAME PROJECT TWICE" RESTS ON, since it is
// no longer the advance: (1) the claim transaction is held ACROSS the enqueue,
// so a concurrent tick's SKIP LOCKED steps over every row this one holds; and
// (2) the dedup key, which holds across ticks — until the handler runs, the
// project is still due with the SAME next_run_at, so the next hourly tick
// derives the same key and the queue returns the original job. After the
// handler advances, the key changes and the project is simply not due.
//
// THE TRANSACTION IS HELD ACROSS AN AWAIT ON THE QUEUE (Valkey), deliberately,
// and only here: this is a background sweep, not a request handler (KAD-06 is
// about request handlers), and it holds row locks on `projects`, not a tenant
// context. A bounded batch (SCHEDULER_BATCH_SIZE) bounds the time. A failed
// enqueue does not roll anything back — nothing was written — it is counted,
// logged with ids, and reported as `partial`.
//
// A BACKLOG LARGER THAN ONE BATCH drains oldest-first as the handler advances
// projects between ticks. Until it does, the same oldest rows are re-claimed
// and their jobs deduplicated; that is the cost of leaving advancement to the
// handler, and it is visible in `claimed` vs `enqueued`.
//
// READS ONLY WHAT IT NEEDS: id, workspace id, cadence, next_run_at
// (`claimDueProjectRefs`). Never a prompt, a name, a plan. Its connection is
// the owner connection (DATABASE_URL), like credit.reconcile and
// identity.sweep_unverified: it must see across tenants, which is also why a
// connection that cannot (RLS-bound) is refused before it reads anything —
// a blind sweep would schedule nothing and look healthy.

const logger = new Logger("capture.scheduler");

const HOUR_MS = 60 * 60 * 1000;
/** system-architecture.md §6.1: capture.plan's tick is `cron(:05 hourly)`, in UTC. */
const SWEEP_MINUTE = 5;

export class SchedulerBlindError extends Error {
  constructor(who: string) {
    super(
      `the scheduler sweep is connected as "${who}", which neither bypasses row-level security nor is a superuser — ` +
        "it would see no projects, schedule nothing and look healthy",
    );
    this.name = "SchedulerBlindError";
  }
}

export interface SweepJob {
  readonly workspaceId: string;
  readonly projectId: string;
  /** `run:{project}:{next_run_at}` — see the header. */
  readonly idempotencyKey: string;
}

/** Signs and enqueues one `capture.plan` job for `job.workspaceId`. Injected: the sweep holds no HMAC key and no queue. */
export type SweepEnqueue = (job: SweepJob) => Promise<void>;

export interface SchedulerSweepResult {
  /** `partial` when at least one enqueue failed. Never silent. */
  readonly status: "complete" | "partial";
  readonly claimed: number;
  readonly enqueued: number;
  readonly failed: number;
}

export function sweepIdempotencyKey(projectId: string, nextRunAt: Date): string {
  return `run:${projectId}:${nextRunAt.toISOString()}`;
}

/** The next :05 UTC strictly after `now` (on the boundary itself, the following hour's). */
export function nextSweepAfter(now: Date): Date {
  const candidate = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + SWEEP_MINUTE * 60 * 1000;
  return new Date(candidate > now.getTime() ? candidate : candidate + HOUR_MS);
}

async function assertSweepCanSee(client: ClientBase): Promise<void> {
  const result = await client.query<{ can_see: boolean; who: string }>(
    "SELECT (rolsuper OR rolbypassrls) AS can_see, rolname AS who FROM pg_roles WHERE rolname = current_user",
  );
  const row = result.rows[0];
  if (row?.can_see === true) return;
  incrementCounter("nominara_capture_scheduler_sweeps_total", { status: "blind" });
  throw new SchedulerBlindError(row?.who ?? "unknown");
}

/**
 * One tick: claim, enqueue, commit. `client` must be a dedicated connection (it
 * opens and closes the transaction itself).
 */
export async function runSchedulerSweep(
  client: ClientBase,
  enqueue: SweepEnqueue,
  now: Date,
): Promise<SchedulerSweepResult> {
  await assertSweepCanSee(client);

  let enqueued = 0;
  let failed = 0;
  let claimed: number;
  await client.query("BEGIN");
  try {
    const due = await claimDueProjectRefs(client, now);
    claimed = due.length;
    for (const project of due) {
      try {
        await enqueue({
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          idempotencyKey: sweepIdempotencyKey(project.projectId, project.nextRunAt),
        });
        enqueued += 1;
        incrementCounter("nominara_capture_scheduler_jobs_enqueued_total");
        // IDs only — never a workspace name or any tenant content.
        logger.log({ event: "capture.scheduler.enqueued", workspace_id: project.workspaceId, project_id: project.projectId });
      } catch (error) {
        failed += 1;
        incrementCounter("nominara_capture_scheduler_enqueue_failures_total");
        logger.error({
          event: "capture.scheduler.enqueue_failed",
          workspace_id: project.workspaceId,
          project_id: project.projectId,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }

  const status = failed === 0 ? "complete" : "partial";
  incrementCounter("nominara_capture_scheduler_sweeps_total", { status });
  logger.log({ event: "capture.scheduler.sweep", status, claimed, enqueued, failed });
  return { status, claimed, enqueued, failed };
}

export interface SweepRuntimeOptions {
  /** A NEW owner-role connection per tick (closed by the runtime). */
  readonly connect: () => Promise<ClientBase & { end(): Promise<void> }>;
  readonly enqueue: SweepEnqueue;
  readonly clock?: () => Date;
}

/**
 * The in-process timer the capture worker owns (CanaryRuntime's pattern):
 * sleeps to the next :05 UTC, ticks, re-arms. Best-effort — an outage skips this
 * hour and the next one retries; it never crashes the worker. Several replicas
 * all tick; SKIP LOCKED and the dedup key make that safe.
 */
export class SchedulerSweepRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private readonly clock: () => Date;

  constructor(private readonly options: SweepRuntimeOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  async tick(): Promise<SchedulerSweepResult | null> {
    let client: Awaited<ReturnType<SweepRuntimeOptions["connect"]>>;
    try {
      client = await this.options.connect();
    } catch (error) {
      incrementCounter("nominara_capture_scheduler_sweeps_total", { status: "connect_failed" });
      logger.warn({ event: "capture.scheduler.connect_failed", error: error instanceof Error ? error.name : "unknown" });
      return null;
    }
    try {
      return await runSchedulerSweep(client, this.options.enqueue, this.clock());
    } catch (error) {
      logger.error({ event: "capture.scheduler.sweep_failed", error: error instanceof Error ? error.name : "unknown" });
      return null;
    } finally {
      await client.end().catch(() => undefined);
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
    const fireAt = nextSweepAfter(from);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().finally(() => {
        // A timer can fire a hair before its target; arming from the later of
        // the two stops one boundary being swept twice.
        if (this.running) this.arm(new Date(Math.max(this.clock().getTime(), fireAt.getTime())));
      });
    }, Math.max(0, fireAt.getTime() - this.clock().getTime()));
  }
}
