import { describe, expect, it } from "vitest";
import type { GrowthMapResponse } from "../../../contracts/analytics/index.js";
import { portalGrowthMapResponseSchema } from "../../../contracts/portal/index.js";
import { ProjectOutOfScopeError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { assertPortalTab, competitorLabel, findCostFields, PORTAL_DEFAULT_TIMEFRAME, portalTimeframeDays, resolvePortalTimeframe, toPortalGrowthMap } from "./portal-view.js";

// NEW-E-099a — the pure rules of the portal read model. Scenario IDs are STORY-098 / STORY-099's.
const point = (d: string, v: number | null) => ({ d, visibility_score: v, sov: v === null ? null : 0.1, cells: v === null ? 0 : 12, live_ratio: v === null ? null : 1 });

function growth(): GrowthMapResponse {
  return {
    granularity: "day",
    timeframe: { from: "2026-10-01", to: "2026-10-02", timezone: "UTC" },
    series: [
      { series_id: "brand", label: "Acme", entity_type: "brand", color_role: "primary", points: [point("2026-10-01", 40), point("2026-10-02", null)], data_source: "live" },
      { series_id: "competitor:0198f6a0-0000-7000-8000-00000000000b", label: "Globex Corp", entity_type: "competitor", color_role: "comparison", points: [point("2026-10-01", 30), point("2026-10-02", 31)], data_source: "live" },
      { series_id: "competitor:0198f6a0-0000-7000-8000-00000000000a", label: "Initech", entity_type: "competitor", color_role: "comparison", points: [point("2026-10-01", 20), point("2026-10-02", 21)], data_source: "live" },
      { series_id: "competitor_baseline", label: "Competitor Baseline (median)", entity_type: "derived", color_role: "baseline", points: [point("2026-10-01", 25), point("2026-10-02", 26)], data_source: "live" },
    ],
    engines: [{ engine_key: "gemini", data_source: "live" }],
    milestones: [],
    annotations: { data_gaps: [], cadence_changes: [] },
    summary: { visibility_start: 40, visibility_end: null, visibility_delta: null, best_engine: null, worst_engine: null, competitor_gap_start: 10, competitor_gap_end: null },
    point_count: 8,
  };
}

describe("NEW-E-099a · resolvePortalTimeframe (timeframe_lock)", () => {
  it("STORY-098 s13 · no lock and no request: the platform default; a request is honoured", () => {
    expect(resolvePortalTimeframe(undefined, null)).toBe(PORTAL_DEFAULT_TIMEFRAME);
    expect(PORTAL_DEFAULT_TIMEFRAME).toBe("30d");
    expect(resolvePortalTimeframe("7d", null)).toBe("7d");
  });

  it("STORY-098 s13 · a locked token with no request, or the same request, gets the lock", () => {
    expect(resolvePortalTimeframe(undefined, "90d")).toBe("90d");
    expect(resolvePortalTimeframe("90d", "90d")).toBe("90d");
  });

  it("STORY-098 s13 · a request WIDER than the lock is refused as validation_failed naming `timeframe`, at every step of the ladder", () => {
    for (const [requested, lock] of [["30d", "7d"], ["90d", "30d"], ["7d", "24h"], ["90d", "24h"]] as const) {
      let thrown: unknown;
      try {
        resolvePortalTimeframe(requested, lock);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `${requested} under ${lock}`).toBeInstanceOf(ValidationFailedError);
    }
  });

  it("STORY-098 s13 · a request NARROWER than the lock is allowed (it cannot widen anything)", () => {
    expect(resolvePortalTimeframe("7d", "90d")).toBe("7d");
    expect(resolvePortalTimeframe("24h", "30d")).toBe("24h");
  });

  it("portalTimeframeDays · 24h is one day, not zero", () => {
    expect([portalTimeframeDays("24h"), portalTimeframeDays("7d"), portalTimeframeDays("30d"), portalTimeframeDays("90d")]).toEqual([1, 7, 30, 90]);
  });
});

describe("NEW-E-099a · assertPortalTab", () => {
  it("STORY-098 s10 · a tab outside the token's scope is project_out_of_scope; a tab inside is silent", () => {
    expect(() => assertPortalTab({ scopeTabs: ["overview"] }, "matrix")).toThrow(ProjectOutOfScopeError);
    expect(() => assertPortalTab({ scopeTabs: ["overview", "matrix"] }, "matrix")).not.toThrow();
    expect(() => assertPortalTab({ scopeTabs: [] }, "overview")).toThrow(ProjectOutOfScopeError);
  });
});

describe("NEW-E-099a · toPortalGrowthMap", () => {
  it("STORY-098 s11 · hide_competitors: labels become Competitor A/B/C in series order, ids stop naming the competitor, no real name survives", () => {
    const out = toPortalGrowthMap(growth(), { hideCompetitors: true });
    const competitors = out.series.filter((s) => s.entity_type === "competitor");
    expect(competitors.map((s) => s.label)).toEqual(["Competitor A", "Competitor B"]);
    expect(competitors.map((s) => s.series_id)).toEqual(["competitor_a", "competitor_b"]);
    const text = JSON.stringify(out);
    expect(text).not.toContain("Globex");
    expect(text).not.toContain("Initech");
    expect(text).not.toContain("0198f6a0-0000-7000-8000-00000000000b");
    expect(out.series.find((s) => s.series_id === "brand")!.label).toBe("Acme");
  });

  it("STORY-098 s11 · competitors visible: labels and ids are untouched", () => {
    const out = toPortalGrowthMap(growth(), { hideCompetitors: false });
    expect(out.series.map((s) => s.label)).toEqual(["Acme", "Globex Corp", "Initech", "Competitor Baseline (median)"]);
  });

  it("STORY-098 s12 · no point carries `cells`, whatever the settings, and the result satisfies the portal contract; null stays null", () => {
    for (const hideCompetitors of [true, false]) {
      const out = toPortalGrowthMap(growth(), { hideCompetitors });
      expect(portalGrowthMapResponseSchema.safeParse(out).success).toBe(true);
      for (const s of out.series) for (const p of s.points) expect("cells" in p).toBe(false);
      expect(out.series[0]!.points[1]!.visibility_score).toBeNull();
    }
  });

  it("competitorLabel · past Z it stays unique and never reuses a letter", () => {
    const labels = Array.from({ length: 30 }, (_, i) => competitorLabel(i));
    expect(labels[0]).toBe("Competitor A");
    expect(labels[25]).toBe("Competitor Z");
    expect(new Set(labels).size).toBe(30);
  });
});

describe("NEW-E-099a · findCostFields (the hide_costs key scan)", () => {
  it("STORY-098 s12 · finds quota, credit, cost and capture-count keys at any depth, with their paths", () => {
    const found = findCostFields({ a: { quota_used: 1, nested: [{ credits_remaining: 2 }] }, cells_total: 3, cost_usd: 4, price: 1 });
    expect(found).toEqual(expect.arrayContaining(["a.quota_used", "a.nested[0].credits_remaining", "cells_total", "cost_usd", "price"]));
  });

  it("STORY-098 s12 · the methodology footer's own fields are not cost fields (it is mandatory and unremovable)", () => {
    expect(findCostFields({ footer: { data_through: "2026-10-01", sample_size: 40, live_capture_ratio: 0.5, engines: ["gemini"], scoring_version: "v1" } })).toEqual([]);
  });

  it("an empty payload and a null value find nothing", () => {
    expect(findCostFields({})).toEqual([]);
    expect(findCostFields(null)).toEqual([]);
  });
});
