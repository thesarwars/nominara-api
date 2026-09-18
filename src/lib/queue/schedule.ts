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

  // ⚠ PERIOD STATED, TIME NOT. Scheduling these needs an hour of the day (and
  // for weekly, a day; for monthly, a date) that no reference gives. Left
  // null deliberately — see this file's header.
  { queue: "geo.analyze", cron: null, statedAs: "cron daily, API" },
  { queue: "gsc.sync", cron: null, statedAs: "cron daily, API" },
  { queue: "topic.cluster", cron: null, statedAs: "prompt-set change >= 10%, cron weekly" },
  { queue: "maintenance.partition", cron: null, statedAs: "cron monthly" },

  // ⚠ NO CADENCE AT ALL. §4 says "cron" without a period; both are also
  // API-triggered, so the cron half may not be a fixed schedule so much as a
  // sweep whose trigger nobody has written down.
  { queue: "crawl.audit", cron: null, statedAs: "API, cron" },
  { queue: "report.build", cron: null, statedAs: "API, cron" },
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
