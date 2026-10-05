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
  "maintenance.partition": { cron: null }, // "cron monthly" — see DELIBERATE_DIVERGENCE
  // No period at all.
  "crawl.audit": { cron: null }, // "API, cron"
  "report.build": { cron: null }, // "API, cron"
};

/**
 * ⚠ THE ONE PLACE THE TABLE DOES NOT FOLLOW §4, named here so it stays one
 * place. §4 says "cron monthly" for `maintenance.partition`, which states a
 * RESOLUTION (a month's partition) rather than a safe checking frequency.
 * STORY-142 schedules it daily because the job is idempotent and nearly free
 * when there is nothing to do, while a missed monthly run is not discovered
 * until rows are already in the default partition — at which point the remedy
 * stops being "create a partition" and becomes "move rows out under a lock".
 *
 * A divergence belongs in a list with a reason, not in a diff nobody reads.
 */
const DELIBERATE_DIVERGENCE: Record<string, { cron: string; because: string }> = {
  "maintenance.partition": {
    cron: "20 3 * * *",
    because:
      "§4's monthly is the work's resolution, not a safe check frequency; a missed run is only found once rows are in DEFAULT. " +
      "The tick runs the RUNWAY half only — detect stranded rows, create the coming months. The destructive half " +
      "(cold-tier moves, detach/drop past retention, vector rebuilds) stays operator-invoked via `pnpm db:maintenance:run`, " +
      "because the drop cutoff is the MINIMUM retention across active workspaces: one reversible soft-delete collapses it " +
      "platform-wide, and at a daily cadence the next tick would drop partitions that monthly gave a month to notice.",
  },
};

/**
 * ⚠ SCHEDULES WHOSE CADENCE COMES FROM A DIFFERENT REFERENCE THAN §4, kept
 * separate for the same reason the topology keeps its additions separate: the
 * §4 transcription above must stay quotable.
 */
const FROM_OTHER_REFERENCES: Record<string, { cron: string; section: string; source: string }> = {
  "audit.verify": {
    cron: "40 2 * * *",
    section: "§12",
    source: "security-and-tenancy.md §12 — a verifier job re-walks each chain daily and pages on the first mismatch",
  },
  "identity.sweep_unverified": {
    cron: "50 2 * * *",
    section: "STORY-173",
    source: "STORY-173 (owner decision, 2026-10-05) — the stale-unverified-account sweep runs daily",
  },
};

describe("G12 · the schedule table matches the reference", () => {
  it("covers §4's cron queues exactly, plus the ones another reference asks for", () => {
    expect(QUEUE_SCHEDULES.map((s) => s.queue).sort()).toEqual(
      [...Object.keys(REFERENCE), ...Object.keys(FROM_OTHER_REFERENCES)].sort(),
    );
  });

  it("⚠ every schedule not from §4 names the reference it IS from", () => {
    for (const [queue, entry] of Object.entries(FROM_OTHER_REFERENCES)) {
      expect(scheduleFor(queue)?.cron, queue).toBe(entry.cron);
      // The table's own `statedAs` must carry the provenance, so a reader of
      // the source is not left assuming §4 said something it does not.
      expect(scheduleFor(queue)?.statedAs, queue).toContain(entry.section);
      expect(entry.source.length).toBeGreaterThan(40);
    }
  });

  it("carries the cron expression the reference states, or null where it states none", () => {
    for (const [queue, expected] of Object.entries(REFERENCE)) {
      const divergence = DELIBERATE_DIVERGENCE[queue];
      expect(scheduleFor(queue)?.cron, queue).toBe(divergence?.cron ?? expected.cron);
    }
  });

  it("⚠ diverges from the reference in exactly one place, and that place carries a reason", () => {
    // The count is the assertion. A second divergence appearing without a line
    // in `DELIBERATE_DIVERGENCE` means somebody edited a cron rather than
    // deciding one.
    const diverging = Object.keys(REFERENCE).filter((queue) => scheduleFor(queue)?.cron !== REFERENCE[queue]!.cron);
    expect(diverging).toEqual(Object.keys(DELIBERATE_DIVERGENCE));
    for (const entry of Object.values(DELIBERATE_DIVERGENCE)) {
      expect(entry.because.length).toBeGreaterThan(40);
    }
    // And the table itself records that it is not quoting §4 here.
    expect(scheduleFor("maintenance.partition")?.statedAs).toContain("scheduled daily");
  });

  it("⚠ every scheduled queue exists in the topology", () => {
    const names = new Set(QUEUE_TOPOLOGY.map((entry) => entry.name));
    for (const schedule of QUEUE_SCHEDULES) expect(names.has(schedule.queue), schedule.queue).toBe(true);
  });

  it("⚠ five cron queues still state no time, and say so rather than being guessed at", () => {
    // The count is the point: five cron queues cannot be scheduled from the
    // references as written, and that gap belongs in a test rather than in
    // somebody's memory. It was six until STORY-142 chose an hour for
    // `maintenance.partition` — chose, and wrote down why. The dated count is
    // 7 since STORY-173 added `identity.sweep_unverified`, which is dated by
    // owner decision and not one of the five.
    expect(datedSchedules()).toHaveLength(7);
    expect(undatedSchedules()).toHaveLength(5);
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

  it("⚠ exactly the four of the twelve that can actually be driven by a bare tick today, and each refusal has a distinct reason", () => {
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
    // forever. This test is the arithmetic written down: 12 − 5 − 2 − 1 = 4.
    const dated = datedSchedules().map((s) => s.queue);
    const inert = dated.filter((queue) => handlerFor(queue) === undefined);
    const tenantScoped = dated.filter((queue) => handlerFor(queue) !== undefined && topologyFor(queue).tenantScoped);
    const schedulable = dated.filter((queue) => handlerFor(queue) !== undefined && !topologyFor(queue).tenantScoped);

    expect(inert.sort()).toEqual(["attribution.rollup", "capture.plan"]);
    expect(tenantScoped.sort()).toEqual(["rollup.metric_daily"]);
    expect(schedulable.sort()).toEqual(["audit.verify", "credit.reconcile", "identity.sweep_unverified", "maintenance.partition"]);
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
    expect(describeSchedules(empty)).toContain("7 of 12 cron queues state a time");
  });
});
