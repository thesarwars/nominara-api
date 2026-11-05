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
  "geo.analyze": { cron: null }, // "cron daily, API" — hour chosen by STORY-140 AC11, see FROM_OWNER_HOURS
  "gsc.sync": { cron: null }, // "cron daily, API" — ditto
  "topic.cluster": { cron: null }, // "cron weekly" — ditto
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
      "(detach/drop past retention, vector rebuilds) stays operator-invoked via `pnpm db:maintenance:run`, " +
      "because the drop cutoff is the MINIMUM retention across active workspaces: one reversible soft-delete collapses it " +
      "platform-wide, and at a daily cadence the next tick would drop partitions that monthly gave a month to notice.",
  },
};

/**
 * ⚠ STORY-140 AC11 — the hours the owner chose (decisions-2026-10-14), UTC. §4 states a period and no time; these
 * three are decisions and not transcriptions, so they live beside the divergence list and not in REFERENCE.
 */
const FROM_OWNER_HOURS: Record<string, string> = {
  "geo.analyze": "0 3 * * *", // daily 03:00
  "gsc.sync": "0 4 * * *", // daily 04:00
  "topic.cluster": "0 5 * * 0", // weekly, Sunday 05:00
};

/** STORY-140 AC11 — on demand only, by owner decision. No cron, ever, without a new decision. */
const ON_DEMAND_ONLY = ["crawl.audit", "report.build"];

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
  "credit.verify": {
    cron: "45 2 * * *",
    section: "STORY-073 AC4 / NFR-CRD-03",
    source:
      "NFR-CRD-03 (a nightly job asserts the wallet equals its ledger replay and pages on mismatch) - the reference states no time of day; 02:45 UTC is a chosen quiet window, after credit.housekeeping (02:30) has written its expiry entries",
  },
  "credit.housekeeping": {
    cron: "30 2 * * *",
    section: "STORY-076 AC4 / STORY-071 AC10",
    source:
      "plans-and-entitlements.md §5 (purchased credits expire FIFO) and schemas/billing-and-credits.md (daily counters purged nightly) — " +
      "the references state no time of day; 02:30 UTC is a chosen quiet window",
  },
  "domain.reverify": {
    cron: "20 2 * * *",
    section: "STORY-048 AC7",
    source:
      "STORY-048 AC7 (owner decision 2026-10-19) — verified domains are re-verified daily; the references state no time of day, 02:20 UTC is a chosen quiet window",
  },
  "report.cleanup": {
    cron: "30 3 * * *",
    section: "STORY-180 r5",
    source:
      "STORY-180 r5 (owner decision 60 (b)) - delete expired and half-uploaded report files daily; the references state no time of day, 03:30 UTC is a chosen quiet window",
  },
  "task.resurface": {
    cron: "10 2 * * *",
    section: "STORY-064 AC5",
    source:
      "STORY-064 AC5 / schemas/tasks-and-goals.md (dismissed tasks return after resurface_at) — the references state no time of day; 02:10 UTC is a chosen quiet window",
  },
  "maintenance.integrity": {
    cron: "10 3 * * *",
    section: "STORY-013 AC6 / AC14 / AC16",
    source:
      "data-model.md §5 / §8 / §7 and STORY-013 — vector recall checked nightly, orphan scan nightly, purge failures alert; the references state " +
      "no time of day, 03:10 UTC is a chosen quiet window ahead of the 03:20 partition tick, and the tick is READ-ONLY (no DDL, no rebuild)",
  },
  "retention.purge": {
    cron: "40 3 * * *",
    section: "STORY-077 R4 / STORY-013",
    source:
      "data-model.md §7 — retention purge 'nightly'; 03:40 UTC is a chosen hour, and the handler is a no-op unless RETENTION_PURGE_ENABLED=true",
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
      expect(scheduleFor(queue)?.cron, queue).toBe(divergence?.cron ?? FROM_OWNER_HOURS[queue] ?? expected.cron);
    }
  });

  it("⚠ diverges from the reference in exactly one place, and that place carries a reason", () => {
    // The count is the assertion. A second divergence appearing without a line
    // in `DELIBERATE_DIVERGENCE` means somebody edited a cron rather than
    // deciding one.
    const diverging = Object.keys(REFERENCE).filter(
      (queue) => scheduleFor(queue)?.cron !== REFERENCE[queue]!.cron && !(queue in FROM_OWNER_HOURS),
    );
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

  it("STORY-140 AC11 · the owner's hours are registered in UTC: geo.analyze 03:00, gsc.sync 04:00, topic.cluster Sunday 05:00", () => {
    for (const [queue, cron] of Object.entries(FROM_OWNER_HOURS)) {
      expect(scheduleFor(queue)?.cron, queue).toBe(cron);
      expect(scheduleFor(queue)?.statedAs, queue).toContain("STORY-140");
    }
  });

  it("STORY-140 AC11 · crawl.audit and report.build are on demand only: no cron, and the pin fails if one is added", () => {
    for (const queue of ON_DEMAND_ONLY) {
      expect(scheduleFor(queue)?.cron, `${queue} must stay on demand — a cron needs a new owner decision`).toBeNull();
      expect(scheduleFor(queue)?.statedAs, queue).toContain("on demand only");
    }
    // The undated set is EXACTLY these two, so a third undated queue, or a dated one among them, fails here.
    expect(undatedSchedules().map((s) => s.queue).sort()).toEqual([...ON_DEMAND_ONLY].sort());
  });

  it("STORY-140 AC11 · seventeen of nineteen cron queues are dated, two are on demand", () => {
    // 9 dated before + geo.analyze, gsc.sync, topic.cluster, + domain.reverify (STORY-048 AC7) + task.resurface (STORY-064 AC5) + maintenance.integrity (STORY-013) + report.cleanup (STORY-180 r5) + credit.verify (STORY-073 AC4).
    expect(datedSchedules()).toHaveLength(17);
    expect(undatedSchedules()).toHaveLength(2);
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
    // `attribution.rollup` has a cron and NO handler (`capture.plan` was wired by NEW-A-10).
    // They are in the table on purpose — they light up the moment a handler
    // lands — but nothing schedules them today, and that must not be a
    // surprise discovered in production.
    const datedAndInert = datedSchedules()
      .map((s) => s.queue)
      .filter((queue) => handlerFor(queue) === undefined);

    // `topic.cluster` left this list with STORY-047: it has a handler now (and is tenant-scoped, so see the next test).
    expect(datedAndInert.sort()).toEqual(["attribution.rollup", "geo.analyze", "gsc.sync"]);
    expect(inertQueueNames()).toEqual(expect.arrayContaining(datedAndInert));
  });

  it("⚠ exactly the seven of the fifteen that can actually be driven by a bare tick today, and each refusal has a distinct reason", () => {
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
    // forever. This test is the arithmetic written down: 15 − 5 − 2 − 1 = 7.
    const dated = datedSchedules().map((s) => s.queue);
    const inert = dated.filter((queue) => handlerFor(queue) === undefined);
    const tenantScoped = dated.filter((queue) => handlerFor(queue) !== undefined && topologyFor(queue).tenantScoped);
    const schedulable = dated.filter((queue) => handlerFor(queue) !== undefined && !topologyFor(queue).tenantScoped);

    expect(inert.sort()).toEqual(["attribution.rollup", "geo.analyze", "gsc.sync"]);
    // STORY-047: `topic.cluster` has a handler and is tenant-scoped, so a bare tick is refused for it; its producer is the sweep.
    expect(tenantScoped.sort()).toEqual(["capture.plan", "rollup.metric_daily", "topic.cluster"]);
    expect(schedulable.sort()).toEqual([
      "audit.verify",
      "credit.housekeeping",
      "credit.reconcile",
      "credit.verify",
      "domain.reverify",
      "identity.sweep_unverified",
      "maintenance.integrity",
      "maintenance.partition",
      "report.cleanup",
      "retention.purge",
      "task.resurface",
    ]);
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
    expect(describeSchedules(empty)).toContain("17 of 19 cron queues state a time");
  });
});
