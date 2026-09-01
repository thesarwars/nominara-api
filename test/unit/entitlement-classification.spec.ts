import { describe, expect, it } from "vitest";
import {
  FEATURE_FLAG_KEYS,
  FEATURE_FLAG_NAMESPACES,
  STRUCTURAL_LIMIT_KEYS,
  isFeatureGranted,
  structuralLimitFrom,
  wouldExceed,
} from "../../src/lib/entitlements/classification.js";
import { ENTITLEMENT_KEYS, PLAN_ENTITLEMENTS } from "../../src/db/seed/plan-entitlements.js";

// STORY-069 AC6/AC7 — the classification lists are written out as literals so
// a decorator's key is checked at compile time. That buys type safety and buys
// drift: a key added to the matrix under one of §9's namespaces would go
// unclassified, and an unclassified feature key means a route that cannot be
// gated on it at all. These tests are what makes the trade safe.

describe("STORY-069 · the classification lists and the matrix agree", () => {
  it("every classified key exists in the matrix", () => {
    const known = new Set(ENTITLEMENT_KEYS);
    for (const key of [...STRUCTURAL_LIMIT_KEYS, ...FEATURE_FLAG_KEYS]) {
      expect(known.has(key), `${key} is classified but is not an entitlement key`).toBe(true);
    }
  });

  it("no key is both a structural limit and a feature flag", () => {
    // §9 gives them different codes and different details. A key in both lists
    // would produce whichever the route's decorator happened to pick.
    const structural = new Set<string>(STRUCTURAL_LIMIT_KEYS);
    for (const key of FEATURE_FLAG_KEYS) {
      expect(structural.has(key), `${key} is classified twice`).toBe(false);
    }
  });

  it("every matrix key under one of §9's feature namespaces is classified as a feature", () => {
    const classified = new Set<string>(FEATURE_FLAG_KEYS);
    const unclassified = ENTITLEMENT_KEYS.filter(
      (key) => FEATURE_FLAG_NAMESPACES.some((prefix) => key.startsWith(prefix)) && !classified.has(key),
    );

    expect(unclassified).toEqual([]);
  });

  it("`audit_log.export` is NOT swept up by the `exports.` namespace", () => {
    // A prefix check on "export" rather than "exports." would classify it, and
    // §9 does not list it. Named here because it is the one near-miss in the
    // matrix.
    expect(ENTITLEMENT_KEYS).toContain("audit_log.export");
    expect(FEATURE_FLAG_KEYS as readonly string[]).not.toContain("audit_log.export");
  });
});

describe("STORY-069 · isFeatureGranted over the real seed", () => {
  it("no descriptive string in the feature key set means denial", () => {
    // The predicate grants on every string, which is only safe while no
    // feature key carries a string meaning "no". A matrix edit introducing one
    // — say "disabled" — would silently switch a feature ON, and this is the
    // test that catches it.
    const strings = new Set<string>();
    for (const tier of Object.values(PLAN_ENTITLEMENTS)) {
      for (const key of FEATURE_FLAG_KEYS) {
        const value = tier[key]?.value;
        if (typeof value === "string") {
          strings.add(value);
        }
      }
    }

    expect([...strings].sort()).toEqual([
      "10_active",
      "50_active",
      "configurable",
      "le_20_prompts",
      "unlimited",
      "weekly",
    ]);
  });

  it("the three ways the matrix says no", () => {
    expect(isFeatureGranted(false)).toBe(false); // ✗
    expect(isFeatureGranted(null)).toBe(false); // —
    expect(isFeatureGranted(0)).toBe(false); // a zero cap — AC7
  });

  it("grants on true, on a positive cap, and on any descriptive string", () => {
    expect(isFeatureGranted(true)).toBe(true);
    expect(isFeatureGranted(25)).toBe(true);
    expect(isFeatureGranted("10_active")).toBe(true);
    expect(isFeatureGranted("unlimited")).toBe(true);
  });

  it("starter's zero PDF cap and growth's 25 are opposite answers", () => {
    // AC7's exact pair, straight off the seed rather than from a literal.
    expect(isFeatureGranted(PLAN_ENTITLEMENTS.starter["exports.pdf_per_cycle"]!.value)).toBe(false);
    expect(isFeatureGranted(PLAN_ENTITLEMENTS.growth["exports.pdf_per_cycle"]!.value)).toBe(true);
  });
});

describe("STORY-069 · structural ceilings", () => {
  it("a number is a finite ceiling", () => {
    expect(structuralLimitFrom(3)).toEqual({ kind: "finite", limit: 3 });
    expect(structuralLimitFrom(0)).toEqual({ kind: "finite", limit: 0 });
  });

  it("null and false are a ceiling of zero, not an absent one", () => {
    expect(structuralLimitFrom(null)).toEqual({ kind: "finite", limit: 0 });
    expect(structuralLimitFrom(false)).toEqual({ kind: "finite", limit: 0 });
  });

  it("the four open-ended strings are unlimited", () => {
    for (const value of ["unlimited", "uncapped", "custom", "negotiated"]) {
      expect(structuralLimitFrom(value)).toEqual({ kind: "unlimited" });
    }
  });

  it("a string that is not one of those is not a ceiling at all", () => {
    // Better an explicit configuration error than a silently-unlimited plan.
    expect(structuralLimitFrom("3_core")).toBeUndefined();
    expect(structuralLimitFrom(true)).toBeUndefined();
  });

  it("every structural key resolves to a ceiling on every seeded tier", () => {
    for (const [tierKey, tier] of Object.entries(PLAN_ENTITLEMENTS)) {
      for (const key of STRUCTURAL_LIMIT_KEYS) {
        expect(structuralLimitFrom(tier[key]!.value), `${tierKey}.${key}`).toBeDefined();
      }
    }
  });

  it("wouldExceed refuses AT the ceiling, not past it", () => {
    // The guard runs before the row is created, so being at the limit already
    // means the next one exceeds it.
    expect(wouldExceed({ kind: "finite", limit: 3 }, 2)).toBe(false);
    expect(wouldExceed({ kind: "finite", limit: 3 }, 3)).toBe(true);
    expect(wouldExceed({ kind: "finite", limit: 0 }, 0)).toBe(true);
    expect(wouldExceed({ kind: "unlimited" }, 10_000)).toBe(false);
  });
});
