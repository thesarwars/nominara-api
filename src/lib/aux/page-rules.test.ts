import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { CrawlManifest } from "../../../contracts/aux/index.js";
import { CATALOG } from "../../../test/support/aux-rules.js";
import { makeDoc } from "../../../test/support/aux-document.js";
import { evaluablePageRules, pageFindingFingerprint, runPageRules } from "./page-rules.js";
import { AuxRuleConfigError } from "./rules/engine.js";
import { AUX_RULES } from "./rules/index.js";
import type { AuxRule } from "./rules/types.js";
import { generatePagePatch } from "./patches/page-patch.js";

// Wraps the real generator so one test can make it crash; every other test runs the real one.
vi.mock("./patches/page-patch.js", async (original) => {
  const real = await original<typeof import("./patches/page-patch.js")>();
  return { ...real, generatePagePatch: vi.fn(real.generatePagePatch) };
});

// STORY-051 AC13 / STORY-052 AC1, AC9 - the page rule engine over a crawl's stored pages: which rules could be decided on which
// page, which findings came out, and which pages could not be modelled.

const PROJECT_ID = "00000000-0000-7000-8000-000000000001";
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

const GOOD = `<html><head><title>Acme</title></head><body><main><h1>Acme</h1><p>Acme makes widgets for teams.</p></main></body></html>`;
// A JSON-LD block that is not JSON: AUX-R-008 (critical).
const BROKEN_JSONLD = `<html><head><title>Acme</title><script type="application/ld+json">{ "@context": "https://schema.org", "@type": </script></head><body><main><h1>Acme</h1><p>Acme makes widgets for teams.</p></main></body></html>`;

interface Spec {
  readonly url: string;
  readonly raw?: string;
  readonly rendered?: string;
  readonly fetch?: boolean;
  readonly ttfbMs?: number | null;
  readonly loadMs?: number | null;
}

function fixture(specs: readonly Spec[]) {
  const objects = new Map<string, Buffer>();
  const pages: CrawlManifest["pages"] = specs.map((s, i) => {
    const copy = (html: string, kind: string) => {
      const key = `crawl/a1/${i}.${kind}.html.gz`;
      objects.set(key, gzipSync(Buffer.from(html)));
      return { object_key: key, sha256: sha(html), bytes: Buffer.byteLength(html), status: 200, truncated: false };
    };
    return {
      url: s.url,
      outcome: s.raw === undefined ? ("failed" as const) : ("ok" as const),
      ...(s.raw === undefined ? {} : { raw: copy(s.raw, "raw") }),
      ...(s.rendered === undefined ? {} : { rendered: copy(s.rendered, "rendered") }),
      ...(s.raw !== undefined && s.fetch !== false
        ? { fetch: { final_url: s.url, redirect_chain: [], http_status: 200, headers: {}, ttfb_ms: s.ttfbMs ?? null, load_ms: s.loadMs ?? null } }
        : {}),
      failures: [],
    };
  });
  const read = async (key: string): Promise<Buffer> => {
    const b = objects.get(key);
    if (b === undefined) throw new Error("no such object");
    return b;
  };
  return { pages, read, objects };
}

const run = (specs: readonly Spec[], read?: (k: string) => Promise<Buffer>) => {
  const f = fixture(specs);
  return runPageRules(f.pages, read ?? f.read, CATALOG, { projectId: PROJECT_ID });
};

describe("STORY-051 AC13 · evaluablePageRules: which rules a page could actually decide", () => {
  it("AUXLIVE-2 · a page with no rendered copy and no timing cannot decide AUX-R-026, AUX-R-027 or AUX-R-029", () => {
    const set = evaluablePageRules(makeDoc({ rendered: null, timing: { ttfbMs: null, loadMs: null, bytes: 10 } }));
    for (const code of ["AUX-R-026", "AUX-R-027", "AUX-R-029"]) expect(set.has(code), code).toBe(false);
    expect(set.has("AUX-R-008")).toBe(true);
  });

  it("AUXLIVE-2 · a rendered copy brings back AUX-R-026 and AUX-R-027; a measured timing (even 0 ms) brings back AUX-R-029", () => {
    const withRendered = evaluablePageRules(makeDoc({ timing: { ttfbMs: null, loadMs: null, bytes: 10 } }));
    expect(withRendered.has("AUX-R-026") && withRendered.has("AUX-R-027")).toBe(true);
    expect(withRendered.has("AUX-R-029")).toBe(false);
    expect(evaluablePageRules(makeDoc({ rendered: null, timing: { ttfbMs: 0, loadMs: null, bytes: 10 } })).has("AUX-R-029")).toBe(true);
    expect(evaluablePageRules(makeDoc({ rendered: null, timing: { ttfbMs: null, loadMs: 0, bytes: 10 } })).has("AUX-R-029")).toBe(true);
  });

  it("AUXLIVE-2 · only rules the engine runs are ever reported: AUX-R-013 is among them since the hold was released (STORY-187)", () => {
    const set = evaluablePageRules(makeDoc());
    expect(set.has("AUX-R-013")).toBe(true);
    expect([...set].sort()).toEqual(AUX_RULES.map((r) => r.code).sort());
  });
});

describe("STORY-051 AC13 · runPageRules over stored pages", () => {
  it("AUXLIVE-2 · a stored page with broken JSON-LD yields an AUX-R-008 finding with the page URL and the rule-finding evidence shape", async () => {
    const out = await run([{ url: "https://acme.com/", raw: BROKEN_JSONLD, rendered: BROKEN_JSONLD, ttfbMs: 40, loadMs: 90 }]);
    const f = out.findings.find((x) => x.rule_code === "AUX-R-008");
    expect(f).toBeDefined();
    expect(f!.url).toBe("https://acme.com/");
    expect(f!.severity).toBe("critical");
    expect(Object.keys(f!.evidence).sort()).toEqual(["locator", "reason", "snippet"]);
    expect(out.evaluated.get("https://acme.com/")?.has("AUX-R-008")).toBe(true);
    expect(out.unmodelled).toEqual([]);
  });

  it("AUXLIVE-2 · a clean stored page yields no finding but is still recorded as evaluated, with the rules it could decide", async () => {
    const out = await run([{ url: "https://acme.com/", raw: GOOD, rendered: GOOD, ttfbMs: 40, loadMs: 90 }]);
    expect(out.findings.filter((f) => f.rule_code === "AUX-R-008")).toEqual([]);
    expect(out.evaluated.get("https://acme.com/")?.size).toBeGreaterThan(10);
  });

  it("AUXLIVE-2 · with no renderer (no rendered copy) and no timing, the page is evaluated but AUX-R-026, 027 and 029 are not among the decided rules", async () => {
    const out = await run([{ url: "https://acme.com/", raw: GOOD }]);
    const decided = out.evaluated.get("https://acme.com/")!;
    for (const code of ["AUX-R-026", "AUX-R-027", "AUX-R-029"]) expect(decided.has(code), code).toBe(false);
    expect(decided.has("AUX-R-008")).toBe(true);
  });

  it("AUXLIVE-2 · a page with no stored plain copy (failed or skipped) is not evaluated and is not an error", async () => {
    const out = await run([{ url: "https://acme.com/gone" }, { url: "https://acme.com/", raw: GOOD }]);
    expect(out.evaluated.has("https://acme.com/gone")).toBe(false);
    expect(out.evaluated.has("https://acme.com/")).toBe(true);
    expect(out.unmodelled).toEqual([]);
  });

  it("AUXLIVE-2 · a page recorded before the fetch record existed has no snapshot: not evaluated, not an error", async () => {
    const out = await run([{ url: "https://acme.com/", raw: GOOD, fetch: false }]);
    expect(out.evaluated.size).toBe(0);
    expect(out.unmodelled).toEqual([]);
  });

  it("AUXLIVE-2 · a stored copy that fails its recorded hash is reported as unmodelled with a reason code, never evaluated, and never aborts the other pages", async () => {
    const f = fixture([{ url: "https://acme.com/bad", raw: GOOD }, { url: "https://acme.com/", raw: GOOD }]);
    f.objects.set(f.pages[0]!.raw!.object_key, gzipSync(Buffer.from("<html>tampered</html>")));
    const out = await runPageRules(f.pages, f.read, CATALOG, { projectId: PROJECT_ID });
    expect(out.unmodelled).toEqual([{ url: "https://acme.com/bad", reason: "snapshot_unreadable" }]);
    expect(out.evaluated.has("https://acme.com/bad")).toBe(false);
    expect(out.evaluated.has("https://acme.com/")).toBe(true);
  });

  it("AUXLIVE-2 · a missing stored object is also unmodelled (snapshot_unreadable)", async () => {
    const out = await run([{ url: "https://acme.com/", raw: GOOD }], async () => {
      throw new Error("no such object");
    });
    expect(out.unmodelled).toEqual([{ url: "https://acme.com/", reason: "snapshot_unreadable" }]);
  });

  it("AUXLIVE-2 · a rule that cannot run (a catalog row missing) fails the whole evaluation closed, it is not swallowed as an unmodelled page", async () => {
    const f = fixture([{ url: "https://acme.com/", raw: GOOD }]);
    const { loadAuxCatalog } = await import("./catalog.js");
    const { CATALOG_ROWS } = await import("../../../test/support/aux-rules.js");
    // Same weights are impossible to keep with a row removed, so the catalog is built unchecked via a hand-made map.
    const broken = { rules: CATALOG_ROWS, byCode: new Map(CATALOG_ROWS.filter((r) => r.code !== "AUX-R-008").map((r) => [r.code, r])) };
    expect(loadAuxCatalog(CATALOG_ROWS).byCode.has("AUX-R-008")).toBe(true);
    await expect(runPageRules(f.pages, f.read, broken, { projectId: PROJECT_ID })).rejects.toThrow(/AUX-R-008/);
  });

  it("AUXLIVE-2 · findings come back in a fixed order (URL, then rule code, then locator) whatever order the pages were crawled in", async () => {
    const specs: Spec[] = [
      { url: "https://acme.com/b", raw: BROKEN_JSONLD },
      { url: "https://acme.com/a", raw: BROKEN_JSONLD },
    ];
    const a = await run(specs);
    const b = await run([...specs].reverse());
    expect(a.findings.map((f) => f.url)).toEqual([...a.findings.map((f) => f.url)].sort());
    expect(JSON.stringify(a.findings)).toBe(JSON.stringify(b.findings));
  });

  it("AUXLIVE-2 · no pages is an empty result, not an error", async () => {
    const out = await run([]);
    expect(out).toEqual({ findings: [], evaluated: new Map(), patches: new Map(), unmodelled: [] });
  });
});

describe("STORY-052 AC4 · pageFindingFingerprint: identity over rule, URL and where", () => {
  const base = { rule_code: "AUX-R-008", url: "https://acme.com/", evidence: { reason: "jsonld_parse_error", snippet: "x", locator: "jsonld[0]" } };

  it("AUXLIVE-2 · the same defect gives the same fingerprint, whatever the snippet or the measured value says", () => {
    expect(pageFindingFingerprint({ ...base, evidence: { ...base.evidence, snippet: "different" } })).toBe(pageFindingFingerprint(base));
    expect(pageFindingFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AUXLIVE-2 · a different rule, URL, locator or reason is a different finding", () => {
    const fp = pageFindingFingerprint(base);
    expect(pageFindingFingerprint({ ...base, rule_code: "AUX-R-009" })).not.toBe(fp);
    expect(pageFindingFingerprint({ ...base, url: "https://acme.com/b" })).not.toBe(fp);
    expect(pageFindingFingerprint({ ...base, evidence: { ...base.evidence, locator: "jsonld[1]" } })).not.toBe(fp);
    expect(pageFindingFingerprint({ ...base, evidence: { ...base.evidence, reason: "other" } })).not.toBe(fp);
  });
});

describe("AUXLIVE-2 review round 1 · a rule that crashes on one page does not fail the audit", () => {
  const explodes = (onTitle: string): AuxRule => ({
    ...AUX_RULES.find((r) => r.code === "AUX-R-008")!,
    run: (doc) => {
      if (doc.meta.title === onTitle) throw new Error("markup the rule cannot handle");
      return [];
    },
  });
  const rulesWith = (bad: AuxRule): readonly AuxRule[] => AUX_RULES.map((r) => (r.code === bad.code ? bad : r));

  it("AUXLIVE-2 · a rule that throws on ONE of two pages: that page is reported unmodelled (rule_error, with the rule code), the other is evaluated and keeps its findings", async () => {
    const f = fixture([
      { url: "https://acme.com/bad", raw: GOOD.replace("<title>Acme</title>", "<title>Bad</title>") },
      { url: "https://acme.com/", raw: BROKEN_JSONLD },
    ]);
    const bad = explodes("Bad");
    // The good page's own AUX-R-008 finding must survive: use the real rule there, the crashing one only where the title says so.
    const real = AUX_RULES.find((r) => r.code === "AUX-R-008")!;
    const mixed: AuxRule = { ...real, run: (doc, thresholds) => (doc.meta.title === "Bad" ? bad.run(doc, thresholds) : real.run(doc, thresholds)) };
    const out = await runPageRules(f.pages, f.read, CATALOG, { projectId: PROJECT_ID }, rulesWith(mixed));
    expect(out.unmodelled).toEqual([{ url: "https://acme.com/bad", reason: "rule_error:AUX-R-008" }]);
    expect(out.evaluated.has("https://acme.com/bad")).toBe(false);
    expect(out.evaluated.has("https://acme.com/")).toBe(true);
    expect(out.findings.some((x) => x.rule_code === "AUX-R-008" && x.url === "https://acme.com/")).toBe(true);
    expect(out.findings.some((x) => x.url === "https://acme.com/bad")).toBe(false);
  });

  it("AUXLIVE-2 · the reason carries the rule code only: never the error's text or the page's content", async () => {
    const f = fixture([{ url: "https://acme.com/bad", raw: GOOD.replace("<title>Acme</title>", "<title>Bad</title>") }]);
    const out = await runPageRules(f.pages, f.read, CATALOG, { projectId: PROJECT_ID }, rulesWith(explodes("Bad")));
    expect(JSON.stringify(out.unmodelled)).not.toContain("markup the rule cannot handle");
    expect(JSON.stringify(out.unmodelled)).not.toContain("Bad</");
  });

  it("AUXLIVE-2 · a rule CONFIGURATION fault stays fail-closed: it fails the whole evaluation, it is not turned into an unmodelled page", async () => {
    const f = fixture([{ url: "https://acme.com/", raw: GOOD }]);
    const noCatalogRow: AuxRule = { ...AUX_RULES.find((r) => r.code === "AUX-R-008")!, code: "AUX-R-999" };
    await expect(runPageRules(f.pages, f.read, CATALOG, { projectId: PROJECT_ID }, [...AUX_RULES, noCatalogRow])).rejects.toBeInstanceOf(AuxRuleConfigError);
  });
});

describe("STORY-053 AC1 · the page-level patches come out of the same pass, keyed by the finding's fingerprint", () => {
  const LD = (extra: string): string =>
    `<html><head><title>Acme</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Acme"${extra}}</script></head>` +
    `<body><main><h1>Acme</h1><h2>Pipeline analytics</h2><p>See every deal.</p><h2>Workflow automation</h2><p>Automate follow-ups.</p></main></body></html>`;

  it("STORY-053 AC1 · a page whose AUX-R-014 fires yields a jsonld draft under that finding's fingerprint", async () => {
    const out = await run([{ url: "https://acme.com/", raw: LD("") }]);
    const f = out.findings.find((x) => x.rule_code === "AUX-R-014");
    expect(f).toBeDefined();
    const entry = out.patches.get(pageFindingFingerprint(f!));
    expect(entry).toMatchObject({ draft: { kind: "jsonld", ruleCode: "AUX-R-014", targetUrl: "https://acme.com/" } });
  });

  it("STORY-053 AC1 · a finding whose rule has no page generator has no entry (no empty patch)", async () => {
    const out = await run([{ url: "https://acme.com/", raw: BROKEN_JSONLD }]);
    expect(out.findings.some((x) => x.rule_code === "AUX-R-008")).toBe(true);
    for (const f of out.findings.filter((x) => x.rule_code === "AUX-R-008")) expect(out.patches.has(pageFindingFingerprint(f))).toBe(false);
  });

  it("STORY-053 AC5 · a generator that rejects its own output is recorded under the fingerprint as a reason code, not thrown", async () => {
    // A long unstructured paragraph with no heading at all: AUX-R-023 fires, and the structure template has nothing to anchor to.
    const sentences = Array.from({ length: 12 }, (_, i) => `Sentence number ${String(i)} is about widgets.`).join(" ");
    const noHeading = `<html><head><title>Acme</title></head><body><main><p>${sentences}</p></main></body></html>`;
    const out = await run([{ url: "https://acme.com/", raw: noHeading }]);
    const f = out.findings.find((x) => x.rule_code === "AUX-R-023");
    expect(f).toBeDefined();
    expect(out.patches.get(pageFindingFingerprint(f!))).toEqual({ rejected: "no_heading" });
  });

  it("STORY-053 AC5 · a generator that crashes (not a rejection) does not fail the audit: the finding stays, the patch is recorded as generator_error", async () => {
    vi.mocked(generatePagePatch).mockImplementationOnce(() => {
      throw new TypeError("boom with page text");
    });
    const out = await run([{ url: "https://acme.com/", raw: LD("") }]);
    const f = out.findings.find((x) => x.rule_code === "AUX-R-014");
    expect(f).toBeDefined();
    expect(out.patches.get(pageFindingFingerprint(f!))).toEqual({ rejected: "generator_error" });
    expect(out.unmodelled).toEqual([]);
    expect(out.evaluated.has("https://acme.com/")).toBe(true);
  });
});
