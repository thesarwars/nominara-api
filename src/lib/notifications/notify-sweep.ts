import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { releaseAdvisorySessionLock, tryAdvisorySessionLock } from "../queue/locks.js";
import { validTimezoneSql } from "../rollup/timezone.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { DIGEST_DEFAULT_ROLES } from "./audience.js";
import { creditCheckJobKey, digestJobKey, emailRelayJobKey, NOTIFY_DISPATCH_QUEUE, type EnqueueNotifyDispatch } from "./routing.js";

// STORY-068 — THE NOTIFY SWEEP: the digest producer and the outbox relay, in-process in the ROLLUP worker group (where
// `notify.dispatch` runs), on the capture scheduler-sweep / rollup-sweep precedent.
//
// WHY A SWEEP AND NOT A CRON. `notify.dispatch` is TENANT-scoped: every job is signed for one workspace, so a bare BullMQ
// cron (no workspace) cannot feed it (schedule-registrar.ts refuses such a row as inert). The sweep reads ids across every
// workspace on the OWNER connection and enqueues one signed job per member and period; the job assembles the digest in
// that workspace's own tenant context. The sweep never reads a notification's content and never writes tenant data,
// apart from deleting outbox rows past retention.
//
// ELECTED, AND NO TRANSACTION IS HELD. Every replica ticks; a tick runs only if it takes the session advisory lock
// `notify.sweep` on its own DIRECT, non-pooled connection (locks.ts: try-lock, never a wait; released at the end and by the
// connection's end). Nothing here opens a transaction, so none is held across an enqueue (network I/O, NFR-ARCH-04).
// The job keys make a second replica, or a re-ask, harmless anyway.
//
// DIGEST PERIODS ARE WORKSPACE-LOCAL. Daily: the local day before. Weekly: the ISO week (Monday 00:00 local) before.
// A period is due once it has ended and the local clock has passed DIGEST_SEND_LOCAL_HOUR, so the email arrives in the
// morning, not at midnight. A member is asked for once per period: once the job records the period (sent, pending or
// `skipped_empty`) the sweep stops asking. The cadence is the member's own (owner decision 2026-10-23).
//
// CREDIT THRESHOLDS (AC7): the sweep asks a `credit_check` job of every wallet that MAY have crossed 25% or 10% of its
// cycle's grant and has not been warned for that threshold this cycle. This is how the warning is stamped AFTER the debit
// that crossed it committed, by whichever path debited (a priced request, an inline debit, a run's settlement), and
// never inside a ledger transaction. The pre-filter reads the plan's base grant; a workspace whose grant is overridden is
// always asked (its override is resolved in the job). The job decides exactly, under the workspace's own tenant context.
//
// THE RELAY: an outbox row still `pending` five minutes after it was recorded (its job's ladder ran out, or its enqueue
// failed after the commit) is re-enqueued under an hour-suffixed key, up to 23 hours (inside Resend's 24-hour idempotency
// window for the provider key derived from the row id, so a relayed send is never a second delivery).

const logger = new Logger("notify.sweep");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const NOTIFY_SWEEP_LOCK = "notify.sweep";
export const NOTIFY_SWEEP_STEP_MS = 5 * MINUTE_MS;
/** Local hour after which a finished period's digest is sent. */
export const DIGEST_SEND_LOCAL_HOUR = 8;
export const DIGEST_BATCH = 1000;
export const EMAIL_RELAY_MIN_AGE_MS = 5 * MINUTE_MS;
export const EMAIL_RELAY_MAX_AGE_MS = 23 * HOUR_MS;
export const EMAIL_RELAY_BATCH = 500;
/** Outbox rows (they hold a rendered body naming projects) are kept 90 days, then deleted. A choice, not a transcription. */
export const EMAIL_RETENTION_MS = 90 * 24 * HOUR_MS;

export interface DigestTarget {
  readonly workspaceId: string;
  readonly userId: string;
  readonly cadence: "daily" | "weekly";
  /** ISO instants, [start, end). */
  readonly periodStart: string;
  readonly periodEnd: string;
}

/** Every member whose last finished digest period is due at `now` and not yet recorded. `client` sees across tenants. */
export async function findDigestTargets(client: ClientBase, now: Date): Promise<DigestTarget[]> {
  const result = await client.query<{ workspace_id: string; user_id: string; cadence: "daily" | "weekly"; period_start: Date; period_end: Date }>(
    `WITH valid_ws AS MATERIALIZED (
            SELECT w.id, w.timezone FROM workspaces w WHERE w.deleted_at IS NULL AND ${validTimezoneSql("w.timezone")}),
          members AS (
            SELECT m.workspace_id, m.user_id, w.timezone,
                   COALESCE(m.digest_cadence, CASE WHEN m.role = ANY($4::text[]) THEN 'weekly' ELSE 'off' END) AS cadence
              FROM workspace_members m
              JOIN valid_ws w ON w.id = m.workspace_id
              JOIN users u ON u.id = m.user_id
             WHERE m.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL),
          periods AS (
            SELECT mb.workspace_id, mb.user_id, mb.cadence, mb.timezone, pe.end_local,
                   pe.end_local - CASE mb.cadence WHEN 'daily' THEN interval '1 day' ELSE interval '7 days' END AS start_local
              FROM members mb
             CROSS JOIN LATERAL (SELECT ($1::timestamptz AT TIME ZONE mb.timezone) - make_interval(hours => $2::int) AS shifted) ln
             CROSS JOIN LATERAL (SELECT date_trunc(CASE mb.cadence WHEN 'daily' THEN 'day' ELSE 'week' END, ln.shifted) AS end_local) pe
             WHERE mb.cadence IN ('daily', 'weekly'))
     SELECT p.workspace_id, p.user_id, p.cadence,
            (p.start_local AT TIME ZONE p.timezone) AS period_start,
            (p.end_local AT TIME ZONE p.timezone) AS period_end
       FROM periods p
      WHERE NOT EXISTS (
              SELECT 1 FROM notification_emails e
               WHERE e.workspace_id = p.workspace_id AND e.user_id = p.user_id AND e.kind = 'digest'
                 AND e.cadence = p.cadence AND e.period_start = (p.start_local AT TIME ZONE p.timezone))
      ORDER BY p.workspace_id, p.user_id
      LIMIT $3`,
    [now, DIGEST_SEND_LOCAL_HOUR, DIGEST_BATCH, [...DIGEST_DEFAULT_ROLES]],
  );
  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    userId: row.user_id,
    cadence: row.cadence,
    periodStart: row.period_start.toISOString(),
    periodEnd: row.period_end.toISOString(),
  }));
}

/** The plan's base grant as a number, or NULL when the plan does not state one as a figure ("custom"). */
// `plans.entitlements` is {key: {value, live}} (migration 0018).
const BASE_GRANT_SQL = `CASE WHEN jsonb_typeof(p.entitlements->'credits.included_per_cycle'->'value') = 'number' THEN (p.entitlements->'credits.included_per_cycle'->>'value')::numeric END`;
const STALE_SQL = (column: string) => `(cw.${column} IS NULL OR cw.${column} < (cw.cycle_start::timestamp AT TIME ZONE 'UTC'))`;

/** Wallets that may owe a credit-threshold warning (a superset; the job decides exactly). Ids only. */
export async function findCreditCheckTargets(client: ClientBase): Promise<string[]> {
  const rows = await client.query<{ workspace_id: string }>(
    `SELECT cw.workspace_id
       FROM credit_wallets cw
       JOIN workspaces w ON w.id = cw.workspace_id
       JOIN plans p ON p.key = w.plan_key
      CROSS JOIN LATERAL (SELECT (cw.included_balance + cw.purchased_balance - cw.reserved)::numeric * 100 AS balance_x100, ${BASE_GRANT_SQL} AS base_grant) g
      WHERE w.deleted_at IS NULL
        AND (
              (w.entitlement_overrides ? 'credits.included_per_cycle' AND (${STALE_SQL("warned_at_25pct")} OR ${STALE_SQL("warned_at_10pct")}))
           OR (g.base_grant > 0 AND ${STALE_SQL("warned_at_25pct")} AND g.balance_x100 < g.base_grant * 25)
           OR (g.base_grant > 0 AND ${STALE_SQL("warned_at_10pct")} AND g.balance_x100 < g.base_grant * 10))
      ORDER BY cw.workspace_id
      LIMIT $1`,
    [DIGEST_BATCH],
  );
  return rows.rows.map((row) => row.workspace_id);
}

export interface NotifySweepResult {
  readonly digests: number;
  readonly creditChecks: number;
  readonly relayed: number;
  readonly failed: number;
  readonly abandoned: number;
  readonly purged: number;
}

export class NotifySweepBlindError extends Error {
  constructor(who: string) {
    super(`the notify sweep is connected as "${who}", which neither bypasses row-level security nor is a superuser: it would find no digest due and look healthy`);
    this.name = "NotifySweepBlindError";
  }
}

/** One pass on `client`, an owner connection that sees across tenants. A failed enqueue is counted and logged, and asked again next tick. */
export async function runNotifySweep(client: ClientBase, enqueue: EnqueueNotifyDispatch, now: Date): Promise<NotifySweepResult> {
  const role = await client.query<{ can_see: boolean; who: string }>("SELECT (rolsuper OR rolbypassrls) AS can_see, rolname AS who FROM pg_roles WHERE rolname = current_user");
  if (role.rows[0]?.can_see !== true) throw new NotifySweepBlindError(role.rows[0]?.who ?? "unknown");
  let digests = 0;
  let relayed = 0;
  let failed = 0;
  for (const target of await findDigestTargets(client, now)) {
    try {
      await enqueue(
        NOTIFY_DISPATCH_QUEUE,
        target.workspaceId,
        { kind: "digest", userId: target.userId, cadence: target.cadence, periodStart: target.periodStart, periodEnd: target.periodEnd },
        { idempotencyKey: digestJobKey(target.workspaceId, target.userId, target.cadence, target.periodStart) },
      );
      digests += 1;
    } catch (error) {
      failed += 1;
      incrementCounter("nominara_notify_sweep_enqueue_failed_total", { kind: "digest" });
      logger.error({ event: "notify.sweep.enqueue_failed", kind: "digest", workspace_id: target.workspaceId, error: error instanceof Error ? error.name : "unknown" });
    }
  }

  const credit = await findCreditCheckTargets(client);
  for (const workspaceId of credit) {
    try {
      await enqueue(NOTIFY_DISPATCH_QUEUE, workspaceId, { kind: "credit_check" }, { idempotencyKey: creditCheckJobKey(workspaceId, now) });
    } catch (error) {
      failed += 1;
      incrementCounter("nominara_notify_sweep_enqueue_failed_total", { kind: "credit_check" });
      logger.error({ event: "notify.sweep.enqueue_failed", kind: "credit_check", workspace_id: workspaceId, error: error instanceof Error ? error.name : "unknown" });
    }
  }

  const due = await client.query<{ id: string; workspace_id: string }>(
    `SELECT id, workspace_id FROM notification_emails
      WHERE status = 'pending' AND created_at < $1 AND created_at >= $2
      ORDER BY created_at
      LIMIT ${String(EMAIL_RELAY_BATCH)}`,
    [new Date(now.getTime() - EMAIL_RELAY_MIN_AGE_MS), new Date(now.getTime() - EMAIL_RELAY_MAX_AGE_MS)],
  );
  const hour = String(Math.floor(now.getTime() / HOUR_MS));
  for (const row of due.rows) {
    try {
      await enqueue(NOTIFY_DISPATCH_QUEUE, row.workspace_id, { kind: "email", emailId: row.id }, { idempotencyKey: emailRelayJobKey(row.id, hour) });
      relayed += 1;
    } catch (error) {
      failed += 1;
      incrementCounter("nominara_notify_sweep_enqueue_failed_total", { kind: "relay" });
      logger.error({ event: "notify.sweep.enqueue_failed", kind: "relay", workspace_id: row.workspace_id, email_id: row.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }

  const abandoned =
    (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM notification_emails WHERE status = 'pending' AND created_at < $1", [new Date(now.getTime() - EMAIL_RELAY_MAX_AGE_MS)]))
      .rows[0]?.n ?? 0;
  if (abandoned > 0) {
    incrementCounter("nominara_notify_sweep_abandoned_ticks_total");
    logger.error({ event: "notify.sweep.abandoned", count: abandoned });
  }
  const purged = (await client.query("DELETE FROM notification_emails WHERE created_at < $1", [new Date(now.getTime() - EMAIL_RETENTION_MS)])).rowCount ?? 0;

  incrementCounter("nominara_notify_sweep_runs_total", { status: failed === 0 ? "complete" : "partial" });
  logger.log({ event: "notify.sweep", digests, credit_checks: credit.length, relayed, failed, abandoned, purged });
  return { digests, creditChecks: credit.length, relayed, failed, abandoned, purged };
}

type SweepClient = ClientBase & { end(): Promise<void> };

export interface NotifySweepRuntimeOptions {
  /** A NEW direct (never pooled, never pgBouncer) owner-role connection per tick; the runtime ends it. */
  readonly connect: () => Promise<SweepClient>;
  readonly enqueue: EnqueueNotifyDispatch;
  readonly clock?: () => Date;
}

/** The in-process timer the rollup worker owns: a tick every 5 minutes, elected, best-effort, never crashes the worker. */
export class NotifySweepRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private inFlight = false;
  private readonly clock: () => Date;

  constructor(private readonly options: NotifySweepRuntimeOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  get armed(): boolean {
    return this.running;
  }

  /** `null` when another replica held the lock, a tick was still running, or the pass failed (logged and counted). */
  async tick(): Promise<NotifySweepResult | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    let client: SweepClient | undefined;
    let locked = false;
    try {
      client = await this.options.connect();
      locked = await tryAdvisorySessionLock(client, NOTIFY_SWEEP_LOCK);
      if (!locked) {
        incrementCounter("nominara_notify_sweep_runs_total", { status: "not_elected" });
        return null;
      }
      return await runNotifySweep(client, this.options.enqueue, this.clock());
    } catch (error) {
      incrementCounter("nominara_notify_sweep_runs_total", { status: "failed" });
      logger.error({ event: "notify.sweep.failed", error: error instanceof Error ? error.name : "unknown" });
      return null;
    } finally {
      if (client !== undefined && locked) await releaseAdvisorySessionLock(client, NOTIFY_SWEEP_LOCK).catch(() => false);
      await client?.end().catch(() => undefined);
      this.inFlight = false;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.arm();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private arm(): void {
    const now = this.clock().getTime();
    const fireAt = (Math.floor(now / NOTIFY_SWEEP_STEP_MS) + 1) * NOTIFY_SWEEP_STEP_MS;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().finally(() => {
        if (this.running) this.arm();
      });
    }, Math.max(0, fireAt - now));
    this.timer.unref();
  }
}
