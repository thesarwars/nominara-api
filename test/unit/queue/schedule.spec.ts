import { describe, expect, it } from "vitest";
import { handlerFor, inertQueueNames } from "../../../src/lib/queue/handlers.js";
import { QUEUE_SCHEDULES, datedSchedules, scheduleFor, undatedSchedules } from "../../../src/lib/queue/schedule.js";
import { QUEUE_TOPOLOGY, topologyFor } from "../../../src/lib/queue/topology.js";
import { describeSchedules } from "../../../src/lib/queue/schedule-registrar.js";

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

  it("⚠ exactly ONE of the ten can actually be driven by a bare tick today, and each refusal has a distinct reason", () => {
    // ⚠ A ROW IN THE TABLE IS NOT A QUEUE THAT TICKS, and the first cut of
    // this work conflated the two. The table records what §4 SAYS; three
    // separate conditions decide what can run, and every one of them is
    // load-bearing:
    //
    //   a stated time      — six rows have a period and no hour
    //   a wired handler    — `capture.plan`, `attribution.rollup`
    //   not tenant-scoped  — `rollup.metric_daily`
    //
    // The last was missing, and it is the one that bites: `rollup.metric_daily`
    // has BOTH a cron and a handler, so a gate on those two alone scheduled
    // it, and a bare tick on a tenant-scoped queue throws in the signature
    // path before the handler is reached — once an hour, into the DLQ,
    // forever. This test is the arithmetic written down: 10 − 6 − 2 − 1 = 1.
    const dated = datedSchedules().map((s) => s.queue);
    const inert = dated.filter((queue) => handlerFor(queue) === undefined);
    const tenantScoped = dated.filter((queue) => handlerFor(queue) !== undefined && topologyFor(queue).tenantScoped);
    const schedulable = dated.filter((queue) => handlerFor(queue) !== undefined && !topologyFor(queue).tenantScoped);

    expect(inert.sort()).toEqual(["attribution.rollup", "capture.plan"]);
    expect(tenantScoped.sort()).toEqual(["rollup.metric_daily"]);
    expect(schedulable).toEqual(["credit.reconcile"]);
    // The three reasons partition the dated rows — no queue is refused twice
    // and none falls through unaccounted for.
    expect(inert.length + tenantScoped.length + schedulable.length).toBe(dated.length);
  });
});

describe("G12 · describeSchedules — the one line a boot log gets", () => {
  // Production code (`src/worker.ts` logs it at every boot) and the only
  // place an operator learns why a queue they expected to tick does not.
  const empty = { scheduled: [], skippedInert: [], skippedTenantScoped: [], removed: [], failed: [] };

  it("names what ticks, with its cadence", () => {
    const line = describeSchedules({ ...empty, scheduled: [{ queue: "credit.reconcile", cron: "*/10 * * * *" }] });
    expect(line).toContain("scheduled: credit.reconcile@*/10 * * * *");
  });

  it("says 'none' rather than going quiet when nothing ticks", () => {
    expect(describeSchedules(empty)).toContain("scheduled: none");
  });

  it("⚠ distinguishes the two refusals, because the remedies are different", () => {
    // "no handler" is waiting on a story; "tenant-scoped" is waiting on a
    // different KIND of producer and will never be fixed by wiring a handler.
    const line = describeSchedules({
      ...empty,
      skippedInert: ["capture.plan"],
      skippedTenantScoped: ["rollup.metric_daily"],
    });
    expect(line).toContain("inert (no handler), not scheduled: capture.plan");
    expect(line).toContain("tenant-scoped");
    expect(line).toContain("rollup.metric_daily");
  });

  it("⚠ surfaces a per-queue failure instead of swallowing it into a silent boot", () => {
    const line = describeSchedules({ ...empty, failed: [{ queue: "credit.reconcile", reason: "ECONNREFUSED" }] });
    expect(line).toContain("FAILED: credit.reconcile (ECONNREFUSED)");
  });

  it("reports the cadence gap so an operator need not go and read the table", () => {
    expect(describeSchedules(empty)).toContain("4 of 10 cron queues state a time");
  });
});
