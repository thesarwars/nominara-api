import { QUEUE_TOPOLOGY } from "./topology.js";

// G12 — the timer. `producer:` in the topology has always been a declaration
// of INTENT and nothing has ever read it.
//
// ⚠ WHAT WAS ACTUALLY MISSING, because the gap is narrower and stranger than
// "no scheduler exists". `src/lib/capture/scheduler.ts` is a complete
// SchedulerService from STORY-033 — `claimDueProjects` with FOR UPDATE SKIP
// LOCKED, fairness ordering by `next_run_at`, the watermark advanced inside
// the same transaction as the enqueue — and it has two integration specs and
// ZERO production callers. Ten queues declare a cron producer and no BullMQ
// job scheduler is registered for any of them. Everything is built; nothing
// ticks.
//
// ⚠ AND A CADENCE IS NOT A CRON EXPRESSION. `system-architecture.md` §4 states
// six of the ten as periods — "cron daily", "cron weekly", "cron monthly" —
// which say how OFTEN and not WHEN. Turning "daily" into `0 2 * * *` invents
// an off-peak hour nobody chose, and an off-peak hour is a real decision with
// a real blast radius (it lands on the vendors, on the database, and on
// whoever is awake). Only the cadences §4 states unambiguously are here. The
// rest are listed with what the reference actually says, so the gap is
// visible in this table rather than discovered later.
//
// ⚠ A ROW HERE IS NOT A PROMISE THAT THE QUEUE TICKS. This table records what
// §4 SAYS; `schedule-registrar.ts` decides what can actually be driven by a
// bare repeatable, and refuses two whole categories — a queue with no handler,
// and a queue that is `tenantScoped`. For a tenant-scoped queue, "cron hourly"
// in §4 describes a SWEEP that enqueues one signed job per project (what
// `src/lib/capture/scheduler.ts` is for `capture.plan`), not a repeatable on
// the queue itself: a job scheduler has no workspace to name and no key to
// sign with, and the tenant processor rejects the empty envelope before the
// handler is reached. Of the dated rows, only those with a handler on a non-tenant-scoped queue
// are schedulable today; the rest are cadences waiting on a producer.
//
// ⚠ AND "HOURLY" INVENTS A MINUTE, by the same argument this header makes
// about inventing an hour. `0 * * * *` picks minute 0, the most contended
// minute of the hour on any box, and the two hourly rows below would collide
// on it exactly. §6.1's explicit `:05` for `capture.plan` shows the reference
// choosing minutes deliberately when it cares. Neither hourly row is
// schedulable yet, so nothing turns on it today — but when a sweep arrives
// for them, the minute is a decision to make and not a transcription to copy.
export interface QueueSchedule {
  readonly queue: string;
  /** A cron expression, or null when the reference states a period without a time. */
  readonly cron: string | null;
  /** Verbatim from `system-architecture.md` §4's producer column, or §6.1. */
  readonly statedAs: string;
}

export const QUEUE_SCHEDULES: readonly QueueSchedule[] = [
  // §6.1 is more specific than §4 for this one: "cron(:05 hourly)", the
  // scheduled-capture hot path. Five past the hour, not on it — the tick
  // reads a watermark the hourly rollup writes.
  { queue: "capture.plan", cron: "5 * * * *", statedAs: "scheduler cron, API · §6.1 cron(:05 hourly)" },
  { queue: "rollup.metric_daily", cron: "0 * * * *", statedAs: "cron hourly, parse" },
  { queue: "attribution.rollup", cron: "0 * * * *", statedAs: "cron hourly, ingest watermark" },
  { queue: "credit.reconcile", cron: "*/10 * * * *", statedAs: "cron every 10 min" },

  // ⚠ NOT FROM §4 AT ALL — from `security-and-tenancy.md` §12, "a verifier job
  // re-walks each chain daily and pages on the first mismatch". §4's table has
  // no audit queue, so this cadence comes from the security reference and the
  // queue is an explicit addition (see `topology.ts`). 02:40 UTC: the same
  // quiet window as the partition tick, forty minutes earlier so the two
  // estate-wide walks do not contend for the same connections.
  { queue: "audit.verify", cron: "40 2 * * *", statedAs: "security-and-tenancy.md §12: verifier re-walks each chain daily" },

  // ⚠ NOT FROM §4 EITHER — STORY-173's stale-unverified-account sweep, daily by
  // owner decision (2026-10-05). 02:50 UTC: the same quiet window as the audit
  // verifier (02:40) and the partition tick (03:20), ten minutes after the
  // former so the two do not contend for connections; :50 and not :00 for the
  // reason §6.1 gives `capture.plan` :05. The job is idempotent and cheap when
  // nothing is stale, so a missed day costs nothing the next day does not cure.
  { queue: "identity.sweep_unverified", cron: "50 2 * * *", statedAs: "STORY-173: sweep stale unverified accounts daily" },

  // ⚠ NOT FROM §4 — STORY-076 AC4 / STORY-071 AC10. Two credit jobs that existed with no caller: FIFO expiry of
  // purchased credits and the nightly purge of daily counters. The data model says "nightly" for the purge and no
  // reference gives expiry a cadence (twelve-month granularity makes a day immaterial). THE HOUR IS A CHOICE, NOT A
  // TRANSCRIPTION — the very thing this file's header warns about — made for the same reason as the rows around it:
  // 02:30 UTC is in the same quiet window as `audit.verify` (02:40) and the partition tick (03:20), ten minutes
  // before the audit walk so the two estate-wide scans do not contend for connections. The owner can move it.
  { queue: "credit.housekeeping", cron: "30 2 * * *", statedAs: "STORY-076 AC4 / STORY-071 AC10: expire purchased credits and purge daily counters, daily" },

  // ⚠ NOT FROM §4 — STORY-077 R4 / STORY-013, `data-model.md` §7 ("nightly"). 03:40 UTC: after the partition tick
  // (03:20) so the two do not contend for the same locks, and a chosen hour for the reason above. SCHEDULED IS NOT
  // ENABLED: the handler is a no-op unless `RETENTION_PURGE_ENABLED=true`. See `handlers/retention-purge.handler.ts`.
  { queue: "retention.purge", cron: "40 3 * * *", statedAs: "STORY-077 R4 / STORY-013, data-model.md §7: retention purge nightly (handler gated by RETENTION_PURGE_ENABLED, default off)" },

  // ⚠ PERIOD STATED, TIME NOT. Scheduling these needs an hour of the day (and
  // for weekly, a day) that no reference gives. Left null deliberately — see
  // this file's header. `maintenance.partition` was here until STORY-142; it
  // left because the cost of NOT running it is dated and rising, which is a
  // reason to choose an hour rather than to keep waiting for one.
  //
  // ⚠ STORY-140 AC11 — THE HOURS ARE NOW CHOSEN, by the owner (decisions-2026-10-14), UTC. They are decisions and not
  // transcriptions of §4. A ROW HERE STILL IS NOT A TICK: all three queues are tenant-scoped and none has a handler, so
  // `schedule-registrar.ts` refuses them (inert) until a per-project sweep producer and a handler exist. The cron waits
  // here so the hour is not re-litigated when that lands.
  { queue: "geo.analyze", cron: "0 3 * * *", statedAs: "cron daily, API · STORY-140: daily 03:00 UTC (owner decision)" },
  { queue: "gsc.sync", cron: "0 4 * * *", statedAs: "cron daily, API · STORY-140: daily 04:00 UTC (owner decision)" },
  { queue: "topic.cluster", cron: "0 5 * * 0", statedAs: "prompt-set change >= 10%, cron weekly · STORY-140: Sunday 05:00 UTC (owner decision)" },
  // ⚠ DAILY, WHERE §4 SAYS MONTHLY — A DECISION, NOT A TRANSCRIPTION, and the
  // one place in this table where the cron does not follow the reference.
  //
  // ⚠ AND THE TICK RUNS ONLY THE RUNWAY HALF. `maintenance-partition.handler.ts`
  // calls `runPartitionRunwayMaintenance`, not `runMonthlyMaintenance`: the
  // destructive parts (cold-tier moves, detach/drop past retention, vector
  // index rebuilds) stay operator-invoked. The drop cutoff is the MINIMUM
  // retention across ACTIVE workspaces, so one reversible soft-delete
  // collapses it platform-wide — at monthly there was up to a month to notice
  // and revert; at daily the next tick drops, and a dropped partition does not
  // come back. The two halves were never one cadence, only one function.
  //
  // The runway half is idempotent and costs almost nothing when there is
  // nothing to do: `computePartitionMonths` creates only the missing months.
  // Monthly gives it ONE attempt per month, so a single failed run is not
  // discovered until rows are already in the default partition — and by then
  // the fix is no longer "create a partition", it is "move rows out from under
  // a lock first", which is strictly worse and grows daily. Daily means a
  // failure costs nothing because tomorrow retries and the lead window absorbs
  // the gap. The cadence §4 names is the RESOLUTION of the work (a month's
  // partition), not the frequency at which it is safe to check.
  //
  // 03:20 UTC: a low-traffic window for DDL that takes locks, and :20 rather
  // than :00 for the reason §6.1 gives `capture.plan` :05 — the top of the
  // hour is where everything else lands.
  { queue: "maintenance.partition", cron: "20 3 * * *", statedAs: "cron monthly (scheduled daily — see above)" },

  // ⚠ ON DEMAND ONLY, BY OWNER DECISION (STORY-140 AC11, decisions-2026-10-14). §4 says "API, cron" with no period;
  // the answer is that there is no fixed cron. These two stay `null` on purpose and `schedule.spec.ts` pins it, so a
  // cron cannot be added silently — adding one needs a new decision, not an edit.
  { queue: "crawl.audit", cron: null, statedAs: "API, cron · STORY-140: on demand only, no fixed cron (owner decision)" },
  { queue: "report.build", cron: null, statedAs: "API, cron · STORY-140: on demand only, no fixed cron (owner decision)" },
];

/** Every queue in the schedule table must be a queue that exists. */
const TOPOLOGY_NAMES = new Set(QUEUE_TOPOLOGY.map((entry) => entry.name));
for (const schedule of QUEUE_SCHEDULES) {
  if (!TOPOLOGY_NAMES.has(schedule.queue)) {
    throw new Error(`queue schedule references "${schedule.queue}", which is not in QUEUE_TOPOLOGY`);
  }
}

/** The schedules that carry a usable cron expression. */
export function datedSchedules(): QueueSchedule[] {
  return QUEUE_SCHEDULES.filter((schedule) => schedule.cron !== null);
}

/** Schedules whose cadence the references state as a period without a time. */
export function undatedSchedules(): QueueSchedule[] {
  return QUEUE_SCHEDULES.filter((schedule) => schedule.cron === null);
}

export function scheduleFor(queue: string): QueueSchedule | undefined {
  return QUEUE_SCHEDULES.find((schedule) => schedule.queue === queue);
}
