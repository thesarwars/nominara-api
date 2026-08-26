import { describe, expect, it } from "vitest";
import { resolveRunOutcome } from "../../../src/lib/engines/run-outcome.js";

// STORY-031 Phase G — AC: "the degraded stage... runs complete as partial
// rather than failing." Pure resolver: >=1 success + a degraded engine (or
// any non-degraded-but-still-incomplete run) → partial; zero successes →
// failed; NEVER failed merely because one engine is down.

describe("STORY-031 · resolveRunOutcome", () => {
  it("everything succeeded, no degraded engine → success", () => {
    expect(resolveRunOutcome({ successCount: 6, totalCount: 6, hasDegradedEngine: false })).toBe("success");
  });

  it(">=1 success with a degraded engine involved → partial, never failed", () => {
    expect(resolveRunOutcome({ successCount: 5, totalCount: 6, hasDegradedEngine: true })).toBe("partial");
  });

  it("all cells that were attempted succeeded, but a degraded engine was skipped entirely → still partial, not success", () => {
    expect(resolveRunOutcome({ successCount: 5, totalCount: 5, hasDegradedEngine: true })).toBe("partial");
  });

  it("some cells failed for reasons unrelated to any degraded engine → still partial (not silently reported as success)", () => {
    expect(resolveRunOutcome({ successCount: 5, totalCount: 6, hasDegradedEngine: false })).toBe("partial");
  });

  it("zero successes → failed, even though one engine being down is the whole reason", () => {
    expect(resolveRunOutcome({ successCount: 0, totalCount: 6, hasDegradedEngine: true })).toBe("failed");
  });

  it("zero successes with no degraded engine at all → still failed", () => {
    expect(resolveRunOutcome({ successCount: 0, totalCount: 6, hasDegradedEngine: false })).toBe("failed");
  });

  it("a run never fails MERELY because one engine is down — 5 of 6 engines succeeding is partial, not failed", () => {
    const outcome = resolveRunOutcome({ successCount: 5, totalCount: 6, hasDegradedEngine: true });
    expect(outcome).not.toBe("failed");
    expect(outcome).toBe("partial");
  });
});
