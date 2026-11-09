import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { PortalSessionContext } from "../../api/decorators/portal-route.decorator.js";
import { PortalReadsService, policyFingerprint } from "./portal-reads.service.js";

// NEW-E-099a — the allow-list is WIRED into the service. portal-view.spec.ts proves parsePortalPayload rejects an unknown
// key; these prove PortalReadsService actually calls it (and toPortalFooter) before a payload is cached or served. The
// stubs deliberately emit keys the cost-key scan does NOT know, so only the allow-list can stop them.
const WS = "0198f6a0-0000-7000-8000-000000000001";
const P1 = "0198f6a0-0000-7000-8000-0000000000b1";
const THEME = { theme_id: "0198f6a0-0000-7000-8000-0000000000aa", name: "Default", is_default: true, color_primary: null, color_accent: null, color_bg: null, color_fg: null, font_family: "Inter", logo_url: null, hide_nominara_brand: false, custom_css: null };

function session(hideCosts: boolean, tokenId = "0198f6a0-0000-7000-8000-0000000000a1"): PortalSessionContext {
  return {
    workspaceId: WS,
    tokenId,
    scopeProjectIds: [P1],
    scopeTabs: ["overview", "growth_map", "matrix"],
    themeId: null,
    policy: { label: "L", hideCompetitors: false, hideCosts, timeframeLock: null },
    facts: { workspace: { name: "Agency", timezone: "UTC", scoringVersion: "v1", entitlementOverrides: null }, theme: THEME, engines: new Map() },
  } as unknown as PortalSessionContext;
}

const fullFooter = { data_through: "2026-10-01", engines: ["gemini"], engine_data_sources: [{ engine_key: "gemini", data_source: "live" }], timeframe: "30d", sample_size: 3, live_capture_ratio: 1, scoring_version: "v1", weight_overrides: null, note: "n" };
const cards = { blended: { visibility_score: 50, visibility_delta: null, confidence: "high", metrics: { sentiment_score: null, citations_total: 2 } }, engines: [] };
const growth = {
  granularity: "day",
  timeframe: { from: "2026-10-01", to: "2026-10-02", timezone: "UTC" },
  series: [],
  engines: [],
  milestones: [],
  annotations: { data_gaps: [], cadence_changes: [] },
  summary: { visibility_start: null, visibility_end: null, visibility_delta: null, best_engine: null, worst_engine: null, competitor_gap_start: null, competitor_gap_end: null },
  point_count: 0,
};

function build(over: { footer?: Record<string, unknown>; growth?: Record<string, unknown> } = {}) {
  const footer = vi.fn(async () => over.footer ?? fullFooter);
  const svc = new PortalReadsService(
    { scorecards: vi.fn(async () => cards) } as never,
    { growthMap: vi.fn(async () => over.growth ?? growth) } as never,
    { footer } as never,
    { namesFor: vi.fn(async () => new Map([[P1, "Client One"]])) } as never,
    {} as never,
    {} as never,
  );
  return { svc, footer };
}

describe("NEW-E-099a · allow-list wiring in PortalReadsService", () => {
  it("a growth-map payload carrying a key no schema names is refused, not served (costs visible, so the cost-key scan is not what stops it)", async () => {
    const { svc } = build({ growth: { ...growth, probe_tally: 7 } });
    await expect(svc.growthMap(session(false), { project: P1 })).rejects.toBeInstanceOf(ZodError);
  });

  it("the same refusal under hide_costs, for a key the cost-key scan does not list", async () => {
    const { svc } = build({ growth: { ...growth, probe_tally: 7 } });
    await expect(svc.growthMap(session(true), { project: P1 })).rejects.toBeInstanceOf(ZodError);
  });

  it("an overview footer carrying an unknown key is refused, not served", async () => {
    const { svc } = build({ footer: { ...fullFooter, probe_tally: 7 } });
    await expect(svc.overview(session(false), {})).rejects.toBeInstanceOf(ZodError);
  });

  it("owner decision 2026-10-08 · hide_costs: the served footer has no sample_size, and every other footer field is kept", async () => {
    const { svc } = build();
    const out = await svc.overview(session(true), {});
    const served = out.projects[0]!.footer as Record<string, unknown>;
    expect("sample_size" in served).toBe(false);
    expect(served["note"]).toBe("n");
    expect(served["live_capture_ratio"]).toBe(1);
    expect(served["engines"]).toEqual(["gemini"]);
  });

  it("costs visible: the served footer keeps sample_size (including 0 — absent is not zero)", async () => {
    const { svc } = build({ footer: { ...fullFooter, sample_size: 0 } });
    const out = await svc.overview(session(false), {});
    expect(out.projects[0]!.footer.sample_size).toBe(0);
  });

  it("the hide_costs and costs-visible footers are not shared through the cache (policy is in the key)", async () => {
    const { svc } = build();
    const open = await svc.overview(session(false, "0198f6a0-0000-7000-8000-0000000000a2"), {});
    const hidden = await svc.overview(session(true, "0198f6a0-0000-7000-8000-0000000000a3"), {});
    expect(open.projects[0]!.footer.sample_size).toBe(3);
    expect("sample_size" in hidden.projects[0]!.footer).toBe(false);
  });
});

describe("owner decision 67 (o) · the portal cache follows a theme update", () => {
  it("the cache fingerprint changes when the theme's content changes, and not otherwise (so an edit is served on the next request, not after 60 s)", () => {
    const a = session(false);
    const same = session(false);
    const edited = session(false);
    (edited.facts as { theme: unknown }).theme = { ...THEME, color_primary: "#112233" };
    const css = session(false);
    (css.facts as { theme: unknown }).theme = { ...THEME, custom_css: ".nm-card{color:var(--nm-color-fg)}" };
    expect(policyFingerprint(same)).toBe(policyFingerprint(a));
    expect(policyFingerprint(edited)).not.toBe(policyFingerprint(a));
    expect(policyFingerprint(css)).not.toBe(policyFingerprint(a));
  });
});

// Decision 83 (c) — PortalReadsService.sources
describe("decision 83 (c) · PortalReadsService.sources", () => {
  const indexRow = { domain: "reddit.com", influence: 0.5, citations: 2, prompts: 1, source_class: "community_forum", brand_present: null, verified_at: null, gap_severity: null, seedable: true, top_urls: [], competitors_present: [] };
  const index = { window: { from: "2026-10-10", to: "2026-11-09" }, source_coverage: null, domains: [indexRow] };
  function sourcesService(over: Partial<Record<string, unknown>> = {}) {
    const sourceIndex = vi.fn(async () => ({ ...index, ...over }));
    const svc = new PortalReadsService({} as never, {} as never, {} as never, {} as never, {} as never, { sourceIndex } as never);
    return { svc, sourceIndex };
  }
  const withTabs = (tabs: string[], lock: string | null = null, hideCosts = false): PortalSessionContext => {
    const base = session(hideCosts, "0198f6a0-0000-7000-8000-0000000000c1");
    return { ...base, scopeTabs: tabs, policy: { ...base.policy, timeframeLock: lock } } as unknown as PortalSessionContext;
  };

  it("D83C-U1 reads the index for the in-scope project in the workspace timezone the interceptor supplied, on the window asked for", async () => {
    const { svc, sourceIndex } = sourcesService();
    const out = await svc.sources(withTabs(["sources"]), { project: P1, timeframe: "7d" });
    expect(sourceIndex).toHaveBeenCalledWith(P1, { timeframe: "7d" }, { portal: { timezone: "UTC" } });
    expect(out.domains[0]).not.toHaveProperty("seedable");
  });

  it("D83C-U2 a tab outside scope_tabs and a project outside scope read nothing", async () => {
    const { svc, sourceIndex } = sourcesService();
    await expect(svc.sources(withTabs(["overview"]), { project: P1 })).rejects.toThrow();
    await expect(svc.sources(withTabs(["sources"]), { project: "0198f6a0-0000-7000-8000-0000000000ff" })).rejects.toThrow();
    expect(sourceIndex).not.toHaveBeenCalled();
  });

  it("D83C-U3 a 24-hour lock has no source window: refused before any read, never served a wider window", async () => {
    const { svc, sourceIndex } = sourcesService();
    await expect(svc.sources(withTabs(["sources"], "24h"), { project: P1 })).rejects.toThrow(/7, 30 or 90 days/);
    expect(sourceIndex).not.toHaveBeenCalled();
  });

  it("D83C-U4 a key no schema names is refused, not served (the allow-list is wired for sources)", async () => {
    const { svc } = sourcesService({ domains: [{ ...indexRow, probe_tally: 7 }] });
    // toPortalSources builds the row field by field, so a smuggled agency key never reaches the parse: prove the parse itself by a source that is malformed.
    await expect(svc.sources(withTabs(["sources"]), { project: P1 })).resolves.toMatchObject({ domains: [{ domain: "reddit.com" }] });
    const { svc: bad } = sourcesService({ source_coverage: 140 });
    await expect(bad.sources(withTabs(["sources"], null, false), { project: P1 })).rejects.toBeInstanceOf(ZodError);
  });
});
