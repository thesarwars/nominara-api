import { describe, expect, it } from "vitest";
import { addonContributions, mergeEntitlements } from "../../src/lib/entitlements/resolution.js";
import { PLAN_ENTITLEMENTS } from "../../src/db/seed/plan-entitlements.js";

// STORY-069 AC3/AC9 — the cases the integration suite structurally cannot
// reach, because they are about tiers that cannot buy the add-on in question.
// §8 sells the extra-project add-on on Growth and Business only, so no real
// Enterprise workspace can hold one; the guard that makes that safe still has
// to be correct, because §2 says the matrix is data and may be edited without
// a redeploy.

describe("STORY-069 · add-on contributions against non-numeric ceilings", () => {
  it("adds nothing to an unlimited ceiling rather than turning it into a number", () => {
    const enterprise = PLAN_ENTITLEMENTS.enterprise;
    // Enterprise carries "custom" for projects.max, "uncapped" for
    // prompts.max_total and "unlimited" for seats.max.
    expect(typeof enterprise["projects.max"]!.value).toBe("string");

    const contributions = addonContributions(enterprise, { extra_project: 1, extra_seat: 2 });

    expect(contributions).toEqual({});
  });

  it("leaves an unlimited ceiling reading as unlimited after the merge", () => {
    const resolved = mergeEntitlements(PLAN_ENTITLEMENTS.enterprise, { extra_seat: 5 }, {});

    expect(resolved["seats.max"]).toEqual({
      value: "unlimited",
      live: true,
      source: "plan",
      plan_value: "unlimited",
    });
  });

  it("an extra project on a tier with no per-project prompt cap still grants the project slot", () => {
    // Starter is the shape that matters if the matrix is ever edited to sell
    // the add-on lower: prompts.max_per_project is a number there, but a tier
    // where it is null must still get its project slot rather than nothing.
    const withoutPerProject = {
      ...PLAN_ENTITLEMENTS.growth,
      "prompts.max_per_project": { value: null, live: true },
    };

    const contributions = addonContributions(withoutPerProject, { extra_project: 1 });

    expect(contributions["projects.max"]).toBe(4);
    expect(contributions["prompts.max_total"]).toBeUndefined();
  });

  it("zero and negative quantities contribute nothing", () => {
    expect(addonContributions(PLAN_ENTITLEMENTS.growth, { extra_project: 0 })).toEqual({});
    expect(addonContributions(PLAN_ENTITLEMENTS.growth, {})).toEqual({});
  });
});
