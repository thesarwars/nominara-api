import { describe, expect, it } from "vitest";
import { planEntitlementsSchema } from "../../contracts/entitlements/plan-entitlements.schema.js";
import {
  ENTITLEMENT_KEYS,
  NOT_LIVE_KEYS,
  PLAN_CATALOG,
  PLAN_ENTITLEMENTS,
} from "../../src/db/seed/plan-entitlements.js";

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

  it("every tier carries every one of the 50 keys, none missing, none extra", () => {
    for (const [tier, entitlements] of Object.entries(PLAN_ENTITLEMENTS)) {
      expect(Object.keys(entitlements).sort(), tier).toEqual([...ENTITLEMENT_KEYS].sort());
    }
    // 45 from §2's matrix, plus the 5 from its "not live in v1" table, which
    // exist so the plan shape is settled before the features land.
    expect(ENTITLEMENT_KEYS.length).toBe(50);
  });

  it("the schema rejects an unknown entitlement key (pins the key set, per its documented scope)", () => {
    const withTypo = { ...PLAN_ENTITLEMENTS.free, "projects.maxx": { value: 1, live: true } };
    expect(planEntitlementsSchema.safeParse(withTypo).success).toBe(false);
  });

  it("the schema rejects a tier missing a required key", () => {
    const { "projects.max": _omitted, ...incomplete } = PLAN_ENTITLEMENTS.free;
    expect(planEntitlementsSchema.safeParse(incomplete).success).toBe(false);
  });

  it("spot-checks numeric constants against the reference matrix exactly", () => {
    // Regression guard against the "plausible-looking neighbour" failure mode
    // — these are transcribed by hand and worth pinning individually.
    expect(PLAN_ENTITLEMENTS.free["credits.included_per_cycle"]!.value).toBe(60);
    expect(PLAN_ENTITLEMENTS.starter["credits.included_per_cycle"]!.value).toBe(450);
    expect(PLAN_ENTITLEMENTS.growth["credits.included_per_cycle"]!.value).toBe(1200);
    expect(PLAN_ENTITLEMENTS.business["credits.included_per_cycle"]!.value).toBe(3000);
    expect(PLAN_ENTITLEMENTS.free["projects.max"]!.value).toBe(0);
    expect(PLAN_ENTITLEMENTS.growth["projects.max"]!.value).toBe(3);
    expect(PLAN_ENTITLEMENTS.business["seats.max"]!.value).toBe(20);
    expect(PLAN_ENTITLEMENTS.free["credits.lookups_per_day_max"]!.value).toBe(3);
    expect(PLAN_ENTITLEMENTS.free["credits.nlp_parses_per_day_max"]!.value).toBe(20);
    expect(PLAN_ENTITLEMENTS.business["fair_use.captures_per_cycle"]!.value).toBe(22000);
  });

  // ── STORY-069 AC1 — the live flag ──────────────────────────────────────

  it("every key on every tier carries a live flag", () => {
    for (const [tier, entitlements] of Object.entries(PLAN_ENTITLEMENTS)) {
      for (const [key, entitlement] of Object.entries(entitlements)) {
        expect(typeof entitlement.live, `${tier}.${key}`).toBe("boolean");
      }
    }
  });

  it("exactly §2's not-live keys are flagged, on every tier", () => {
    for (const [tier, entitlements] of Object.entries(PLAN_ENTITLEMENTS)) {
      const notLive = Object.entries(entitlements)
        .filter(([, entitlement]) => !entitlement.live)
        .map(([key]) => key)
        .sort();
      expect(notLive, tier).toEqual([...NOT_LIVE_KEYS].sort());
    }
  });

  // THE CASE THAT MAKES THE FLAG PER KEY RATHER THAN A LIST OF UNBUILT
  // FEATURES. `whitelabel.custom_domain` is a real matrix row — granted on
  // Business and Enterprise — and simultaneously not live ("live at launch +
  // 30 days"). A consumer reading only the value would advertise it.
  it("a key can be granted and still not be live", () => {
    const granted = PLAN_ENTITLEMENTS.business["whitelabel.custom_domain"]!;
    expect(granted.value, "Business genuinely grants it").toBe(true);
    expect(granted.live, "and it is still not live in v1").toBe(false);
  });

  it("the deferred keys carry no invented value", () => {
    for (const key of ["integrations.slack", "integrations.mcp", "exports.bi_ports", "sso.saml"]) {
      for (const tier of Object.keys(PLAN_ENTITLEMENTS) as (keyof typeof PLAN_ENTITLEMENTS)[]) {
        expect(PLAN_ENTITLEMENTS[tier][key]!.value, `${tier}.${key}`).toBeNull();
        expect(PLAN_ENTITLEMENTS[tier][key]!.live, `${tier}.${key}`).toBe(false);
      }
    }
  });

  it("the schema rejects a key that is missing its live flag", () => {
    const unflagged = { ...PLAN_ENTITLEMENTS.free, "projects.max": { value: 0 } };
    expect(planEntitlementsSchema.safeParse(unflagged).success).toBe(false);
  });

  it("PLAN_CATALOG has one row per plan key with prices matching the entitlement matrix", () => {
    expect(PLAN_CATALOG.map((p) => p.key).sort()).toEqual(["business", "enterprise", "free", "growth", "starter"]);
    for (const plan of PLAN_CATALOG) {
      if (plan.key === "enterprise") continue; // "custom" pricing, not a number in the matrix
      expect(plan.monthlyPrice).toBe(PLAN_ENTITLEMENTS[plan.key]!["price.monthly_usd"]!.value);
      expect(plan.creditsPerCycle).toBe(PLAN_ENTITLEMENTS[plan.key]!["credits.included_per_cycle"]!.value);
    }
  });
});
