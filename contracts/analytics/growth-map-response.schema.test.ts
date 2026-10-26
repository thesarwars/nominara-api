import { describe, expect, it } from "vitest";
import { portalGrowthMapResponseSchema } from "../portal/portal-read.schema.js";
import { GROWTH_MAP_GRANULARITY, growthMapQuerySchema, growthMapResponseSchema } from "./growth-map-response.schema.js";

// STORY-066 — the growth-map series contract: §13's timeframe → granularity
// auto-selection, and the two annotation layers a chart needs to stay honest.

describe("STORY-066 AC1/AC2 · growth-map query", () => {
  it("serves 24h, 7d, 30d, 90d, 180d and 365d, defaulting to 90d", () => {
    expect(growthMapQuerySchema.parse({}).timeframe).toBe("90d");
    for (const timeframe of ["24h", "7d", "30d", "90d", "180d", "365d"]) {
      expect(growthMapQuerySchema.safeParse({ timeframe }).success).toBe(true);
    }
    expect(growthMapQuerySchema.safeParse({ timeframe: "custom" }).success).toBe(false);
  });

  it("auto-selects §13's granularity: 24h → hour, 7d/30d/90d → day, >90d → week", () => {
    expect(GROWTH_MAP_GRANULARITY).toEqual({ "24h": "hour", "7d": "day", "30d": "day", "90d": "day", "180d": "week", "365d": "week" });
  });

  it("accepts a granularity only when it is the one the timeframe selects — never a silent substitution", () => {
    expect(growthMapQuerySchema.safeParse({ timeframe: "30d", granularity: "day" }).success).toBe(true);
    expect(growthMapQuerySchema.safeParse({ timeframe: "24h", granularity: "hour" }).success).toBe(true);
    expect(growthMapQuerySchema.safeParse({ timeframe: "365d", granularity: "week" }).success).toBe(true);
    expect(growthMapQuerySchema.safeParse({ timeframe: "365d", granularity: "day" }).success).toBe(false);
    expect(growthMapQuerySchema.safeParse({ timeframe: "24h", granularity: "day" }).success).toBe(false);
    expect(growthMapQuerySchema.safeParse({ timeframe: "7d", granularity: "week" }).success).toBe(false);
  });
});

describe("STORY-066 AC5/AC12 · growth-map annotations", () => {
  const payload = {
    granularity: "week",
    timeframe: { from: "2026-04-30", to: "2026-10-26", timezone: "UTC" },
    series: [],
    milestones: [],
    annotations: {
      data_gaps: [],
      cadence_changes: [{ at: "2026-07-01", from: "weekly", to: "daily" }],
      scoring_version_changes: [{ at: "2026-08-03", from: "v1", to: "v2" }],
    },
    summary: {
      visibility_start: null,
      visibility_end: null,
      visibility_delta: null,
      best_engine: null,
      worst_engine: null,
      competitor_gap_start: null,
      competitor_gap_end: null,
    },
    point_count: 0,
  };

  it("carries cadence changes and scoring-version changes, at any granularity", () => {
    expect(growthMapResponseSchema.safeParse(payload).success).toBe(true);
    expect(growthMapResponseSchema.safeParse({ ...payload, granularity: "hour" }).success).toBe(true);
    expect(portalGrowthMapResponseSchema.safeParse(payload).success).toBe(true);
  });

  it("requires the scoring-version layer, so a payload cannot omit the boundary marker", () => {
    const { scoring_version_changes: _dropped, ...annotations } = payload.annotations;
    expect(growthMapResponseSchema.safeParse({ ...payload, annotations }).success).toBe(false);
  });

  it("rejects a granularity §13 does not define", () => {
    expect(growthMapResponseSchema.safeParse({ ...payload, granularity: "month" }).success).toBe(false);
  });
});
