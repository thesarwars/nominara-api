import { describe, expect, it } from "vitest";
import { growthMapQuerySchema } from "./growth-map-response.schema.js";
import { scorecardsQuerySchema } from "./scorecards-response.schema.js";
import { customRangeDays, customRangeGranularity, CUSTOM_RANGE_MAX_DAYS } from "./custom-range.schema.js";

// STORY-090 AC8/AC9 (FR-OVW-03) - a custom range on the two reads the Overview filters: `timeframe=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`, workspace-local dates.
// The contract refuses a malformed range early (400, never a silent default); whether the range fits the plan's retention is the service's to say.
describe.each([
  ["scorecards", scorecardsQuerySchema],
  ["growth map", growthMapQuerySchema],
] as const)("STORY-090 · custom range on the %s query", (_name, schema) => {
  it("accepts a custom range with both dates, and the preset timeframes with neither", () => {
    expect(schema.safeParse({ timeframe: "custom", from: "2026-10-01", to: "2026-10-31" }).success).toBe(true);
    expect(schema.safeParse({ timeframe: "30d" }).success).toBe(true);
  });

  it("refuses a custom range missing either date, and a preset timeframe that carries a range (it would be silently ignored)", () => {
    expect(schema.safeParse({ timeframe: "custom" }).success).toBe(false);
    expect(schema.safeParse({ timeframe: "custom", from: "2026-10-01" }).success).toBe(false);
    expect(schema.safeParse({ timeframe: "custom", to: "2026-10-31" }).success).toBe(false);
    expect(schema.safeParse({ timeframe: "30d", from: "2026-10-01", to: "2026-10-31" }).success).toBe(false);
    expect(schema.safeParse({ from: "2026-10-01", to: "2026-10-31" }).success, "the default timeframe is a preset").toBe(false);
  });

  it("refuses an inverted range, a non-date, a datetime and an impossible calendar day; a one-day range is valid", () => {
    expect(schema.safeParse({ timeframe: "custom", from: "2026-10-31", to: "2026-10-01" }).success).toBe(false);
    expect(schema.safeParse({ timeframe: "custom", from: "last week", to: "2026-10-01" }).success).toBe(false);
    expect(schema.safeParse({ timeframe: "custom", from: "2026-10-01T00:00:00Z", to: "2026-10-02" }).success).toBe(false);
    expect(schema.safeParse({ timeframe: "custom", from: "2026-02-30", to: "2026-03-02" }).success).toBe(false);
    expect(schema.safeParse({ timeframe: "custom", from: "2026-10-01", to: "2026-10-01" }).success).toBe(true);
  });

  it("still refuses an unknown key (the query stays strict)", () => {
    expect(schema.safeParse({ timeframe: "custom", from: "2026-10-01", to: "2026-10-02", until: "x" }).success).toBe(false);
  });
});

describe("STORY-090 · the custom range's own arithmetic", () => {
  it("counts days inclusively across month and leap-year boundaries", () => {
    expect(customRangeDays("2026-10-01", "2026-10-01")).toBe(1);
    expect(customRangeDays("2026-10-01", "2026-10-31")).toBe(31);
    expect(customRangeDays("2028-02-28", "2028-03-01")).toBe(3);
    expect(customRangeDays("2026-01-01", "2026-12-31")).toBe(365);
  });

  it("selects granularity by §13: up to 90 days by the day, beyond it by the week", () => {
    expect(customRangeGranularity(1)).toBe("day");
    expect(customRangeGranularity(90)).toBe("day");
    expect(customRangeGranularity(91)).toBe("week");
    expect(CUSTOM_RANGE_MAX_DAYS).toBe(366);
  });

  it("the growth map refuses a granularity the range does not select (never a silent substitution)", () => {
    const ok = growthMapQuerySchema.safeParse({ timeframe: "custom", from: "2026-01-01", to: "2026-06-30", granularity: "week" });
    expect(ok.success).toBe(true);
    expect(growthMapQuerySchema.safeParse({ timeframe: "custom", from: "2026-01-01", to: "2026-06-30", granularity: "day" }).success).toBe(false);
    expect(growthMapQuerySchema.safeParse({ timeframe: "custom", from: "2026-10-01", to: "2026-10-31", granularity: "hour" }).success).toBe(false);
  });
});
