import { describe, expect, it } from "vitest";
import {
  portalSourcesCostsHiddenSchema,
  portalSourcesCostsVisibleSchema,
  portalSourcesQuerySchema,
  portalSourcesResponseSchema,
} from "./portal-read.schema.js";

// Decision 83(c) — GET /v1/portal/sources. The query is strict; the response matches what the source index can hold (a domain
// of class `other`, an unverified domain with no gap severity), and under hide_costs the citations and prompts counts are absent.
describe("decision 83(c) · portal sources contract", () => {
  const project = "0198f6a0-0000-7000-8000-000000000001";
  const domain = {
    domain: "reddit.com",
    influence: 0.4,
    citations: 12,
    prompts: 5,
    source_class: "community_forum",
    brand_present: null,
    verified_at: null,
    gap_severity: null,
    top_urls: [{ url: "https://reddit.com/r/x", citations: 3 }],
    competitors_present: [],
  };
  const body = (d: object) => ({ window: { from: "2026-10-10", to: "2026-11-09" }, source_coverage: null, domains: [d] });

  it("the query is strict: a project, an optional 7d|30d|90d timeframe, nothing else", () => {
    expect(portalSourcesQuerySchema.safeParse({ project }).success).toBe(true);
    for (const timeframe of ["7d", "30d", "90d"]) expect(portalSourcesQuerySchema.safeParse({ project, timeframe }).success, timeframe).toBe(true);
    expect(portalSourcesQuerySchema.safeParse({ project, timeframe: "24h" }).success, "the index has no 24h window").toBe(false);
    expect(portalSourcesQuerySchema.safeParse({ project, workspace_id: project }).success).toBe(false);
    expect(portalSourcesQuerySchema.safeParse({}).success).toBe(false);
  });

  it("a domain of class `other` and an unverified domain (null severity) are servable, not a parse failure", () => {
    expect(portalSourcesResponseSchema.safeParse(body({ ...domain, source_class: "other" })).success).toBe(true);
    expect(portalSourcesResponseSchema.safeParse(body({ ...domain, gap_severity: null, brand_present: null })).success).toBe(true);
    expect(portalSourcesResponseSchema.safeParse(body({ ...domain, source_class: "forum" })).success).toBe(false);
  });

  it("costs visible: citations and prompts (and per-url citations) are required; hide_costs: they are absent and a present one is refused", () => {
    expect(portalSourcesCostsVisibleSchema.safeParse(body(domain)).success).toBe(true);
    const { citations: _c, prompts: _p, ...bare } = domain;
    const hiddenDomain = { ...bare, top_urls: [{ url: "https://reddit.com/r/x" }] };
    expect(portalSourcesCostsVisibleSchema.safeParse(body(hiddenDomain)).success).toBe(false);
    expect(portalSourcesCostsHiddenSchema.safeParse(body(hiddenDomain)).success).toBe(true);
    expect(portalSourcesCostsHiddenSchema.safeParse(body(domain)).success).toBe(false);
    expect(portalSourcesCostsHiddenSchema.safeParse(body({ ...hiddenDomain, citations: 12 })).success).toBe(false);
  });

  it("the published schema is the union a client types against (citations and prompts optional), and stays strict", () => {
    const { citations: _c, prompts: _p, ...bare } = domain;
    expect(portalSourcesResponseSchema.safeParse(body(bare)).success).toBe(true);
    expect(portalSourcesResponseSchema.safeParse(body({ ...domain, seedable: true })).success).toBe(false);
  });
});
