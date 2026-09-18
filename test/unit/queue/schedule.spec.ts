import { describe, expect, it } from "vitest";
import { handlerFor, inertQueueNames } from "../../../src/lib/queue/handlers.js";
import { QUEUE_SCHEDULES, datedSchedules, scheduleFor, undatedSchedules } from "../../../src/lib/queue/schedule.js";
import { QUEUE_TOPOLOGY } from "../../../src/lib/queue/topology.js";

// G12 — an independently hand-transcribed pin against
// `system-architecture.md` §4's producer column and §6.1, the same way
// topology.spec.ts pins the topology. A typo in `schedule.ts` fails against
// this second transcription rather than only against itself.
//
// Read off §4 by hand, queue by queue. The ten that say "cron" anywhere:
const REFERENCE: Record<string, { cron: string | null }> = {
  // §6.1 "cron(:05 hourly)" — more specific than §4's bare "scheduler cron".
  "capture.plan": { cron: "5 * * * *" },
  "rollup.metric_daily": { cron: "0 * * * *" }, // "cron hourly, parse"
  "attribution.rollup": { cron: "0 * * * *" }, // "cron hourly, ingest watermark"
  "credit.reconcile": { cron: "*/10 * * * *" }, // "cron every 10 min"
  // A period with no time of day. §4 gives no hour, and inventing one picks
  // an off-peak window nobody decided.
  "geo.analyze": { cron: null }, // "cron daily, API"
  "gsc.sync": { cron: null }, // "cron daily, API"
  "topic.cluster": { cron: null }, // "cron weekly"
  "maintenance.partition": { cron: null }, // "cron monthly"
  // No period at all.
  "crawl.audit": { cron: null }, // "API, cron"
  "report.build": { cron: null }, // "API, cron"
};

describe("G12 · the schedule table matches the reference", () => {
  it("covers exactly the queues whose producer names a cron, and no others", () => {
    expect(QUEUE_SCHEDULES.map((s) => s.queue).sort()).toEqual(Object.keys(REFERENCE).sort());
  });

  it("carries the cron expression the reference states, or null where it states none", () => {
    for (const [queue, expected] of Object.entries(REFERENCE)) {
      expect(scheduleFor(queue)?.cron, queue).toBe(expected.cron);
    }
  });

  it("⚠ every scheduled queue exists in the topology", () => {
    const names = new Set(QUEUE_TOPOLOGY.map((entry) => entry.name));
    for (const schedule of QUEUE_SCHEDULES) expect(names.has(schedule.queue), schedule.queue).toBe(true);
  });

  it("⚠ states a time for exactly four of the ten, and says so rather than guessing", () => {
    // The count is the point: six cron queues cannot be scheduled from the
    // references as written, and that gap belongs in a test rather than in
    // somebody's memory.
    expect(datedSchedules()).toHaveLength(4);
    expect(undatedSchedules()).toHaveLength(6);
  });

  it("⚠ never invents an hour — no undated schedule carries a cron", () => {
    for (const schedule of undatedSchedules()) {
      expect(schedule.cron, schedule.queue).toBeNull();
      // And each records what the reference actually said, so the next reader
      // can see why it is null.
      expect(schedule.statedAs.length).toBeGreaterThan(0);
    }
  });

  it("⚠ records which dated queues are still inert, so the gap is visible", () => {
    // `capture.plan` and `attribution.rollup` have a cron and NO handler.
    // They are in the table on purpose — they light up the moment a handler
    // lands — but nothing schedules them today, and that must not be a
    // surprise discovered in production.
    const datedAndInert = datedSchedules()
      .map((s) => s.queue)
      .filter((queue) => handlerFor(queue) === undefined);

    expect(datedAndInert.sort()).toEqual(["attribution.rollup", "capture.plan"]);
    expect(inertQueueNames()).toEqual(expect.arrayContaining(datedAndInert));
  });
});
