import type { JobSchedulerTemplateOptions, Queue } from "bullmq";
import { handlerFor } from "./handlers.js";
import { attemptsFor, resolvePriority } from "./queue-factory.js";
import { datedSchedules, scheduleFor, undatedSchedules } from "./schedule.js";
import { topologyFor } from "./topology.js";
import { incrementCounter } from "../telemetry/metrics.js";

// G12 — registering the repeatables, and removing the ones that should no
// longer fire.
//
// ⚠ A BARE CRON TICK CANNOT DRIVE A TENANT-SCOPED QUEUE, AND THIS IS THE
// GATE THAT MATTERS. A job scheduler produces the same template payload every
// time; it has no workspace to name and no key to sign with. For a queue with
// `tenantScoped: true`, `createJobProcessor` calls `toTenantJob(job.data)` and
// then `verify(...)` as its first executable statement — so a template of `{}`
// yields `{data: undefined}` and `readKid` throws a TypeError before the
// handler is ever reached. Every tick, forever, straight into the
// dead-letter queue.
//
// This was found by a second-engineer review, which reproduced it end to end:
// scheduling `rollup.metric_daily` (tenantScoped, handler wired) produces
// `{"name":"scheduled","data":{},"opts":{}}` and feeding that to the real
// processor throws `Cannot read properties of undefined (reading 'kid')`. The
// first cut of this file gated on `handlerFor` alone, which is NECESSARY BUT
// NOT SUFFICIENT — a wired handler says the work is implemented, not that the
// work can be started by a timer with nothing to say.
//
// What §4 means by "cron hourly" for a tenant-scoped queue is a SWEEP that
// enqueues one signed job per project — which is exactly what
// `src/lib/capture/scheduler.ts` is for `capture.plan`. That sweep is a
// handler of its own, on a queue that is not tenant-scoped. Until one exists,
// a tenant-scoped row in the schedule table is a cadence with no producer,
// and the honest thing is to refuse it and say so in the boot log.
//
// ⚠ A SCHEDULER FOR A QUEUE WITH NO HANDLER IS WORSE THAN NO SCHEDULER.
// `src/worker.ts` already makes this argument for the workers themselves —
// "a worker that pulled a job it cannot process would fail it down the retry
// ladder and into the dead-letter queue, turning 'not built yet' into 'tried
// and failed' in the record an operator reads during an incident. Inert is a
// better lie than broken." A repeatable producing those jobs on a timer is
// the same lie told forever, so the registrar also refuses a queue
// `handlerFor` does not know.
//
// ⚠ AND REMOVAL IS NOT OPTIONAL. BullMQ job schedulers live in Redis, not in
// this file. Deleting a row from the schedule table, or a handler going away,
// leaves the old scheduler firing against a deployment that no longer expects
// it — and nothing in the code would show it. Every boot reconciles: what
// should run is upserted, what should not is removed.

/** The prefix every scheduler id this table owns begins with. */
const OWNED_PREFIX = "cron:";

export interface ScheduleRegistrarResult {
  /** Queues now scheduled, with the cron they carry. */
  readonly scheduled: readonly { queue: string; cron: string }[];
  /** Queues in the table whose handler is not wired, so deliberately not scheduled. */
  readonly skippedInert: readonly string[];
  /** Queues in the table that are tenant-scoped, so a bare cron tick cannot drive them. */
  readonly skippedTenantScoped: readonly string[];
  /** Scheduler ids removed from Redis because they should no longer fire. */
  readonly removed: readonly string[];
  /** Queues whose own reconcile threw, by name — one failure never silences the rest. */
  readonly failed: readonly { queue: string; reason: string }[];
}

/**
 * The scheduler id for a queue. Stable, and derived from the queue name so
 * two replicas upserting concurrently converge on one scheduler rather than
 * two — `upsertJobScheduler` is keyed on this.
 *
 * The `cron:` prefix is also an OWNERSHIP MARK: reconciliation only ever
 * removes keys carrying it. See `reconcileSchedules`.
 */
export function schedulerIdFor(queue: string): string {
  return `${OWNED_PREFIX}${queue}`;
}

/**
 * The options a scheduled tick carries, taken from the queue's own topology
 * entry — the same source `enqueueJob` reads.
 *
 * ⚠ WITHOUT THIS THE TICK CARRIES NOTHING. `buildQueue` sets no
 * `defaultJobOptions` (every documented knob lives in `enqueueJob`), so a
 * scheduler that passes a bare `{ name }` template produces `attempts: 0`,
 * no priority, and no retention — measured against real Valkey by the review
 * that found it. For `credit.reconcile` that is a ledger change: the handler
 * opens a fresh privileged connection as its first act, and §4 gives it a 3×
 * exponential retry ladder. With `attempts: 0` a Postgres restart or a brief
 * blip is TERMINAL on the first try and the orphan sweep — the one path that
 * hands credits back to a customer who was never charged — lands in the DLQ
 * instead of retrying. The missing `removeOnComplete` grows Valkey without
 * bound on top of that.
 *
 * ⚠ AND NO `deduplication` — BullMQ's own template type forbids it
 * (`JobSchedulerTemplateOptions = Omit<JobsOptions, 'jobId' | 'repeat' |
 * 'delay' | 'deduplication'>`), and it is right to. `enqueueJob` sets one
 * from the caller's idempotency key with a ttl of `removeOnComplete.age`
 * (3600s here). A repeatable has no per-tick key to offer, and a CONSTANT id
 * would be far worse than none: the second tick inside the ttl window would
 * be dropped as a duplicate, so a ten-minute cadence under a one-hour window
 * would run once an hour instead of six times. The repeatable's own job id is
 * already unique per tick (`repeat:cron:<queue>:<ms>`), which is the property
 * dedup would have been buying.
 */
function scheduledJobOptions(queue: string): JobSchedulerTemplateOptions {
  const entry = topologyFor(queue);
  const options: JobSchedulerTemplateOptions = {
    priority: resolvePriority(entry, "scheduled"),
    attempts: attemptsFor(entry),
    removeOnComplete: entry.removeOnComplete,
    removeOnFail: entry.removeOnFail,
  };
  if (entry.retry.delaysMs.length > 0) {
    options.backoff = { type: "custom" };
  }
  return options;
}

/** Why a queue in the schedule table is not being scheduled, or null if it should be. */
function refusalFor(queue: string): "inert" | "tenant-scoped" | null {
  if (handlerFor(queue) === undefined) return "inert";
  if (topologyFor(queue).tenantScoped) return "tenant-scoped";
  return null;
}

/**
 * Reconcile the job schedulers for the queues this process owns.
 *
 * ⚠ SCOPED TO THE CALLER'S OWN QUEUES. A worker group is one process, and it
 * passes only its own queues — otherwise the `rollup` group would remove the
 * `capture` group's schedulers on every boot and the two would fight, each
 * undoing the other. `queues` is keyed by name so the caller controls exactly
 * what is in scope.
 *
 * ⚠ AND SCOPED AGAIN, BY KEY PREFIX, WHICH IS A SEPARATE THING. Owning the
 * QUEUE does not mean owning every scheduler on it. The first cut removed
 * every job scheduler it found on every queue in the group, including queues
 * with no schedule-table row at all — so a per-workspace scheduler on
 * `report.build` (§5's scheduled reports) or STORY-033's `SchedulerService`
 * driving `capture.plan` under its own key would be deleted on the next boot
 * of that group, silently, with the customer's scheduled report simply
 * stopping. A review reproduced it: 25 unrelated schedulers on
 * `notify.dispatch`, all removed by one boot. Only keys carrying this table's
 * own `cron:` prefix are ever removed.
 *
 * ⚠ UPSERT BEFORE REMOVE. Between the two there is a window, and which side
 * of it is safe is not symmetric: for an idempotent tick a brief OVERLAP
 * costs a duplicate run, while a GAP — a SIGKILL during a rolling deploy
 * landing between the remove and the upsert — leaves the queue unscheduled
 * indefinitely with nothing in the code or the log to show it.
 *
 * ⚠ ON OVERLAP AND THE LEDGER, since this function is what makes it
 * reachable. `getJobSchedulers` then `upsert`/`remove` is a read-then-write on
 * shared Redis state with no lock, so a scheduler registered under a
 * different key inside the window survives and both fire at the same instant.
 * Two concurrent `credit.reconcile` runs are safe, and not by accident:
 * `releaseReservation` takes the wallet row lock FIRST, reads the ledger under
 * it, and treats a refused append as a throw rather than an outcome. The test
 * that holds this up is `test/integration/credit-ledger-reconciliation.spec.ts`
 * "two OVERLAPPING runs release once and do not eat a live hold", which drives
 * two genuinely concurrent scans through separate pool connections. If that
 * test is ever weakened, this function is why it mattered.
 *
 * Steady state does NOT double-fire: two replicas upserting the same id
 * converge on one scheduler, and clock skew across a cron boundary drops a
 * tick rather than duplicating one.
 */
export async function reconcileSchedules(
  queues: ReadonlyMap<string, Queue>,
  options: { readonly jobName?: string } = {},
): Promise<ScheduleRegistrarResult> {
  const jobName = options.jobName ?? "scheduled";
  const scheduled: { queue: string; cron: string }[] = [];
  const skippedInert: string[] = [];
  const skippedTenantScoped: string[] = [];
  const removed: string[] = [];
  const failed: { queue: string; reason: string }[] = [];

  for (const [name, queue] of queues) {
    const wanted = scheduleFor(name)?.cron ?? null;
    const refusal = wanted === null ? null : refusalFor(name);
    const shouldRun = wanted !== null && refusal === null;

    if (refusal === "inert") skippedInert.push(name);
    if (refusal === "tenant-scoped") skippedTenantScoped.push(name);

    // ⚠ PER QUEUE, so one failure cannot silence the rest. An unparseable
    // cron makes `upsertJobScheduler` throw, and the queues are walked in
    // topology order — without this, a typo on `rollup.metric_daily` (index
    // 9) would leave `credit.reconcile` (index 16) unscheduled with the boot
    // log reporting one error about a different queue.
    try {
      if (shouldRun) {
        await queue.upsertJobScheduler(
          schedulerIdFor(name),
          { pattern: wanted },
          { name: jobName, data: {}, opts: scheduledJobOptions(name) },
        );
        scheduled.push({ queue: name, cron: wanted });
      }

      // What is already in Redis for THIS queue, of the keys THIS table owns.
      for (const entry of await queue.getJobSchedulers()) {
        const key: unknown = entry.key;
        if (typeof key !== "string" || !key.startsWith(OWNED_PREFIX)) continue;
        if (shouldRun && key === schedulerIdFor(name)) continue;
        await queue.removeJobScheduler(key);
        removed.push(`${name}:${key}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push({ queue: name, reason });
      incrementCounter("queue_schedule_reconcile_failed", { queue: name });
    }
  }

  return { scheduled, skippedInert, skippedTenantScoped, removed, failed };
}

/** The one line a boot log needs: what ticks, what does not, and why. */
export function describeSchedules(result: ScheduleRegistrarResult): string {
  const running = result.scheduled.map((s) => `${s.queue}@${s.cron}`).join(", ") || "none";
  const parts = [`scheduled: ${running}`];
  if (result.skippedInert.length > 0) parts.push(`inert (no handler), not scheduled: ${result.skippedInert.join(", ")}`);
  if (result.skippedTenantScoped.length > 0) {
    parts.push(`tenant-scoped (needs a per-workspace sweep, not a bare tick): ${result.skippedTenantScoped.join(", ")}`);
  }
  if (result.removed.length > 0) parts.push(`removed: ${result.removed.join(", ")}`);
  if (result.failed.length > 0) parts.push(`FAILED: ${result.failed.map((f) => `${f.queue} (${f.reason})`).join(", ")}`);
  // Named here rather than only in the table, so an operator reading the boot
  // log learns the cadence gap without going to find the source.
  const dated = datedSchedules().length;
  const undated = undatedSchedules().length;
  parts.push(`${String(dated)} of ${String(dated + undated)} cron queues state a time`);
  return parts.join(" · ");
}
