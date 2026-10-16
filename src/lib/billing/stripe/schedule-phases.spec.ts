import { describe, expect, it } from "vitest";
import { buildTwoPhaseSchedule, phaseLinesOf } from "./schedule-phases.js";

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
