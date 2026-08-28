import { describe, expect, it } from "vitest";
import {
  SUPPRESSION_TARGETS,
  cohortsFor,
  measureCohort,
  measurePopulation,
  type CohortObservation,
} from "../../src/lib/capture/suppression-cohorts.js";

// STORY-032 AC14 — §6's suppression targets, per cohort.
//
// §6 names both failures of a blended number and they point OPPOSITE ways:
// "A single blended threshold would fire constantly against the daily cohort,
// whose design target is lower, while masking a collapse in the free cohort."
//
// Two tests below construct exactly those populations. They are the ones that
// matter, because a blended implementation passes every other test in this
// file — the targets would still be right, the arithmetic would still be
// right, and the answer would still be wrong.
describe("STORY-032 · suppression is measured per cohort, never blended", () => {
  it("carries §6's three targets exactly", () => {
    expect(SUPPRESSION_TARGETS.overall).toEqual({ target: 0.3, alarmBelow: 0.25 });
    expect(SUPPRESSION_TARGETS.daily_cadence).toEqual({ target: 0.22, alarmBelow: 0.18 });
    expect(SUPPRESSION_TARGETS.free_plan.target).toBe(0.45);
  });

  // §6 gives the free cohort a target and NO alarm threshold, while giving
  // one for the other two. Asserted as an absence so nobody later fills it in
  // with a plausible number the reference never committed to.
  it("has no alarm threshold for the free cohort, which the reference does not give", () => {
    expect(SUPPRESSION_TARGETS.free_plan.alarmBelow).toBeNull();
    expect(
      measureCohort("free_plan", 100, 1).alarming,
      "an absent threshold must never alarm, however bad the rate",
    ).toBe(false);
  });

  // Overlap is the design. A free daily project is in all three, and
  // partitioning into disjoint buckets would stop the strictest target
  // applying to the runs most likely to breach it.
  it.each([
    [{ cadence: "weekly", planKey: "growth" }, ["overall"]],
    [{ cadence: "daily", planKey: "growth" }, ["overall", "daily_cadence"]],
    [{ cadence: "hourly", planKey: "growth" }, ["overall", "daily_cadence"]],
    [{ cadence: "weekly", planKey: "free" }, ["overall", "free_plan"]],
    [{ cadence: "daily", planKey: "free" }, ["overall", "daily_cadence", "free_plan"]],
  ] as const)("puts %o in %o", (run, expected) => {
    expect(cohortsFor(run)).toEqual(expected);
  });

  // FAILURE ONE: too strict. The daily cohort is designed to suppress less,
  // so a blended 30% threshold alarms on a cohort that is performing exactly
  // as intended — and an alarm that fires constantly is one nobody reads.
  it("a healthy daily cohort at 24% does NOT alarm, though it is below the overall target", () => {
    const daily = measureCohort("daily_cadence", 1_000, 240);

    expect(daily.rate).toBeCloseTo(0.24);
    expect(daily.meetsTarget, "24% clears the daily cohort's own 22% target").toBe(true);
    expect(daily.alarming).toBe(false);
    expect(
      daily.rate < SUPPRESSION_TARGETS.overall.target,
      "and it is below the OVERALL target, which is why a blended threshold would fire",
    ).toBe(true);
  });

  // FAILURE TWO, and the graver one: too loose. The free cohort's 45% target
  // sits well above the 30% overall, so a free-tier collapse barely moves the
  // blended figure and reports healthy while the cheapest tier stops being
  // cheap.
  it("catches a free-cohort collapse that a blended figure reports as healthy", () => {
    const population: CohortObservation[] = [
      // A large paid population, comfortably suppressing.
      { cadence: "weekly", planKey: "growth", planned: 9_000, skipped: 3_150 },
      // The free cohort has collapsed from 45% to 10%.
      { cadence: "weekly", planKey: "free", planned: 1_000, skipped: 100 },
    ];

    const measured = measurePopulation(population);
    const overall = measured.find((m) => m.cohort === "overall")!;
    const free = measured.find((m) => m.cohort === "free_plan")!;

    expect(overall.rate, "the blended figure is 3250/10000 = 32.5%").toBeCloseTo(0.325);
    expect(overall.meetsTarget, "which clears the overall target and reports healthy").toBe(true);
    expect(free.rate, "while the free cohort is at 10%").toBeCloseTo(0.1);
    expect(free.meetsTarget, "and has missed its own 45% target entirely").toBe(false);
  });

  // A run counted in three cohorts contributes its cells to all three
  // denominators. That is the arithmetic a blended figure cannot express.
  it("counts a run's cells into every cohort it belongs to", () => {
    const measured = measurePopulation([{ cadence: "daily", planKey: "free", planned: 100, skipped: 50 }]);

    expect(measured.map((m) => m.cohort).sort()).toEqual(["daily_cadence", "free_plan", "overall"]);
    for (const m of measured) {
      expect(m.planned, `${m.cohort} sees the same 100 cells`).toBe(100);
      expect(m.rate).toBeCloseTo(0.5);
    }
  });

  it("alarms when a cohort falls below its own threshold", () => {
    expect(measureCohort("overall", 1_000, 200).alarming, "20% is below the overall 25% alarm").toBe(true);
    expect(measureCohort("daily_cadence", 1_000, 170).alarming, "17% is below the daily 18% alarm").toBe(true);
    expect(measureCohort("daily_cadence", 1_000, 190).alarming, "19% is above it").toBe(false);
  });

  // A population of empty runs must not report a healthy cache. Treating
  // 0/0 as 100% is the arithmetic that would.
  it("a run that planned nothing has a rate of zero and meets no target", () => {
    const empty = measureCohort("overall", 0, 0);
    expect(empty.rate).toBe(0);
    expect(empty.meetsTarget, "no cells planned is not a perfect cache").toBe(false);
    expect(empty.alarming, "nor is it an incident — there is nothing to measure").toBe(false);
  });

  it("measures nothing for an empty population", () => {
    expect(measurePopulation([])).toEqual([]);
  });
});
