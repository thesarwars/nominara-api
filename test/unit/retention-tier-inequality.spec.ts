import { describe, expect, it } from "vitest";
import { PLAN_ENTITLEMENTS } from "../../src/db/seed/plan-entitlements.js";

// STORY-077 R2 (data-model.md §7, "two rules that must not be relaxed"): rollups are retained LONGER than raw captures at
// every tier, so a chart survives even when the underlying text does not. The numbers are read from the plans seed, never
// retyped here (the no-hardcoded-plan-values gate), so a seed edit that breaks the inequality fails this test.
//
// Encoding (seed + retention.ts `resolveRetentionCutoff`): a number is a day count; `null` and "unlimited" both mean the
// data is never purged. A raw window that is never purged satisfies the rule only with a rollup window that is never purged.
type Window = number | "unlimited" | null;
const FOREVER = Number.POSITIVE_INFINITY;
const days = (w: Window): number => (typeof w === "number" ? w : FOREVER);
const windowOf = (tier: string, key: string): Window => PLAN_ENTITLEMENTS[tier as keyof typeof PLAN_ENTITLEMENTS][key]!.value as Window;

describe("STORY-077 R2 · rollups outlive raw captures at every tier", () => {
  const tiers = Object.keys(PLAN_ENTITLEMENTS);

  it("the seed has tiers to check", () => {
    expect(tiers.length).toBeGreaterThan(0);
  });

  for (const tier of tiers) {
    it(`R2 · ${tier}: rollup retention is at least as long as raw, and strictly longer unless both are never purged`, () => {
      const raw = days(windowOf(tier, "retention.raw_captures_days"));
      const rollups = days(windowOf(tier, "retention.rollups_days"));
      expect(rollups).toBeGreaterThanOrEqual(raw);
      if (Number.isFinite(raw)) expect(rollups).toBeGreaterThan(raw);
    });
  }

  it("R2 · a tier whose RAW window is finite never has a finite-and-shorter rollup window (the free tier's null means never purged, not zero)", () => {
    for (const tier of tiers) {
      const raw = windowOf(tier, "retention.raw_captures_days");
      const rollups = windowOf(tier, "retention.rollups_days");
      if (typeof raw === "number") expect(rollups === null || rollups === "unlimited" || (typeof rollups === "number" && rollups > raw)).toBe(true);
    }
  });
});
