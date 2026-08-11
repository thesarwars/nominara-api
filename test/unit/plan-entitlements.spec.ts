import { describe, expect, it } from "vitest";
import { planEntitlementsSchema } from "../../contracts/entitlements/plan-entitlements.schema.js";
import { ENTITLEMENT_KEYS, PLAN_CATALOG, PLAN_ENTITLEMENTS } from "../../src/db/seed/plan-entitlements.js";

describe("STORY-007 · plan entitlements seed matches its zod schema", () => {
  it("has exactly the five tiers from plans-and-entitlements.md §2", () => {
    expect(Object.keys(PLAN_ENTITLEMENTS).sort()).toEqual(
      ["business", "enterprise", "free", "growth", "starter"].sort(),
    );
  });

  it("every tier validates against the schema — the acceptance criterion, not just presence", () => {
    for (const [tier, entitlements] of Object.entries(PLAN_ENTITLEMENTS)) {
      const result = planEntitlementsSchema.safeParse(entitlements);
      expect(result.success, `${tier} failed schema validation: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it("every tier carries every one of the 45 matrix keys, none missing, none extra", () => {
    for (const [tier, entitlements] of Object.entries(PLAN_ENTITLEMENTS)) {
      expect(Object.keys(entitlements).sort(), tier).toEqual([...ENTITLEMENT_KEYS].sort());
    }
    expect(ENTITLEMENT_KEYS.length).toBe(45);
  });

  it("the schema rejects an unknown entitlement key (pins the key set, per its documented scope)", () => {
    const withTypo = { ...PLAN_ENTITLEMENTS.free, "projects.maxx": 1 };
    expect(planEntitlementsSchema.safeParse(withTypo).success).toBe(false);
  });

  it("the schema rejects a tier missing a required key", () => {
    const { "projects.max": _omitted, ...incomplete } = PLAN_ENTITLEMENTS.free;
    expect(planEntitlementsSchema.safeParse(incomplete).success).toBe(false);
  });

  it("spot-checks numeric constants against the reference matrix exactly", () => {
    // Regression guard against the "plausible-looking neighbour" failure mode
    // — these are transcribed by hand and worth pinning individually.
    expect(PLAN_ENTITLEMENTS.free["credits.included_per_cycle"]).toBe(60);
    expect(PLAN_ENTITLEMENTS.starter["credits.included_per_cycle"]).toBe(450);
    expect(PLAN_ENTITLEMENTS.growth["credits.included_per_cycle"]).toBe(1200);
    expect(PLAN_ENTITLEMENTS.business["credits.included_per_cycle"]).toBe(3000);
    expect(PLAN_ENTITLEMENTS.free["projects.max"]).toBe(0);
    expect(PLAN_ENTITLEMENTS.growth["projects.max"]).toBe(3);
    expect(PLAN_ENTITLEMENTS.business["seats.max"]).toBe(20);
    expect(PLAN_ENTITLEMENTS.free["credits.lookups_per_day_max"]).toBe(3);
    expect(PLAN_ENTITLEMENTS.free["credits.nlp_parses_per_day_max"]).toBe(20);
    expect(PLAN_ENTITLEMENTS.business["fair_use.captures_per_cycle"]).toBe(22000);
  });

  it("PLAN_CATALOG has one row per plan key with prices matching the entitlement matrix", () => {
    expect(PLAN_CATALOG.map((p) => p.key).sort()).toEqual(["business", "enterprise", "free", "growth", "starter"]);
    for (const plan of PLAN_CATALOG) {
      if (plan.key === "enterprise") continue; // "custom" pricing, not a number in the matrix
      expect(plan.monthlyPrice).toBe(PLAN_ENTITLEMENTS[plan.key]["price.monthly_usd"]);
      expect(plan.creditsPerCycle).toBe(PLAN_ENTITLEMENTS[plan.key]["credits.included_per_cycle"]);
    }
  });
});
