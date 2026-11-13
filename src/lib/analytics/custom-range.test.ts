import { describe, expect, it } from "vitest";
import { PLAN_ENTITLEMENTS } from "../../db/seed/plan-entitlements.js";
import { judgeCustomRange, retentionDaysOf } from "./custom-range.js";

// Starter's rollup window, read from the matrix rather than copied (STORY-069 AC10). The expected dates below are worked out from it.
const ROLLUP_DAYS = PLAN_ENTITLEMENTS.starter["retention.rollups_days"]!.value as number;

// STORY-090 AC9 - "a custom range is bounded by plan retention, with out-of-range dates disabled and explained, never silently clamped".
// `today` is the workspace-local date; `retentionDays` is the rollup window IN FORCE (null = never purged). All dates are YYYY-MM-DD.
const base = { today: "2026-11-13", utcToday: "2026-11-13", retentionDays: ROLLUP_DAYS as number | null };

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
    expect(judgeCustomRange({ ...base, from: "2025-10-13", to: "2025-10-20" })).toEqual({ reason: "beyond_retention", field: "from", earliest_allowed: "2025-10-14", retention_days: ROLLUP_DAYS });
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

  it(`leap days do not move the boundary: ${ROLLUP_DAYS} days before 2028-03-01 is 2027-01-31`, () => {
    expect(judgeCustomRange({ today: "2028-03-01", utcToday: "2028-03-01", retentionDays: ROLLUP_DAYS, from: "2027-01-31", to: "2027-02-02" })).toBeNull();
    expect(judgeCustomRange({ today: "2028-03-01", utcToday: "2028-03-01", retentionDays: ROLLUP_DAYS, from: "2027-01-30", to: "2027-02-02" })).toMatchObject({ reason: "beyond_retention", earliest_allowed: "2027-01-31" });
  });
});

describe("STORY-090 AC9 · the boundary is the one the sweep deletes at (expireRollups: metric_date < the UTC date of now minus N days)", () => {
  // America/Los_Angeles at 2026-11-13 20:00 local = 2026-11-14 04:00Z: the local date is still the 13th, the UTC date is already the 14th.
  const west = { today: "2026-11-13", utcToday: "2026-11-14", retentionDays: ROLLUP_DAYS as number | null };

  it("west of UTC, between 00:00Z and local midnight, the earliest allowed day is the UTC-cutoff date (2025-10-15), not local today minus N (2025-10-14, already deleted)", () => {
    expect(judgeCustomRange({ ...west, from: "2025-10-14", to: "2025-10-20" })).toEqual({ reason: "beyond_retention", field: "from", earliest_allowed: "2025-10-15", retention_days: ROLLUP_DAYS });
    expect(judgeCustomRange({ ...west, from: "2025-10-15", to: "2025-10-20" })).toBeNull();
  });

  it("east of UTC the local date is ahead, so local today minus N is the later bound and stays the boundary", () => {
    const east = { today: "2026-11-14", utcToday: "2026-11-13", retentionDays: ROLLUP_DAYS as number | null };
    expect(judgeCustomRange({ ...east, from: "2025-10-14", to: "2025-10-20" })).toMatchObject({ reason: "beyond_retention", earliest_allowed: "2025-10-15" });
    expect(judgeCustomRange({ ...east, from: "2025-10-15", to: "2025-10-20" })).toBeNull();
  });
});

describe("STORY-090 AC9 · retentionDaysOf", () => {
  it("a day count is itself; null and 'unlimited' are 'never purged' (no bound)", () => {
    expect(retentionDaysOf(ROLLUP_DAYS)).toBe(ROLLUP_DAYS);
    expect(retentionDaysOf(0)).toBe(0);
    expect(retentionDaysOf(null)).toBeNull();
    expect(retentionDaysOf("unlimited")).toBeNull();
  });
});
