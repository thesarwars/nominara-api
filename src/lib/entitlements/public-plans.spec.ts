import { describe, expect, it } from "vitest";
import { PUBLIC_PLANS_WITHHELD_KEYS, publicPlansResponseSchema } from "../../../contracts/entitlements/public-plans.schema.js";
import { NOT_LIVE_KEYS, PLAN_ENTITLEMENTS } from "../../db/seed/plan-entitlements.js";
import { publicEngineFrom, publicEntitlementsFrom, publicPlanFrom } from "./public-plans.js";

// STORY-103 (API part) - the live filter the pricing page and the in-app comparison share. Scenarios 6 and 8 (a non-live key is
// absent, one filter for both consumers), 9 and 10 (the fair-use ceiling and a deep scan's credit price are not published) and 13
// (the refresh cell can state the real per-engine cadence).

const ROW = { key: "growth", display_name: "Growth", currency: "USD", sort_order: 30 };

describe("STORY-103 · publicEntitlementsFrom", () => {
  it("STORY-103 #6/#8 a key without the live flag is absent, not flagged and not null", () => {
    const out = publicEntitlementsFrom({ "projects.max": { value: 3, live: true }, "integrations.slack": { value: null, live: false }, "whitelabel.custom_domain": { value: true, live: false } });
    expect(out).toEqual({ "projects.max": 3 });
    expect("whitelabel.custom_domain" in out).toBe(false);
  });

  it("STORY-103 #9/#10 the fair-use ceiling and a deep scan's credit price are withheld even when live", () => {
    const out = publicEntitlementsFrom({
      "fair_use.captures_per_cycle": { value: 4177, live: true },
      "deep_scan.credits": { value: 200, live: true },
      "credits.included_per_cycle": { value: 1200, live: true },
    });
    expect(out).toEqual({ "credits.included_per_cycle": 1200 });
    expect([...PUBLIC_PLANS_WITHHELD_KEYS].sort()).toEqual(["deep_scan.credits", "fair_use.captures_per_cycle"]);
  });

  it("keeps null and 0 and false distinct from absent", () => {
    expect(publicEntitlementsFrom({ "price.annual_usd": { value: null, live: true }, "exports.pdf_per_cycle": { value: 0, live: true }, "exports.csv": { value: false, live: true } })).toEqual({
      "price.annual_usd": null,
      "exports.pdf_per_cycle": 0,
      "exports.csv": false,
    });
  });

  it("an empty entitlements object publishes nothing", () => {
    expect(publicEntitlementsFrom({})).toEqual({});
  });

  it("fails closed on a malformed entitlements document rather than publishing it", () => {
    expect(() => publicEntitlementsFrom({ "projects.max": 3 })).toThrow();
    expect(() => publicEntitlementsFrom({ "projects.max": { value: 3 } })).toThrow();
    expect(() => publicEntitlementsFrom(null)).toThrow();
    // A live flag that is not exactly `true` is not live.
    expect(() => publicEntitlementsFrom({ "projects.max": { value: 3, live: "true" } })).toThrow();
  });

  it("STORY-103 #8 over the real seed, every published key is live and none is withheld, for every tier", () => {
    for (const [tier, entitlements] of Object.entries(PLAN_ENTITLEMENTS)) {
      const plan = { key: tier };
      const out = publicEntitlementsFrom(entitlements);
      for (const key of Object.keys(out)) {
        expect(NOT_LIVE_KEYS.has(key), `${plan.key}: ${key} is not live`).toBe(false);
        expect((PUBLIC_PLANS_WITHHELD_KEYS as readonly string[]).includes(key), `${plan.key}: ${key} is withheld`).toBe(false);
      }
      expect(Object.keys(out).length).toBeGreaterThan(0);
    }
  });
});

describe("STORY-103 · publicPlanFrom / publicEngineFrom", () => {
  it("a plan carries its currency and sort order, and only the filtered entitlements", () => {
    const plan = publicPlanFrom({ ...ROW, entitlements: { "price.monthly_usd": { value: 7919, live: true } } });
    expect(plan).toEqual({ key: "growth", display_name: "Growth", currency: "USD", sort_order: 30, entitlements: { "price.monthly_usd": 7919 } });
  });

  it("a char(3) currency padded by the driver is trimmed", () => {
    expect(publicPlanFrom({ ...ROW, currency: "USD ", entitlements: {} }).currency).toBe("USD");
  });

  it("STORY-103 #13 an engine carries cadence_by_plan verbatim, and nothing else of the catalog row", () => {
    const engine = publicEngineFrom({
      key: "gemini",
      display_name: "Gemini",
      cadence_by_plan: { business: { full: 4, priority: 30 }, starter: { full: 4 } },
      min_plan_key: "free",
      vendor: "Google",
    } as never);
    expect(engine).toEqual({ engine_key: "gemini", display_name: "Gemini", cadence_by_plan: { business: { full: 4, priority: 30 }, starter: { full: 4 } } });
  });

  it("an engine with an empty cadence map publishes an empty map, not a default", () => {
    expect(publicEngineFrom({ key: "x", display_name: "X", cadence_by_plan: {} }).cadence_by_plan).toEqual({});
  });

  it("fails closed on a malformed cadence leaf", () => {
    expect(() => publicEngineFrom({ key: "x", display_name: "X", cadence_by_plan: { free: { full: "daily" } } })).toThrow();
  });

  it("the assembled body satisfies the contract and is strict", () => {
    const body = { plans: [publicPlanFrom({ ...ROW, entitlements: {} })], engines: [], generated_at: new Date(0).toISOString() };
    expect(publicPlansResponseSchema.safeParse(body).success).toBe(true);
    expect(publicPlansResponseSchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });
});
