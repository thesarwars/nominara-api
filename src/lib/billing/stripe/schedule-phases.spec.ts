import { describe, expect, it } from "vitest";
import { buildTwoPhaseSchedule, currentPhaseIndex, isFinishedSchedule, phaseLinesOf } from "./schedule-phases.js";

// STORY-184 T3 — the ONE builder behind both a scheduled downgrade and a scheduled add-on removal.
//
// ⚠ A PHASE'S METADATA REPLACES THE SUBSCRIPTION'S AT THE CUT-OVER. A phase built without it strips `plan_key`
// from the subscription, and the webhook then ignores it ("not created by this product"). The removal path did
// exactly that; these tests are the reason it cannot again.

const META = { workspace_id: "ws-1", plan_key: "growth", billing_interval: "monthly" };
const current = { items: [{ price: "price_plan", quantity: 1 }, { price: "price_seat", quantity: 2 }], startDate: 100, endDate: 200, metadata: META };

describe("STORY-184 · buildTwoPhaseSchedule", () => {
  it("T3 · BOTH phases carry metadata, explicitly", () => {
    const built = buildTwoPhaseSchedule({
      current,
      next: { items: [{ price: "price_plan", quantity: 1 }], metadata: { ...META, plan_key: "starter", plan_change_intent_id: "i1" }, interval: "month" },
    });
    expect(built.phases[0]!.metadata).toEqual(META);
    expect(built.phases[1]!.metadata).toEqual({ ...META, plan_key: "starter", plan_change_intent_id: "i1" });
  });

  it("T3 · phase 0 runs to the period end unchanged; phase 1 is one cycle, never prorated, then the schedule releases", () => {
    const built = buildTwoPhaseSchedule({ current, next: { items: [{ price: "p2", quantity: 1 }], metadata: META, interval: "year" } });
    expect(built.end_behavior).toBe("release");
    expect(built.phases[0]).toMatchObject({ items: current.items, start_date: 100, end_date: 200, proration_behavior: "none" });
    expect(built.phases[1]).toMatchObject({ items: [{ price: "p2", quantity: 1 }], duration: { interval: "year", interval_count: 1 }, proration_behavior: "none" });
  });

  it("T3 · metadata is copied, not shared: mutating the result cannot reach the input", () => {
    const built = buildTwoPhaseSchedule({ current, next: { items: [], metadata: META, interval: "month" } });
    (built.phases[0]!.metadata as Record<string, string>).plan_key = "x";
    expect(current.metadata.plan_key).toBe("growth");
  });

  it("T3 · an empty metadata is passed as an empty object, never omitted (omitting is what stripped the keys)", () => {
    const built = buildTwoPhaseSchedule({ current: { ...current, metadata: {} }, next: { items: [], metadata: {}, interval: "month" } });
    expect(built.phases[0]).toHaveProperty("metadata", {});
    expect(built.phases[1]).toHaveProperty("metadata", {});
  });
});

describe("STORY-184 · phaseLinesOf", () => {
  it("reads a price id from a string or an object, and drops a line with no price", () => {
    expect(phaseLinesOf([{ price: "a", quantity: 1 }, { price: { id: "b" }, quantity: 3 }, { price: { id: "" } }, {}])).toEqual([
      { price: "a", quantity: 1 },
      { price: "b", quantity: 3 },
    ]);
  });
  it("keeps a line with no quantity as a line with no quantity (a metered price)", () => {
    expect(phaseLinesOf([{ price: "a" }])).toEqual([{ price: "a" }]);
  });
});

describe("STORY-184 · currentPhaseIndex", () => {
  const phases = [{ start_date: 100 }, { start_date: 200 }, { start_date: 300 }];
  it("is the phase the schedule is IN, not the first it ever had", () => {
    expect(currentPhaseIndex({ phases, current_phase: { start_date: 200 } })).toBe(1);
    expect(currentPhaseIndex({ phases, current_phase: { start_date: 300 } })).toBe(2);
  });
  it("null path - a schedule that has not started (no current phase), or one whose current phase matches none, is at the first", () => {
    expect(currentPhaseIndex({ phases, current_phase: null })).toBe(0);
    expect(currentPhaseIndex({ phases })).toBe(0);
    expect(currentPhaseIndex({ phases, current_phase: { start_date: 999 } })).toBe(0);
  });
});

describe("STORY-184 · isFinishedSchedule", () => {
  const base = { status: "active", end_behavior: "release", phases: [{ start_date: 1, metadata: {} }, { start_date: 2, metadata: { plan_change_intent_id: "i" } }], current_phase: { start_date: 2 } };
  it("is true for a last phase carrying our intent id", () => expect(isFinishedSchedule(base, "starter")).toBe(true));
  // The MAJOR of review round 2: `from_subscription` creates a ONE-phase schedule; a downgrade's update gives it its second. A lost reply
  // between the two leaves the one-phase schedule attached (with or without the subscription's metadata copied onto it), and it must NOT read
  // as finished - or the replay releases the very schedule it is completing.
  it.each([
    ["with the subscription's metadata copied onto it", { plan_key: "starter", workspace_id: "ws" }],
    ["carrying an intent id", { plan_change_intent_id: "i" }],
    ["with no metadata", {}],
  ])("is false for a ONE-phase from_subscription schedule %s", (_label, metadata) => {
    const onePhase = { status: "active", end_behavior: "release", phases: [{ start_date: 1, metadata }], current_phase: { start_date: 1 } };
    expect(isFinishedSchedule(onePhase, "starter")).toBe(false);
  });
  it("is false when the current phase is the FIRST of several (a downgrade not yet taken)", () => {
    expect(isFinishedSchedule({ ...base, current_phase: { start_date: 1 } }, "starter")).toBe(false);
  });
  it("is false when the schedule has not started (no current phase)", () => expect(isFinishedSchedule({ ...base, current_phase: null }, "starter")).toBe(false));
  it("is false for end_behavior cancel", () => expect(isFinishedSchedule({ ...base, end_behavior: "cancel" }, "starter")).toBe(false));
  it("is false when the phase metadata names a different plan and no intent", () => {
    const other = { ...base, phases: [base.phases[0]!, { start_date: 2, metadata: { plan_key: "growth" } }] };
    expect(isFinishedSchedule(other, "starter")).toBe(false);
    expect(isFinishedSchedule(other, "growth")).toBe(true);
  });
});
