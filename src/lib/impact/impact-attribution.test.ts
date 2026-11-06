import { describe, expect, it } from "vitest";
import { MEASURED_IMPACT_CAVEAT, measuredImpactSchema } from "../../../contracts/tasks/task-verification.schema.js";
import { computeImpact, impactWindowDates, impactConfidence, type DayPoint } from "./impact-attribution.js";

// STORY-067 - the scoring half: before/after means over aligned windows, the confidence label, and no delta on a thin sample.
// scoring-models.md section 13 "Impact attribution" + section 3 "Deltas" (n < 30 in either window => null, never 0).

/** `days` daily points around `centre` with `cells` cells each. */
function series(from: string, days: number, centre: number, cells: number, wobble = 1): DayPoint[] {
  const start = Date.parse(from);
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    score: centre + (i % 2 === 0 ? wobble : -wobble),
    cells,
  }));
}

describe("STORY-067 impactWindowDates - aligned windows either side of the completion day", () => {
  it("[STORY-067 #4] two windows of the SAME length, the completion day itself in neither", () => {
    expect(impactWindowDates("2027-03-15", 14)).toEqual({
      before: { from: "2027-03-01", to: "2027-03-14" },
      after: { from: "2027-03-16", to: "2027-03-29" },
    });
  });

  it("crosses a month and a year boundary without drifting", () => {
    expect(impactWindowDates("2027-01-05", 14)).toEqual({
      before: { from: "2026-12-22", to: "2027-01-04" },
      after: { from: "2027-01-06", to: "2027-01-19" },
    });
  });
});

describe("STORY-067 computeImpact", () => {
  const before = series("2027-03-01", 14, 40, 10); // 140 cells
  const after = series("2027-03-16", 14, 55, 10);

  it("[STORY-067 #4] adequate data yields the two means over the aligned windows and their delta", () => {
    const out = computeImpact({ before, after, windowDays: 14, otherMilestonesWithin7d: 0, otherMilestonesInWindow: 0 });
    expect(out.status).toBe("measured");
    if (out.status !== "measured") return;
    expect(out.impact.visibility_before).toBe(40);
    expect(out.impact.visibility_after_14d).toBe(55);
    expect(out.impact.delta).toBe(15);
    expect(out.impact.window_days).toBe(14);
    expect(out.impact.n_before).toBe(140);
    expect(out.impact.n_after).toBe(140);
    expect(out.impact.scoring_version).toBe("v1");
  });

  it("[STORY-067 #9] every computed impact carries the mandatory observational caveat, and parses against the contract", () => {
    const out = computeImpact({ before, after, windowDays: 14, otherMilestonesWithin7d: 0, otherMilestonesInWindow: 0 });
    if (out.status !== "measured") throw new Error("expected a measured impact");
    expect(out.impact.caveat).toBe(MEASURED_IMPACT_CAVEAT);
    expect(measuredImpactSchema.safeParse(out.impact).success).toBe(true);
  });

  it("[STORY-067 #6] an isolated milestone with a clear separation is high confidence", () => {
    const out = computeImpact({ before, after, windowDays: 14, otherMilestonesWithin7d: 0, otherMilestonesInWindow: 0 });
    if (out.status !== "measured") throw new Error("expected a measured impact");
    expect(out.impact.confidence).toBe("high");
    expect(out.impact.other_milestones_nearby).toBe(0);
  });

  it("[STORY-067 #5] other milestones in the window make it low confidence REGARDLESS of how large the delta is", () => {
    const huge = series("2027-03-16", 14, 95, 10);
    for (const after2 of [after, huge]) {
      const out = computeImpact({ before, after: after2, windowDays: 14, otherMilestonesWithin7d: 2, otherMilestonesInWindow: 2 });
      if (out.status !== "measured") throw new Error("expected a measured impact");
      expect(out.impact.confidence).toBe("low");
      expect(out.impact.delta).toBeGreaterThan(10); // the movement is still shown
    }
  });

  it("[STORY-067 #5] two others outside +/-7 days still make it low: several nearby changes cannot be told apart", () => {
    const out = computeImpact({ before, after, windowDays: 14, otherMilestonesWithin7d: 0, otherMilestonesInWindow: 2 });
    if (out.status !== "measured") throw new Error("expected a measured impact");
    expect(out.impact.confidence).toBe("low");
  });

  it("[STORY-067 #5] exactly one other milestone within 7 days is medium, never high; one further out stays high (scoring-models section 13)", () => {
    const inner = computeImpact({ before, after, windowDays: 14, otherMilestonesWithin7d: 1, otherMilestonesInWindow: 1 });
    const outer = computeImpact({ before, after, windowDays: 14, otherMilestonesWithin7d: 0, otherMilestonesInWindow: 1 });
    if (inner.status !== "measured" || outer.status !== "measured") throw new Error("expected a measured impact");
    expect(inner.impact.confidence).toBe("medium");
    expect(outer.impact.confidence).toBe("high");
    expect(inner.impact.other_milestones_nearby).toBe(1);
  });

  it("[STORY-067 #7] a window under 30 measured cells yields NO delta, on either side, never 0", () => {
    const thinAfter = series("2027-03-16", 14, 55, 2); // 28 cells
    const thinBefore = series("2027-03-01", 14, 40, 2);
    for (const input of [
      { before, after: thinAfter },
      { before: thinBefore, after },
      { before: thinBefore, after: thinAfter },
    ]) {
      const out = computeImpact({ ...input, windowDays: 14, otherMilestonesWithin7d: 0, otherMilestonesInWindow: 0 });
      expect(out).toEqual({ status: "insufficient_sample", n_before: expect.any(Number), n_after: expect.any(Number) });
    }
  });

  it("[STORY-067 #7] boundary: exactly 30 cells is enough, 29 is not", () => {
    const at30 = [{ date: "2027-03-16", score: 55, cells: 15 }, { date: "2027-03-17", score: 57, cells: 15 }];
    const at29 = [{ date: "2027-03-16", score: 55, cells: 15 }, { date: "2027-03-17", score: 57, cells: 14 }];
    expect(computeImpact({ before, after: at30, windowDays: 14, otherMilestonesWithin7d: 0, otherMilestonesInWindow: 0 }).status).toBe("measured");
    expect(computeImpact({ before, after: at29, windowDays: 14, otherMilestonesWithin7d: 0, otherMilestonesInWindow: 0 }).status).toBe("insufficient_sample");
  });

  it("[STORY-067 #7] an empty window is insufficient, not a zero mean", () => {
    expect(computeImpact({ before: [], after, windowDays: 14, otherMilestonesWithin7d: 0, otherMilestonesInWindow: 0 })).toMatchObject({ status: "insufficient_sample", n_before: 0 });
  });

  it("days with no measured cells are gaps, not zeros: they do not pull a mean down", () => {
    const gappy: DayPoint[] = [...series("2027-03-01", 14, 40, 10), { date: "2027-03-15", score: 0, cells: 0 }];
    const out = computeImpact({ before: gappy, after, windowDays: 14, otherMilestonesWithin7d: 0, otherMilestonesInWindow: 0 });
    if (out.status !== "measured") throw new Error("expected a measured impact");
    expect(out.impact.visibility_before).toBe(40);
  });

  it("a zero delta from adequate data is a measured 0, distinct from no delta", () => {
    const flat = series("2027-03-16", 14, 40, 10);
    const out = computeImpact({ before, after: flat, windowDays: 14, otherMilestonesWithin7d: 0, otherMilestonesInWindow: 0 });
    if (out.status !== "measured") throw new Error("expected a measured impact");
    expect(out.impact.delta).toBe(0);
    expect(out.impact.confidence).toBe("low"); // no separation to speak of
  });

  it("a delta inside the noise is not a clear separation, so it is not high confidence", () => {
    const noisyBefore = series("2027-03-01", 14, 40, 10, 20);
    const noisyAfter = series("2027-03-16", 14, 42, 10, 20);
    const out = computeImpact({ before: noisyBefore, after: noisyAfter, windowDays: 14, otherMilestonesWithin7d: 0, otherMilestonesInWindow: 0 });
    if (out.status !== "measured") throw new Error("expected a measured impact");
    expect(out.impact.confidence).toBe("low");
  });
});

describe("STORY-067 impactConfidence", () => {
  it.each([
    [true, 0, 0, "high"],
    [true, 0, 1, "high"],
    [true, 1, 1, "medium"],
    [true, 1, 2, "low"],
    [true, 0, 2, "low"],
    [true, 5, 5, "low"],
    [false, 0, 0, "low"],
    [false, 0, 1, "low"],
  ] as const)("clear=%s, within 7d=%s, in window=%s -> %s", (clear, within7, inWindow, expected) => {
    expect(impactConfidence({ clearSeparation: clear, otherMilestonesWithin7d: within7, otherMilestonesInWindow: inWindow })).toBe(expected);
  });
});
