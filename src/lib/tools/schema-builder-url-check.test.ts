import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_BUILDER_RULE_CODES, schemaBuilderUrlResultSchema } from "../../../contracts/tools/index.js";
import { CATALOG_ROWS } from "../../../test/support/aux-rules.js";
import { GuardedFetchRefusal, type GuardedFetchInit, type GuardedResponse } from "../net/guarded-fetch.js";
import { checkUrlStructuredData, SCHEMA_BUILDER_URL_FETCH_TIMEOUT_MS } from "./schema-builder-url-check.js";
import type { ToolCatalogRow } from "./aux-audit-run.js";

// STORY-083 AC5 / decision 82 - the worker's pure half: one fetched page through the shared structured-data rules. Fetching is injected, so nothing here
// opens a socket. Scenario ids are SU-n.

const CATALOG: readonly ToolCatalogRow[] = CATALOG_ROWS.map((r) => ({ code: r.code, category: r.category, title: r.title, weight: r.weight, rule_version: r.ruleVersion, thresholds: r.thresholds, task_threshold: r.taskThreshold, auto_fixable: r.autoFixable, rationale: r.rationale }));
const URL_ = "https://shop.example/products/crm";
const html = (head: string, body = "<main><h1>Acme CRM</h1><p>Pricing: $37 per month, billed yearly.</p></main>") => `<!doctype html><html lang="en"><head><title>Acme CRM</title>${head}</head><body>${body}</body></html>`;
const ld = (json: string) => `<script type="application/ld+json">${json}</script>`;
const reply = (body: string, over: Partial<GuardedResponse> = {}): GuardedResponse => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(body), finalUrl: URL_, redirectChain: [], truncated: false, ttfbMs: 30, loadMs: 60, ...over });
const check = (page: string | (() => Promise<GuardedResponse>), catalog: readonly ToolCatalogRow[] = CATALOG) =>
  checkUrlStructuredData({ url: URL_, catalog }, { fetch: typeof page === "string" ? async () => reply(page) : page });

const PRODUCT_NO_PRICE = ld(JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Acme CRM", offers: { "@type": "Offer" } }));
const BROKEN = ld('{"@context": "https://schema.org", "@type": "Product", ');

describe("Schema Builder URL mode · the worker's check", () => {
  afterEach(() => vi.useRealTimers());

  it("SU-1 a page whose offer carries no price yields a finding that LEADS with the rendering consequence, from the catalog and not from the page", async () => {
    const out = await check(html(PRODUCT_NO_PRICE));
    expect(out.kind).toBe("checked");
    if (out.kind !== "checked") return;
    const f = out.result.findings.find((x) => x.rule_code === "AUX-R-012");
    expect(f).toBeDefined();
    expect(f!.consequence).toBe(CATALOG.find((r) => r.code === "AUX-R-012")!.rationale);
    expect(Object.keys(f!)[0]).toBe("consequence");
    expect(f).toMatchObject({ position: null, field: "offers" });
  });

  it("SU-2 malformed JSON-LD is a parse finding (AUX-R-008), critical, and is not an unhandled error", async () => {
    const out = await check(html(BROKEN));
    if (out.kind !== "checked") throw new Error("expected a checked result");
    expect(out.result.findings.find((x) => x.rule_code === "AUX-R-008")).toMatchObject({ severity: "critical" });
  });

  it("SU-2b a parse finding names its position IN THE PAGE (1-based line and column), derived from the block-relative offset and where the block starts", async () => {
    const page = ['<!doctype html><html><head>', '<script type="application/ld+json">', '{"@context": "https://schema.org",', '  "name": "x",}', "</script></head><body><main><h1>x</h1></main></body></html>"].join("\n");
    const out = await check(page);
    if (out.kind !== "checked") throw new Error("expected a checked result");
    const f = out.result.findings.find((x) => x.rule_code === "AUX-R-008")!;
    expect(f.position).toEqual({ line: 4, column: 15 });
    expect(f.field).toBeNull();
    expect(schemaBuilderUrlResultSchema.safeParse(out.result).success).toBe(true);
    // A block that starts mid-line: the column on its FIRST line is offset by where the block begins.
    const inline = '<p>x</p><script type="application/ld+json">{"a":1,}</script>';
    const out2 = await check(inline);
    if (out2.kind !== "checked") throw new Error("expected a checked result");
    expect(out2.result.findings.find((x) => x.rule_code === "AUX-R-008")!.position).toEqual({ line: 1, column: inline.indexOf("}") + 1 });
    // The offset is relative to the UNTRIMMED block text and counts UTF-16 units: astral characters before the error do not skew it.
    const astral = '<script type="application/ld+json">{"n":"😀😀","a":1,}</script>';
    const out3 = await check(astral);
    if (out3.kind !== "checked") throw new Error("expected a checked result");
    expect(out3.result.findings.find((x) => x.rule_code === "AUX-R-008")!.position).toEqual({ line: 1, column: astral.indexOf("}") + 1 });
  });

  it("SU-2c a parse error with no recoverable offset names no position (null), never a guess", async () => {
    const out = await check(html(ld("")));
    if (out.kind !== "checked") throw new Error("expected a checked result");
    const f = out.result.findings.find((x) => x.rule_code === "AUX-R-008");
    expect(f?.position ?? null).toBeNull();
  });

  it("SU-3 a page with nothing to report is `checked` with zero findings and the rules it decided: a real answer, distinct from unreachable", async () => {
    const clean = html(
      ld(JSON.stringify({ "@context": "https://schema.org", "@type": "Organization", name: "Acme", url: "https://shop.example/", logo: "https://shop.example/l.png", sameAs: ["https://x.com/acme"], description: "CRM software." })),
    );
    const out = await check(clean);
    if (out.kind !== "checked") throw new Error("expected a checked result");
    expect(out.result.rules_evaluated).toBeGreaterThan(0);
    expect(out.result.findings.filter((f) => f.rule_code === "AUX-R-008" || f.rule_code === "AUX-R-009")).toEqual([]);
  });

  it("SU-4 only the structured-data rules run: every finding's rule is one the Schema Builder accepts, and the held AUX-R-013 never appears", async () => {
    const out = await check(html(PRODUCT_NO_PRICE + BROKEN, "<main><h1>x</h1></main>"));
    if (out.kind !== "checked") throw new Error("expected a checked result");
    expect(out.result.findings.length).toBeGreaterThan(0);
    for (const f of out.result.findings) expect(SCHEMA_BUILDER_RULE_CODES as readonly string[]).toContain(f.rule_code);
    expect(out.result.findings.map((f) => f.rule_code)).not.toContain("AUX-R-013");
  });

  it("SU-5 the stored result is valid against the contract, carries no page text, and is deterministic (same page, byte-identical result)", async () => {
    const page = html(PRODUCT_NO_PRICE + BROKEN);
    const a = await check(page);
    const b = await check(page);
    if (a.kind !== "checked") throw new Error("expected a checked result");
    expect(schemaBuilderUrlResultSchema.safeParse(a.result).success).toBe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a.result)).not.toContain("Acme CRM");
    expect(a.result.vocab_version).toBe(`aux-rules@${CATALOG[0]!.rule_version}`);
  });

  it("SU-6 a refused, dead, erroring or non-HTML page is `unreachable` with a short reason and NO finding; the underlying message never leaves", async () => {
    const refused = await check(async () => { throw new GuardedFetchRefusal("address_not_global"); });
    const dead = await check(async () => { throw new Error("connect ECONNREFUSED 10.1.2.3:443"); });
    const http = await check(async () => reply("", { status: 503 }));
    const json = await check(async () => reply("{}", { headers: { "content-type": "application/json" } }));
    expect([refused, dead, http, json]).toEqual([
      { kind: "unreachable", reason: "refused" },
      { kind: "unreachable", reason: "unreachable" },
      { kind: "unreachable", reason: "http_error" },
      { kind: "unreachable", reason: "not_html" },
    ]);
    expect(JSON.stringify(dead)).not.toContain("10.1.2.3");
  });

  it("SU-7 a site that never answers is cut off at the timeout and is unreachable, not a hang", async () => {
    vi.useFakeTimers();
    const pending = check(() => new Promise<GuardedResponse>(() => undefined));
    await vi.advanceTimersByTimeAsync(SCHEMA_BUILDER_URL_FETCH_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ kind: "unreachable", reason: "unreachable" });
  });

  it("SU-8 the fetch is the guarded one, identifies itself, and a body past the cap is kept truncated rather than rejected", async () => {
    const seen: { url: string; init: GuardedFetchInit | undefined }[] = [];
    await check(async (...args: unknown[]) => {
      seen.push({ url: args[0] as string, init: args[1] as GuardedFetchInit });
      return reply(html(""));
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(URL_);
    expect(seen[0]!.init).toMatchObject({ truncateAtCap: true, headers: expect.objectContaining({ "user-agent": expect.stringContaining("Nominara") }) });
  });

  it("SU-9 a catalog row with no consequence fails closed (an error), never a made-up one", async () => {
    const without = CATALOG.map((r) => (r.code === "AUX-R-012" ? { ...r, rationale: null } : r));
    await expect(check(html(PRODUCT_NO_PRICE), without)).rejects.toThrow(/AUX-R-012/);
  });

  it("SU-10 findings beyond the stored cap are counted, not dropped silently", async () => {
    const out = await check(html(PRODUCT_NO_PRICE + BROKEN));
    if (out.kind !== "checked") throw new Error("expected a checked result");
    expect(out.result.findings_omitted).toBe(0);
    expect(out.result.findings.length).toBeLessThanOrEqual(50);
  });

  it("SU-11 the module has no fetch path of its own: the guarded fetcher is the only way out", () => {
    const source = readFileSync(new URL("./schema-builder-url-check.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:https?|undici|\bfetch\(|axios|got\(/u);
    expect(source).toMatch(/from "\.\.\/net\/guarded-fetch\.js"/u);
  });
});
