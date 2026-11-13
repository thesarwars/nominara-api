import { describe, expect, it } from "vitest";
import { judgeCustomRange, retentionDaysOf } from "./custom-range.js";

// STORY-090 AC9 - "a custom range is bounded by plan retention, with out-of-range dates disabled and explained, never silently clamped".
// `today` is the workspace-local date; `retentionDays` is the rollup window IN FORCE (null = never purged). All dates are YYYY-MM-DD.
const base = { today: "2026-11-13", retentionDays: 395 as number | null };

describe("STORY-090 AC9 · judgeCustomRange", () => {
  it("accepts a range inside the window, today included as `to`, and a one-day range", () => {
    expect(judgeCustomRange({ ...base, from: "2026-10-01", to: "2026-11-13" })).toBeNull();
    expect(judgeCustomRange({ ...base, from: "2026-11-13", to: "2026-11-13" })).toBeNull();
  });

  it("refuses a `to` in the future, naming today (never clamped to it)", () => {
    expect(judgeCustomRange({ ...base, from: "2026-11-01", to: "2026-11-14" })).toEqual({ reason: "in_future", field: "to", today: "2026-11-13" });
  });

  it("the retention boundary is exact: the earliest allowed day (today minus the window) passes, the day before is refused with the boundary named", () => {
    // 2026-11-13 minus 395 days = 2025-10-14.
    expect(judgeCustomRange({ ...base, from: "2025-10-14", to: "2025-10-20" })).toBeNull();
    expect(judgeCustomRange({ ...base, from: "2025-10-13", to: "2025-10-20" })).toEqual({ reason: "beyond_retention", field: "from", earliest_allowed: "2025-10-14", retention_days: 395 });
  });

  it("a plan with no rollup window (null: never purged) has no lower bound, but the length cap still holds", () => {
    expect(judgeCustomRange({ ...base, retentionDays: null, from: "2020-01-01", to: "2020-06-30" })).toBeNull();
    expect(judgeCustomRange({ ...base, retentionDays: null, from: "2020-01-01", to: "2021-01-01" })).toEqual({ reason: "too_long", field: "to", max_days: 366 });
    // 2020 is a leap year: 366 days is the longest allowed range.
    expect(judgeCustomRange({ ...base, retentionDays: null, from: "2020-01-01", to: "2020-12-31" })).toBeNull();
  });

  it("a zero-day window allows today only (0 is a window, not 'none')", () => {
    expect(judgeCustomRange({ ...base, retentionDays: 0, from: "2026-11-13", to: "2026-11-13" })).toBeNull();
    expect(judgeCustomRange({ ...base, retentionDays: 0, from: "2026-11-12", to: "2026-11-13" })).toMatchObject({ reason: "beyond_retention" });
  });

  it("reports the first problem in a fixed order: future, then retention, then length", () => {
    expect(judgeCustomRange({ ...base, from: "2020-01-01", to: "2030-01-01" })).toMatchObject({ reason: "in_future" });
    expect(judgeCustomRange({ ...base, from: "2020-01-01", to: "2026-01-01" })).toMatchObject({ reason: "beyond_retention" });
    expect(judgeCustomRange({ ...base, retentionDays: 1000, from: "2024-03-01", to: "2026-01-01" })).toMatchObject({ reason: "too_long" });
  });

  it("leap days do not move the boundary: 395 days before 2028-03-01 is 2027-01-31", () => {
    expect(judgeCustomRange({ today: "2028-03-01", retentionDays: 395, from: "2027-01-31", to: "2027-02-02" })).toBeNull();
    expect(judgeCustomRange({ today: "2028-03-01", retentionDays: 395, from: "2027-01-30", to: "2027-02-02" })).toMatchObject({ reason: "beyond_retention", earliest_allowed: "2027-01-31" });
  });
});

describe("STORY-090 AC9 · retentionDaysOf", () => {
  it("a day count is itself; null and 'unlimited' are 'never purged' (no bound)", () => {
    expect(retentionDaysOf(395)).toBe(395);
    expect(retentionDaysOf(0)).toBe(0);
    expect(retentionDaysOf(null)).toBeNull();
    expect(retentionDaysOf("unlimited")).toBeNull();
  });
});
