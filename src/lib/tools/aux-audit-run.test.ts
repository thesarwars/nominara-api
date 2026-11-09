import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_ROWS } from "../../../test/support/aux-rules.js";
import { auxAuditToolResultSchema } from "../../../contracts/tools/index.js";
import { GuardedFetchRefusal, type GuardedResponse } from "../net/guarded-fetch.js";
import { findingView } from "../aux/finding-view.js";
import { runToolAudit, type ToolAuditDeps, type ToolCatalogRow } from "./aux-audit-run.js";
import type { Renderer } from "../aux/renderer.js";

// STORY-082 - the audit tool's worker core, over the existing crawl pieces and a fake network. Scenario numbers are the story's Test scenarios table.

const ORIGIN = "https://acme.example";
const ROOT_URL = new URL("/", ORIGIN).href;
const CATALOG: ToolCatalogRow[] = CATALOG_ROWS.map((r) => ({ code: r.code, category: r.category, title: r.title, weight: r.weight, rule_version: r.ruleVersion, thresholds: r.thresholds, task_threshold: r.taskThreshold, auto_fixable: r.autoFixable, rationale: r.rationale }));

const BROKEN_JSONLD = `<html><head><title>Acme</title><script type="application/ld+json">{ "@context": "https://schema.org", "@type": </script></head><body><main><h1>Acme</h1><p>Acme makes widgets for teams.</p></main></body></html>`;
const GOOD = `<html><head><title>Acme widgets</title></head><body><main><h1>Acme widgets</h1><p>Acme makes widgets for teams.</p></main></body></html>`;
const ROBOTS = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nSitemap: https://acme.example/sitemap.xml\n";
const SITEMAP = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${ORIGIN}/a</loc></url><url><loc>${ORIGIN}/b</loc></url></urlset>`;

const reply = (status: number, body: string, type = "text/html"): GuardedResponse => ({ status, headers: { "content-type": type }, body: Buffer.from(body), finalUrl: ORIGIN });

interface Net {
  routes: Record<string, GuardedResponse | "refuse" | "throw">;
  fetched: string[];
  rendered: string[];
}
function net(routes: Net["routes"] = {}): { deps: ToolAuditDeps; state: Net } {
  const state: Net = {
    routes: {
      "/robots.txt": reply(200, ROBOTS, "text/plain"),
      "/llms.txt": reply(404, ""),
      "/.well-known/llms.txt": reply(404, ""),
      "/sitemap.xml": reply(200, SITEMAP, "application/xml"),
      "/": reply(200, BROKEN_JSONLD),
      "/a": reply(200, GOOD),
      "/b": reply(200, GOOD),
      ...routes,
    },
    fetched: [],
    rendered: [],
  };
  let clock = 0;
  const renderer: Renderer = {
    render: async (url) => {
      state.rendered.push(url);
      return { html: GOOD, finalUrl: url, status: 200 };
    },
  };
  const deps: ToolAuditDeps = {
    fetch: async (url) => {
      state.fetched.push(new URL(url).pathname);
      const hit = state.routes[new URL(url).pathname] ?? reply(404, "");
      if (hit === "refuse") throw new GuardedFetchRefusal("address_not_global");
      if (hit === "throw") throw new Error("connect ECONNREFUSED 10.0.0.5:443");
      return hit;
    },
    renderer,
    now: () => new Date("2026-11-06T10:00:00.000Z"),
    nowMs: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { deps, state };
}

const input = (over: Partial<Parameters<typeof runToolAudit>[0]> = {}): Parameters<typeof runToolAudit>[0] => ({ url: ROOT_URL, mode: "full", pages: 3, verified: true, credits: 10, catalog: CATALOG, ...over });
const done = async (over: Partial<Parameters<typeof runToolAudit>[0]>, n = net()) => {
  const out = await runToolAudit(input(over), n.deps);
  if (out.kind !== "done") throw new Error(`expected a result, got ${out.kind}`);
  return { out, result: out.result, state: n.state };
};

describe("STORY-082 - site-files mode", () => {
  it("scenario 3 - the output is framed as AI agent access, per agent, not as a file dump", async () => {
    const { result, state } = await done({ mode: "site_files" });
    const gpt = result.site_files.agents.find((a) => a.agent === "GPTBot");
    expect(gpt?.access).toBe("blocked");
    expect(gpt?.meaning).toMatch(/GPTBot/u);
    expect(result.site_files.agents.find((a) => a.agent === "ClaudeBot")?.access).toBe("allowed");
    expect(result.site_files.summary).toMatch(/AI/u);
    expect(JSON.stringify(result)).not.toContain("User-agent:");
    expect(result.audit).toBeNull();
    // Only the well-known site files were requested: no page.
    expect(state.fetched.every((p) => ["/robots.txt", "/llms.txt", "/.well-known/llms.txt", "/sitemap.xml"].includes(p))).toBe(true);
    expect(auxAuditToolResultSchema.safeParse(result).success).toBe(true);
  });

  it("an unreadable robots.txt is 'unknown' for every agent, never 'allowed'", async () => {
    const { result } = await done({ mode: "site_files" }, net({ "/robots.txt": reply(503, "") }));
    expect(result.site_files.agents.every((a) => a.access === "unknown")).toBe(true);
  });
});

describe("STORY-082 - the full audit", () => {
  it("scenario 4 - raw AND rendered fetch for every page, all rules applied, a score, findings and patches", async () => {
    const { result, state } = await done({});
    const audit = result.audit!;
    expect(audit.pages.raw_fetched).toBe(3);
    expect(audit.pages.rendered_fetched).toBe(3);
    expect(state.rendered).toHaveLength(3);
    expect(audit.pages.judged).toBe(3);
    expect(audit.score.value).not.toBeNull();
    expect(audit.findings.length).toBeGreaterThan(0);
    expect(audit.findings.some((f) => f.rule_code === "AUX-R-008")).toBe(true);
    expect(audit.patches_included).toBeGreaterThan(0);
    expect(auxAuditToolResultSchema.safeParse(result).success).toBe(true);
  });

  it("scenario 5 - the charge names the band, includes the site files and prices the patches at 0", async () => {
    const { result } = await done({});
    expect(result.audit!.charge).toEqual({ credits: 10, band_label: "up to 25 pages", site_files_included: true, patches_credits: 0 });
  });

  it("scenario 6 - every patch is included at no additional charge", async () => {
    const { result } = await done({});
    const patched = result.audit!.findings.filter((f) => f.patch !== null);
    expect(patched.length).toBe(result.audit!.patches_included);
    expect(patched.length).toBeGreaterThan(0);
    for (const f of patched) expect(f.patch).toMatchObject({ free: true, credits_charged: 0 });
  });

  it("scenario 8 - a finding leads with the AI consequence, built by the in-project renderer", async () => {
    const { result } = await done({});
    const finding = result.audit!.findings.find((f) => f.rule_code === "AUX-R-008")!;
    expect(Object.keys(finding)[0]).toBe("consequence");
    expect(finding.consequence).toBe(CATALOG.find((r) => r.code === "AUX-R-008")!.rationale);
    const { patch: _patch, ...view } = finding;
    expect(view).toEqual(findingView(view));
    // Not a second copy: the tool and the project's findings both import the one renderer.
    const here = readFileSync(new URL("./aux-audit-run.ts", import.meta.url), "utf8");
    const there = readFileSync(new URL("../../modules/aux/aux.service.ts", import.meta.url), "utf8");
    expect(here).toMatch(/from "\.\.\/aux\/finding-view\.js"/u);
    expect(there).toMatch(/from "\.\.\/\.\.\/lib\/aux\/finding-view\.js"/u);
  });
});

describe("STORY-082 - verification controls scope, not price", () => {
  it("scenario 9 - an unverified domain: the supplied URL only, same charge, excluded rules named, excluded weight stated", async () => {
    const unverified = await done({ verified: false });
    const verified = await done({ verified: true });
    const a = unverified.result.audit!;
    expect(unverified.result.scope).toBe("public_surface");
    expect(unverified.result.domain_verified).toBe(false);
    expect(a.pages.judged).toBe(1);
    expect(a.charge).toEqual(verified.result.audit!.charge);
    expect(a.excluded_rules.length).toBeGreaterThan(0);
    expect(a.excluded_rules.every((r) => r.reason.length > 0 && r.title.length > 0)).toBe(true);
    expect(a.score.excluded_weight_points).toBeGreaterThan(0);
    expect(a.scope_note).toMatch(/not verified/iu);
    expect(a.scope_note).toMatch(/same price/iu);
  });

  it("scenario 10 - the score on an unverified domain is labelled partial, never presented as full", async () => {
    const { result } = await done({ verified: false });
    const score = result.audit!.score;
    expect(score.partial).toBe(true);
    expect(score.label).toMatch(/^Partial score/u);
    expect(score.label).toContain(String(score.excluded_weight_points));
  });

  it("scenario 11 - verify the domain and re-audit: more pages judged, no note, price unchanged", async () => {
    const before = await done({ verified: false });
    const after = await done({ verified: true });
    expect(after.result.scope).toBe("key_pages");
    expect(after.result.audit!.pages.judged).toBeGreaterThan(before.result.audit!.pages.judged);
    expect(after.result.audit!.scope_note).toBeNull();
    expect(after.result.audit!.charge.credits).toBe(before.result.audit!.charge.credits);
  });
});

describe("STORY-082 - the fetch path and its failures", () => {
  it("scenario 12 - an internal address is refused by the existing forgery guard: nothing audited, nothing delivered", async () => {
    const out = await runToolAudit(input(), net({ "/robots.txt": "refuse", "/llms.txt": "refuse", "/.well-known/llms.txt": "refuse", "/sitemap.xml": "refuse" }).deps);
    expect(out.kind).toBe("unreachable");
    const source = readFileSync(new URL("./aux-audit-run.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:https?|undici|\bfetch\(|axios|got\(/u);
  });

  it("scenario 13 - every page unreachable: nothing delivered, so the run is refunded in full", async () => {
    const { out, result } = await done({}, net({ "/": "throw", "/a": "throw", "/b": "throw" }));
    expect(out.delivered).toBe(false);
    expect(result.audit!.pages.judged).toBe(0);
    expect(result.audit!.score.value).toBeNull();
    expect(result.audit!.pages.unreachable.map((p) => new URL(p.url).pathname).sort()).toEqual(["/", "/a", "/b"]);
  });

  it("scenario 14 - some pages unreachable: delivered and charged in full, the unreachable pages named", async () => {
    const { out, result } = await done({}, net({ "/b": "throw" }));
    expect(out.delivered).toBe(true);
    expect(result.audit!.charge.credits).toBe(10);
    expect(result.audit!.pages.unreachable.map((p) => new URL(p.url).pathname)).toEqual(["/b"]);
    expect(result.audit!.pages.judged).toBe(2);
  });

  it("the stored result fits the 24 KB column with room, and anything left out is counted", async () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`/p${String(i)}`, reply(200, BROKEN_JSONLD)]));
    const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Object.keys(many).map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`).join("")}</urlset>`;
    const { result } = await done({ pages: 25 }, net({ ...many, "/sitemap.xml": reply(200, sitemap, "application/xml") }));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(22_000);
    expect(result.audit!.findings.length + result.audit!.findings_omitted).toBe(result.audit!.findings_total);
  });
});
