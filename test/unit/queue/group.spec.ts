import { describe, expect, it } from "vitest";
import { WORKER_GROUPS } from "../../../src/config/env.schema.js";
import { queuesForGroup, UnknownWorkerGroupError } from "../../../src/lib/queue/group.js";
import { QUEUE_TOPOLOGY, QUEUE_WORKER_GROUPS } from "../../../src/lib/queue/topology.js";

// STORY-030 T9 (RED step) — AC "The worker entry point selects its queue
// group by configuration, so one image serves every worker group." Per-
// group membership transcribed by hand from architecture reference §4
// (same table topology.spec.ts pins), so this file does not merely check
// "whatever topology.ts groups things into" — it re-derives the expected
// membership independently.

const EXPECTED_GROUP_MEMBERSHIP: Record<string, string[]> = {
  capture: ["capture.plan", "capture.execute", "lookup.execute"],
  parse: ["capture.parse", "capture.arbitrate"],
  crawl: ["crawl.discover", "crawl.fingerprint", "crawl.audit", "gsc.sync", "source.verify_presence", "domain.reverify"],
  embed: ["embed.batch", "topic.cluster"],
  rollup: [
    "rollup.metric_daily",
    "displacement.detect",
    "geo.analyze",
    "task.generate",
    "attribution.rollup",
    "credit.reconcile",
    "notify.dispatch",
    "maintenance.partition",
    // STORY-143 — not in §4; see ADDED_BEYOND_REFERENCE in topology.spec.ts.
    "audit.verify",
    // STORY-173 — not in §4 either; see ADDED_BEYOND_REFERENCE.
    "identity.sweep_unverified",
    // NEW-D-7 — not in §4 either; see ADDED_BEYOND_REFERENCE.
    "billing.auto_topup",
    // STORY-021 (ownership transfer) — not in §4 either; see ADDED_BEYOND_REFERENCE.
    "billing.customer_email",
    // STORY-076 AC4 / STORY-071 AC10 and STORY-077 R4 — not in §4 either; see ADDED_BEYOND_REFERENCE.
    "credit.housekeeping",
    "retention.purge",
  ],
  report: ["report.build"],
  deploy: ["deploy.cms"],
};

describe("STORY-030 · queuesForGroup — the worker entry point's queue-group selection", () => {
  it.each(Object.entries(EXPECTED_GROUP_MEMBERSHIP))("group %s owns exactly its documented queues", (group, expectedNames) => {
    const names = queuesForGroup(group as never).map((entry) => entry.name).sort();
    expect(names).toEqual([...expectedNames].sort());
  });

  it("throws UnknownWorkerGroupError for a group with no queues", () => {
    expect(() => queuesForGroup("not-a-real-group" as never)).toThrow(UnknownWorkerGroupError);
  });

  it("partitions every queue across the 7 groups with no overlap and no gap", () => {
    const allNames = Object.values(EXPECTED_GROUP_MEMBERSHIP)
      .flat()
      .sort();
    const fromTopology = QUEUE_TOPOLOGY.map((entry) => entry.name).sort();
    expect(allNames).toEqual(fromTopology);
    expect(allNames).toHaveLength(QUEUE_TOPOLOGY.length);
  });

  it("one worker image serves every group — WORKER_GROUP config accepts exactly the set of groups that own queues, including deploy", () => {
    expect([...WORKER_GROUPS].sort()).toEqual([...QUEUE_WORKER_GROUPS].sort());
  });

  // STORY-030 Phase C — boundary case: "queuesForGroup for a WORKER_GROUP
  // with zero queues assigned to it." Verified against the documented
  // membership above (not just topology.ts's own grouping, which could be
  // wrong the same way): every one of the 7 groups owns at least one
  // queue, so bootstrapWorker's "0 queues wired, autorun never pulls a
  // job, but the process still starts and does nothing" path has no real
  // WORKER_GROUP value that reaches it today. This test is the guard that
  // would turn red the day a topology edit ever left a group empty.
  it("every one of the 7 worker groups owns at least one queue — no group is empty", () => {
    for (const group of QUEUE_WORKER_GROUPS) {
      expect(queuesForGroup(group).length).toBeGreaterThan(0);
    }
  });
});
