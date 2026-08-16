import { describe, expect, it } from "vitest";
import { resolveRetentionCutoff } from "../../src/workers/rollup/retention.js";

// STORY-013 — "branch on null and the literal string 'unlimited' ... vs a
// numeric day count" — a dedicated test for the null/unlimited path, not
// inferred from the numeric-tier tests.
describe("STORY-013 · resolveRetentionCutoff — null/unlimited/numeric branching", () => {
  const referenceDate = new Date("2026-08-16T00:00:00.000Z");

  it("null means never purge — returns null", () => {
    expect(resolveRetentionCutoff(null, referenceDate)).toBeNull();
  });

  it('the literal string "unlimited" means never purge — returns null', () => {
    expect(resolveRetentionCutoff("unlimited", referenceDate)).toBeNull();
  });

  it("a numeric day count returns a cutoff exactly that many days before referenceDate", () => {
    const cutoff = resolveRetentionCutoff(30, referenceDate);
    expect(cutoff).not.toBeNull();
    expect(cutoff!.toISOString()).toBe("2026-07-17T00:00:00.000Z");
  });

  it("a zero-day window is a valid, distinct numeric case (not treated as null/falsy)", () => {
    const cutoff = resolveRetentionCutoff(0, referenceDate);
    expect(cutoff).not.toBeNull();
    expect(cutoff!.toISOString()).toBe(referenceDate.toISOString());
  });
});
