import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crawlManifestSchema } from "../../../contracts/aux/index.js";
import type { GuardedResponse } from "../net/guarded-fetch.js";
import { buildAuxDocument } from "./document-model.js";
import { loadDocumentSnapshot } from "./document-snapshot.js";
import { crawlPages } from "./page-crawl.js";
import { PolitenessBudget } from "./politeness.js";
import type { Tokenizer } from "./tokenizer.js";

// STORY-050 AC8 / AC10 — the model is rebuilt from STORAGE: crawl a page that redirects, keep only what the crawl stored, load the
// snapshot back, and get the same model, redirect chain and header-derived directives included.

const tokenizer: Tokenizer = { identity: { name: "test-words", version: "0" }, count: (t) => (t.trim() === "" ? 0 : t.trim().split(/\s+/u).length) };

const RAW = `<html><head><title>T</title></head><body><main><h1>Hello</h1><p>Plain words here.</p></main></body></html>`;
const RENDERED = `<html><head><title>T</title></head><body><main><h1>Hello</h1><p>Plain words here and more rendered ones.</p></main></body></html>`;

async function crawlOnce() {
  const objects = new Map<string, Buffer>();
  const response: GuardedResponse = {
    status: 200,
    headers: { "x-robots-tag": "nosnippet, max-snippet: 50", "content-type": "text/html; charset=utf-8", "set-cookie": "sid=1" },
    body: Buffer.from(RAW),
    finalUrl: "https://acme.com/new",
    truncated: false,
    redirectChain: ["https://acme.com/old"],
    ttfbMs: 0,
    loadMs: 37,
  };
  const budget = new PolitenessBudget({ hardCap: 10, crawlDelaySeconds: null, now: () => 0, sleep: async () => undefined });
  const { pages } = await crawlPages(["https://acme.com/old"], {
    rootUrl: "https://acme.com/",
    budget,
    robots: null,
    renderer: { render: async (url) => ({ html: RENDERED, finalUrl: url, status: 200 }) },
    fetch: async () => response,
    store: async (relative, body) => {
      objects.set(`crawl/${relative}`, body);
      return `crawl/${relative}`;
    },
    keyPrefix: "audit-1",
  });
  // The page goes through the manifest schema exactly as the handler writes it, then JSON, as storage would hold it.
  const manifest = crawlManifestSchema.parse({
    version: 1,
    audit_id: "0197a0a0-0000-7000-8000-000000000001",
    scope: "key_pages",
    root_url: "https://acme.com/",
    pages,
    pages_over_cap: 0,
    stopped_at_cap: false,
    selection_skipped: [],
    sitemap: null,
    ai_bot_access: null,
  });
  const stored = crawlManifestSchema.parse(JSON.parse(JSON.stringify(manifest)));
  const read = async (key: string): Promise<Buffer> => {
    const b = objects.get(key);
    if (b === undefined) throw new Error("no such object");
    return b;
  };
  return { page: stored.pages[0]!, read, objects };
}

describe("STORY-050 AC8 / AC10 · the document model is rebuilt from storage", () => {
  it("scenario 10 · a page crawled through a redirect, re-loaded from storage, builds the same model twice", async () => {
    const { page, read } = await crawlOnce();
    const a = buildAuxDocument((await loadDocumentSnapshot(page, read))!, tokenizer);
    const b = buildAuxDocument((await loadDocumentSnapshot(page, read))!, tokenizer);
    expect(a).toEqual(b);
  });

  it("AC8 · the redirect chain, final URL and status survive storage", async () => {
    const { page, read } = await crawlOnce();
    const d = buildAuxDocument((await loadDocumentSnapshot(page, read))!, tokenizer);
    expect(d.url).toBe("https://acme.com/old");
    expect(d.finalUrl).toBe("https://acme.com/new");
    expect(d.redirectChain).toEqual(["https://acme.com/old"]);
    expect(d.httpStatus).toBe(200);
  });

  it("AC6 · the X-Robots-Tag directives are derived from the STORED header, not from anything in memory", async () => {
    const { page, read } = await crawlOnce();
    const d = buildAuxDocument((await loadDocumentSnapshot(page, read))!, tokenizer);
    expect(d.meta.googlebotNoSnippet).toBe(true);
    expect(d.meta.maxSnippet).toBe(50);
    expect(d.meta.directives).toContain("nosnippet");
    expect(Object.keys(d.headers).sort()).toEqual(["content-type", "x-robots-tag"]);
  });

  it("AC7 · the stored timing comes back; a measured 0 is still 0", async () => {
    const { page, read } = await crawlOnce();
    const d = buildAuxDocument((await loadDocumentSnapshot(page, read))!, tokenizer);
    expect(d.timing).toMatchObject({ ttfbMs: 0, loadMs: 37, bytes: Buffer.byteLength(RAW) });
  });

  it("AC1 · both copies come back byte for byte", async () => {
    const { page, read } = await crawlOnce();
    const snap = (await loadDocumentSnapshot(page, read))!;
    expect(snap.rawHtml).toBe(RAW);
    expect(snap.renderedHtml).toBe(RENDERED);
  });

  it("a page with no rendered copy loads with renderedHtml null, never an empty copy", async () => {
    const { page, read } = await crawlOnce();
    const { rendered: _drop, ...noRendered } = page;
    expect((await loadDocumentSnapshot(noRendered, read))!.renderedHtml).toBeNull();
  });

  it("a page with no stored plain copy, or from a manifest older than the fetch record, has no snapshot", async () => {
    const { page, read } = await crawlOnce();
    const { fetch: _f, ...legacy } = page;
    expect(await loadDocumentSnapshot(legacy, read)).toBeNull();
    const { raw: _r, ...noRaw } = page;
    expect(await loadDocumentSnapshot(noRaw, read)).toBeNull();
    expect(await loadDocumentSnapshot({ url: "u", outcome: "skipped", failures: [], skipped_reason: "robots_disallowed" }, read)).toBeNull();
  });

  it("a stored object that no longer matches its recorded hash is refused, not modelled", async () => {
    const { page, read, objects } = await crawlOnce();
    objects.set(page.raw!.object_key, gzipSync(Buffer.from("<html>tampered</html>")));
    await expect(loadDocumentSnapshot(page, read)).rejects.toThrow(/hash/u);
  });
});
