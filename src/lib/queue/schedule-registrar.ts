import type { Queue } from "bullmq";
import { handlerFor } from "./handlers.js";
import { datedSchedules, scheduleFor, undatedSchedules } from "./schedule.js";

// G12 — registering the repeatables, and removing the ones that should no
// longer fire.
//
// ⚠ A SCHEDULER FOR A QUEUE WITH NO HANDLER IS WORSE THAN NO SCHEDULER.
// `src/worker.ts` already makes this argument for the workers themselves —
// "a worker that pulled a job it cannot process would fail it down the retry
// ladder and into the dead-letter queue, turning 'not built yet' into 'tried
// and failed' in the record an operator reads during an incident. Inert is a
// better lie than broken." A repeatable producing those jobs on a timer is
// the same lie told once a minute forever, so the registrar refuses to
// schedule a queue `handlerFor` does not know.
//
// ⚠ AND REMOVAL IS NOT OPTIONAL. BullMQ job schedulers live in Redis, not in
// this file. Deleting a row from the schedule table, or a handler going away,
// leaves the old scheduler firing against a deployment that no longer expects
// it — and nothing in the code would show it. Every boot reconciles: what
// should run is upserted, what should not is removed.

export interface ScheduleRegistrarResult {
  /** Queues now scheduled, with the cron they carry. */
  readonly scheduled: readonly { queue: string; cron: string }[];
  /** Queues in the table whose handler is not wired, so deliberately not scheduled. */
  readonly skippedInert: readonly string[];
  /** Scheduler ids removed from Redis because they should no longer fire. */
  readonly removed: readonly string[];
}

/**
 * The scheduler id for a queue. Stable, and derived from the queue name so
 * two replicas upserting concurrently converge on one scheduler rather than
 * two — `upsertJobScheduler` is keyed on this.
 */
export function schedulerIdFor(queue: string): string {
  return `cron:${queue}`;
}

/**
 * Reconcile the job schedulers for the queues this process owns.
 *
 * ⚠ SCOPED TO THE CALLER'S OWN QUEUES. A worker group is one process, and it
 * passes only its own queues — otherwise the `rollup` group would remove the
 * `capture` group's schedulers on every boot and the two would fight, each
 * undoing the other. `queues` is keyed by name so the caller controls exactly
 * what is in scope.
 */
export async function reconcileSchedules(
  queues: ReadonlyMap<string, Queue>,
  options: { readonly jobName?: string } = {},
): Promise<ScheduleRegistrarResult> {
  const jobName = options.jobName ?? "scheduled";
  const scheduled: { queue: string; cron: string }[] = [];
  const skippedInert: string[] = [];
  const removed: string[] = [];

  for (const [name, queue] of queues) {
    const schedule = scheduleFor(name);
    const wanted = schedule?.cron ?? null;
    const live = handlerFor(name) !== undefined;
    const shouldRun = wanted !== null && live;

    if (wanted !== null && !live) skippedInert.push(name);

    // What is already in Redis for THIS queue. Reconciled rather than
    // blindly upserted, so a scheduler that should no longer exist goes away.
    const existing = await queue.getJobSchedulers();
    for (const entry of existing) {
      if (entry.key === undefined || entry.key === null) continue;
      if (shouldRun && entry.key === schedulerIdFor(name)) continue;
      await queue.removeJobScheduler(entry.key);
      removed.push(`${name}:${entry.key}`);
    }

    if (!shouldRun) continue;

    await queue.upsertJobScheduler(schedulerIdFor(name), { pattern: wanted }, { name: jobName });
    scheduled.push({ queue: name, cron: wanted });
  }

  return { scheduled, skippedInert, removed };
}

/** The one line a boot log needs: what ticks, what does not, and why. */
export function describeSchedules(result: ScheduleRegistrarResult): string {
  const running = result.scheduled.map((s) => `${s.queue}@${s.cron}`).join(", ") || "none";
  const parts = [`scheduled: ${running}`];
  if (result.skippedInert.length > 0) parts.push(`inert (no handler), not scheduled: ${result.skippedInert.join(", ")}`);
  if (result.removed.length > 0) parts.push(`removed: ${result.removed.join(", ")}`);
  // Named here rather than only in the table, so an operator reading the boot
  // log learns the cadence gap without going to find the source.
  const dated = datedSchedules().length;
  const undated = undatedSchedules().length;
  parts.push(`${String(dated)} of ${String(dated + undated)} cron queues state a time`);
  return parts.join(" · ");
}
