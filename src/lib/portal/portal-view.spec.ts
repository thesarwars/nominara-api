import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { GrowthMapResponse, SourceIndexResponse } from "../../../contracts/analytics/index.js";
import { portalGrowthMapResponseSchema } from "../../../contracts/portal/index.js";
import type { MethodologyFooter } from "../../../contracts/reports/index.js";
import { ProjectOutOfScopeError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { assertPortalTab, competitorLabel, findCostFields, parsePortalPayload, PORTAL_DEFAULT_TIMEFRAME, portalTimeframeDays, resolvePortalTimeframe, toPortalFooter, toPortalGrowthMap, toPortalSources } from "./portal-view.js";

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
    annotations: { data_gaps: [], cadence_changes: [], scoring_version_changes: [] },
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
  it("NEW-E-099a audit · the overview's own hide_costs policy flag (a boolean at the top level) is not a cost field, but a cost value under that name is", () => {
    expect(findCostFields({ hide_costs: true, hide_competitors: false })).toEqual([]);
    expect(findCostFields({ hide_costs: 12.5 })).toEqual(["hide_costs"]);
    expect(findCostFields({ projects: [{ hide_costs: true }] })).toEqual(["projects[0].hide_costs"]);
  });

  it("STORY-098 s12 · finds quota, credit, cost and capture-count keys at any depth, with their paths", () => {
    const found = findCostFields({ a: { quota_used: 1, nested: [{ credits_remaining: 2 }] }, cells_total: 3, cost_usd: 4, price: 1 });
    expect(found).toEqual(expect.arrayContaining(["a.quota_used", "a.nested[0].credits_remaining", "cells_total", "cost_usd", "price"]));
  });

  it("STORY-098 s12 · owner decision 2026-10-08: sample_size is a capture-count-derived figure, so the scan flags it under hide_costs; live_capture_ratio (a ratio) stays clean", () => {
    expect(findCostFields({ footer: { data_through: "2026-10-01", sample_size: 40, engines: ["gemini"], scoring_version: "v1" } })).toEqual(["footer.sample_size"]);
    expect(findCostFields({ footer: { data_through: "2026-10-01", live_capture_ratio: 0.5, engines: ["gemini"], scoring_version: "v1" } })).toEqual([]);
  });

  it("an empty payload and a null value find nothing", () => {
    expect(findCostFields({})).toEqual([]);
    expect(findCostFields(null)).toEqual([]);
  });
});

// NEW-E-099a audit finding 3 — the cost-key scan is a denylist; the response schemas are the allow-list. A key no
// schema names (captures, n_captures, runs_used, capture_total ...) must fail closed on the way out.
const NO_HIDE = { hideCosts: false } as const;
describe("NEW-E-099a audit · parsePortalPayload (strict allow-list on the way out)", () => {
  const footer = { data_through: "2026-10-01", engines: ["gemini"], engine_data_sources: [{ engine_key: "gemini", data_source: "live" }], timeframe: "30d", sample_size: 3, live_capture_ratio: 1, scoring_version: "v1", weight_overrides: null, note: "n" } as const;
  const theme = { theme_id: "0198f6a0-0000-7000-8000-0000000000aa", name: "Default", is_default: true, color_primary: null, color_accent: null, color_bg: null, color_fg: null, font_family: "Inter", logo_url: null, hide_nominara_brand: false, custom_css: null } as const;
  const overview = (extra: Record<string, unknown> = {}, projectExtra: Record<string, unknown> = {}) => ({
    agency: "A", theme, label: "L", tabs: ["overview"], hide_competitors: false, hide_costs: true, timeframe: "30d", timeframe_locked: false,
    projects: [{ id: "0198f6a0-0000-7000-8000-00000000000a", name: "P", visibility: 1, delta: null, confidence: "high", sentiment: null, citations: 0, footer, ...projectExtra }],
    ...extra,
  });

  it("an overview that matches its schema passes", () => {
    expect(() => parsePortalPayload("overview", overview(), NO_HIDE)).not.toThrow();
  });

  it.each(["captures", "n_captures", "runs_used", "capture_total"])("an unknown key %s on an overview project fails closed", (key) => {
    expect(() => parsePortalPayload("overview", overview({}, { [key]: 4 }), NO_HIDE)).toThrow(ZodError);
  });

  it("an unknown top-level key on an overview fails closed", () => {
    expect(() => parsePortalPayload("overview", overview({ runs_used: 1 }), NO_HIDE)).toThrow(ZodError);
  });

  it("an unknown key on a matrix engine fails closed", () => {
    expect(() => parsePortalPayload("matrix", { engines: [{ engine_key: "gemini", data_source: "live", visibility_score: 1, presence_rate: 1, share_of_voice: 1, captures: 9 }] }, NO_HIDE)).toThrow(ZodError);
  });

  it("a growth-map point that still carries cells fails closed", () => {
    const withCells = { ...growth(), series: growth().series.map((s) => ({ ...s })) };
    expect(() => parsePortalPayload("growth_map", withCells, NO_HIDE)).toThrow(ZodError);
    expect(() => parsePortalPayload("growth_map", toPortalGrowthMap(growth(), { hideCompetitors: false }), NO_HIDE)).not.toThrow();
  });

  it("an unknown key on a task row fails closed", () => {
    expect(() => parsePortalPayload("tasks", { completed: [], open: [{ title: "t", severity: null, status: "todo", credits_spent: 3 }] }, NO_HIDE)).toThrow(ZodError);
  });
});

// Owner decision 2026-10-08: when costs are hidden the footer drops sample_size. The footer itself stays (NFR-AGY-05).
describe("NEW-E-099a hide_costs footer · sample_size dropped, enforced by the allow-list", () => {
  const base: MethodologyFooter = { data_through: "2026-10-01", engines: ["gemini"], engine_data_sources: [{ engine_key: "gemini", data_source: "live" }], timeframe: "30d", sample_size: 3, live_capture_ratio: 1, scoring_version: "v1", weight_overrides: null, note: "n" };
  const { sample_size: _dropped, ...hiddenFooter } = base;
  const fullFooter = base;
  const theme = { theme_id: "0198f6a0-0000-7000-8000-0000000000aa", name: "Default", is_default: true, color_primary: null, color_accent: null, color_bg: null, color_fg: null, font_family: "Inter", logo_url: null, hide_nominara_brand: false, custom_css: null } as const;
  const overview = (footer: Record<string, unknown>, hide: boolean) => ({
    agency: "A", theme, label: "L", tabs: ["overview"], hide_competitors: false, hide_costs: hide, timeframe: "30d", timeframe_locked: false,
    projects: [{ id: "0198f6a0-0000-7000-8000-00000000000a", name: "P", visibility: 1, delta: null, confidence: "high", sentiment: null, citations: 0, footer }],
  });

  it("hide_costs: a footer that still carries sample_size fails closed", () => {
    expect(() => parsePortalPayload("overview", overview(fullFooter, true), { hideCosts: true })).toThrow(ZodError);
  });

  it("hide_costs: a footer without sample_size is served, and every other footer field is still required", () => {
    expect(() => parsePortalPayload("overview", overview(hiddenFooter, true), { hideCosts: true })).not.toThrow();
    const { note: _note, ...noNote } = hiddenFooter;
    expect(() => parsePortalPayload("overview", overview(noNote, true), { hideCosts: true })).toThrow(ZodError);
  });

  it("costs visible: the footer keeps sample_size, and one missing fails closed (absent is not silently zero)", () => {
    expect(() => parsePortalPayload("overview", overview(fullFooter, false), { hideCosts: false })).not.toThrow();
    expect(() => parsePortalPayload("overview", overview(hiddenFooter, false), { hideCosts: false })).toThrow(ZodError);
  });

  it("toPortalFooter drops exactly sample_size under hide_costs and returns the footer untouched otherwise", () => {
    expect(toPortalFooter(fullFooter, { hideCosts: true })).toEqual(hiddenFooter);
    expect(toPortalFooter(fullFooter, { hideCosts: false })).toEqual(fullFooter);
  });
});

// Decision 83 (c) — the portal's Sources projection of the agency source index.
describe("decision 83 (c) · toPortalSources", () => {
  const domain = (over: Partial<SourceIndexResponse["domains"][number]> = {}): SourceIndexResponse["domains"][number] => ({
    domain: "reddit.com",
    influence: 0.5,
    citations: 12,
    prompts: 0,
    source_class: "community_forum",
    brand_present: null,
    verified_at: null,
    gap_severity: null,
    seedable: true,
    top_urls: [{ url: "https://reddit.com/r/x", citations: 3, last_seen: "2026-11-01" }],
    competitors_present: [],
    ...over,
  });
  const source = (domains: SourceIndexResponse["domains"], coverage: number | null = null): SourceIndexResponse => ({ window: { from: "2026-10-10", to: "2026-11-09" }, source_coverage: coverage, domains });
  const open = { hideCosts: false, hideCompetitors: false };

  it("drops the fields the portal never serves (seedable, last_seen) and keeps null and 0 distinct: unverified stays null, zero prompts stays 0", () => {
    const out = toPortalSources(source([domain()], null), open);
    expect(out.domains[0]).toEqual({
      domain: "reddit.com",
      influence: 0.5,
      citations: 12,
      prompts: 0,
      source_class: "community_forum",
      brand_present: null,
      verified_at: null,
      gap_severity: null,
      top_urls: [{ url: "https://reddit.com/r/x", citations: 3 }],
      competitors_present: [],
    });
    expect(out.source_coverage).toBeNull();
    expect(toPortalSources(source([], 0), open).source_coverage).toBe(0);
  });

  it("hide_costs drops citations and prompts (and the per-url citation count) and nothing else", () => {
    const out = toPortalSources(source([domain({ citations: 0, prompts: 0 })]), { ...open, hideCosts: true });
    expect(out.domains[0]).toEqual({
      domain: "reddit.com",
      influence: 0.5,
      source_class: "community_forum",
      brand_present: null,
      verified_at: null,
      gap_severity: null,
      top_urls: [{ url: "https://reddit.com/r/x" }],
      competitors_present: [],
    });
  });

  it("hide_competitors drops a competitor's OWN domain (its name is the domain) and passes every other row through with no competitor named", () => {
    const rows = [domain({ domain: "globex.test", source_class: "vendor_owned", competitors_present: ["Globex Rival Industries"] }), domain({ domain: "reddit.com" })];
    const hidden = toPortalSources(source(rows), { ...open, hideCompetitors: true });
    expect(hidden.domains.map((d) => d.domain)).toEqual(["reddit.com"]);
    expect(JSON.stringify(hidden)).not.toMatch(/Globex|globex/);
    const visible = toPortalSources(source(rows), open);
    expect(visible.domains.map((d) => [d.domain, d.competitors_present])).toEqual([["globex.test", ["Globex Rival Industries"]], ["reddit.com", []]]);
  });

  it("the allow-list: costs visible requires the counts, hide_costs refuses them, and an unknown key fails closed", () => {
    const visible = toPortalSources(source([domain()]), open);
    const hidden = toPortalSources(source([domain()]), { ...open, hideCosts: true });
    expect(() => parsePortalPayload("sources", visible, { hideCosts: false })).not.toThrow();
    expect(() => parsePortalPayload("sources", hidden, { hideCosts: true })).not.toThrow();
    expect(() => parsePortalPayload("sources", visible, { hideCosts: true })).toThrow(ZodError);
    expect(() => parsePortalPayload("sources", hidden, { hideCosts: false })).toThrow(ZodError);
    expect(() => parsePortalPayload("sources", { ...visible, domains: [{ ...visible.domains[0], seedable: true }] }, { hideCosts: false })).toThrow(ZodError);
    expect(findCostFields(hidden)).toEqual([]);
  });
});
