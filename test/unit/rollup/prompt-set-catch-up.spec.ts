import { describe, expect, it } from "vitest";
import { PROMPT_SET_CATCH_UP_DAYS, promptSetDaysToEvaluate } from "../../../src/lib/rollup/refresh-project-milestones.js";

// STORY-066 AC9, review round 2 — `prompt_set_change` must fire for the day the prompt set changed, not only for the days the rollup
// visits (the rollup visits only days with captures). So the rollup of day D evaluates every day from the previous rolled-up day
// (inclusive: a change later that day, after its last rollup, is caught too) through D.
describe("STORY-066 AC9 · the days a rollup evaluates for prompt_set_change", () => {
  it("every day from the previous rolled-up day through this one — the days with no capture in between included", () => {
    expect(promptSetDaysToEvaluate("2026-10-20", "2026-10-24")).toEqual(["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"]);
  });

  it("only this day when nothing was rolled up before it (the first measured day), or the previous day is not earlier", () => {
    expect(promptSetDaysToEvaluate(null, "2026-10-24")).toEqual(["2026-10-24"]);
    expect(promptSetDaysToEvaluate("2026-10-24", "2026-10-24")).toEqual(["2026-10-24"]);
    expect(promptSetDaysToEvaluate("2026-10-25", "2026-10-24")).toEqual(["2026-10-24"]);
  });

  it("crosses month and year ends by the calendar", () => {
    expect(promptSetDaysToEvaluate("2026-12-30", "2027-01-02")).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(promptSetDaysToEvaluate("2028-02-28", "2028-03-01")).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
  });

  it("is bounded: a gap longer than the longest timeframe evaluates only its trailing year", () => {
    const days = promptSetDaysToEvaluate("2020-01-01", "2026-10-24");
    expect(days).toHaveLength(PROMPT_SET_CATCH_UP_DAYS + 1);
    expect(days[days.length - 1]).toBe("2026-10-24");
    expect(days[0]).toBe("2025-10-23");
  });
});
