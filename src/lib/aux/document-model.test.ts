import { describe, expect, it, vi } from "vitest";
import * as metrics from "../telemetry/metrics.js";
import { buildAuxDocument, type AuxDocument, type DocumentSnapshot } from "./document-model.js";
import { tokenizerLabel, type Tokenizer } from "./tokenizer.js";

// STORY-050 — the document model. Pure: a stored snapshot goes in, the object every rule receives comes out. The tokenizer is a
// test double (whitespace words), so these tests prove the BUILDER; parity with cl100k_base is proved against the real package.

const tokenizer: Tokenizer = {
  identity: { name: "test-words", version: "0" },
  count: (text) => (text.trim() === "" ? 0 : text.trim().split(/\s+/u).length),
};

const snap = (over: Partial<DocumentSnapshot> & { rawHtml: string }): DocumentSnapshot => ({
  url: "https://example.com/p",
  finalUrl: "https://example.com/p",
  httpStatus: 200,
  redirectChain: [],
  headers: {},
  renderedHtml: over.rawHtml,
  timing: { ttfbMs: 120, loadMs: 800 },
  ...over,
});

const build = (over: Partial<DocumentSnapshot> & { rawHtml: string }): AuxDocument => buildAuxDocument(snap(over), tokenizer);

const FULL = `<!doctype html><html lang="en"><head>
<title>Acme Widgets</title>
<meta name="description" content="The best widgets.">
<link rel="canonical" href="https://example.com/p">
<link rel="alternate" hreflang="en-gb" href="https://example.com/uk">
<link rel="alternate" hreflang="de" href="https://example.com/de">
<meta name="robots" content="index, max-snippet:50">
<meta property="article:published_time" content="2026-01-02">
<meta property="article:modified_time" content="2026-03-04">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme"}</script>
</head><body><nav><a href="/x">Nav link</a></nav><main>
<h1>Acme</h1><p>Intro words here. Second sentence follows.</p>
<h2>Pricing</h2><p>Plans start low.</p><table><tr><td>a</td></tr></table><ul><li>one</li></ul>
<a href="/internal">in</a><a href="https://other.org/x" rel="nofollow">out</a>
<img src="a.png" alt="A"><img src="b.png">
</main><footer>Footer text</footer></body></html>`;

describe("STORY-050 document model", () => {
  it("STORY-050 #1 · a stored snapshot populates every documented field", () => {
    const d = build({ rawHtml: FULL, headers: { "x-robots-tag": "noarchive" }, redirectChain: [], timing: { ttfbMs: 10, loadMs: 20 } });
    expect(d).toMatchObject({ url: "https://example.com/p", finalUrl: "https://example.com/p", httpStatus: 200, redirectChain: [] });
    expect(d.headers).toEqual({ "x-robots-tag": "noarchive" });
    for (const v of [d.raw, d.rendered!]) {
      expect(Object.keys(v).sort()).toEqual(["headingTree", "html", "mainText", "mainTokenCount", "structured", "tokenCount"]);
      expect(v.html).toContain("<h1>");
      expect(v.mainText).toContain("Intro words here.");
      expect(v.mainText).not.toContain("Footer text");
      expect(v.mainText).not.toContain("Nav link");
      expect(v.tokenCount).toBeGreaterThan(v.mainTokenCount);
    }
    expect(d.meta).toMatchObject({ title: "Acme Widgets", description: "The best widgets.", canonical: "https://example.com/p", robots: "index, max-snippet:50", googlebotNoSnippet: false, maxSnippet: 50, dateModified: "2026-03-04", datePublished: "2026-01-02", hreflang: ["en-gb", "de"] });
    expect(d.structured.jsonLd).toHaveLength(1);
    expect(d.blocks.length).toBeGreaterThan(0);
    expect(d.links).toEqual({ internal: 2, external: 1, nofollow: 1 });
    expect(d.media).toEqual({ images: 2, imagesWithAlt: 1 });
    expect(d.timing).toEqual({ ttfbMs: 10, loadMs: 20, bytes: Buffer.byteLength(FULL) });
    expect(d.tokenizer).toEqual({ name: "test-words", version: "0" });
  });

  it("STORY-050 #2 · building twice from one snapshot gives an identical model", () => {
    const s = snap({ rawHtml: FULL, renderedHtml: FULL.replace("Plans start low.", "Plans start low and rise.") });
    expect(JSON.stringify(buildAuxDocument(s, tokenizer))).toBe(JSON.stringify(buildAuxDocument(s, tokenizer)));
  });

  it("STORY-050 #3 · script-injected content makes the plain and rendered token counts differ", () => {
    const raw = `<html><body><main><h1>T</h1><p>one two three</p><div id="app"></div></main></body></html>`;
    const rendered = `<html><body><main><h1>T</h1><p>one two three</p><div id="app"><p>${"injected word ".repeat(40)}</p></div></main></body></html>`;
    const d = build({ rawHtml: raw, renderedHtml: rendered });
    expect(d.rendered!.tokenCount).toBeGreaterThan(d.raw.tokenCount + 70);
    expect(d.rendered!.mainTokenCount).toBeGreaterThan(d.raw.mainTokenCount);
  });

  it("STORY-050 #3b · script and style text is never counted as page text", () => {
    const d = build({ rawHtml: `<html><head><style>.a{color:red}</style></head><body><main><p>real text</p><script>var a = "not text at all";</script><noscript>hidden fallback</noscript></main></body></html>` });
    expect(d.raw.mainText).toBe("real text");
    expect(d.raw.tokenCount).toBe(2);
  });

  it("STORY-050 #5 · the tokenizer identity is recorded on the model and renders as the audit label", () => {
    expect(build({ rawHtml: FULL }).tokenizer).toEqual(tokenizer.identity);
    expect(tokenizerLabel(tokenizer.identity)).toBe("test-words@0");
  });

  it("STORY-050 #6 · malformed JSON-LD is captured as a parse error, and the good block still parses", () => {
    const html = `<html><head><script type="application/ld+json">{"@type": "Organization", "name": }</script><script type="application/ld+json">{"@type":"Product"}</script></head><body><main><p>x</p></main></body></html>`;
    const d = build({ rawHtml: html });
    expect(d.structured.jsonLd).toEqual([{ "@type": "Product" }]);
    // The page is identical in both copies, so the one broken block is reported once per copy.
    expect(d.structured.parseErrors).toHaveLength(2);
    expect(d.structured.parseErrors[1]).toMatchObject({ format: "jsonld", index: 0, variant: "rendered", reason: "invalid_json" });
    expect(d.structured.parseErrors[1]!.snippet).toContain('"name": }');
  });

  it("STORY-050 #6b · an empty JSON-LD script and a bare scalar are errors, a top-level array is flattened", () => {
    const html = `<html><head><script type="application/ld+json">   </script><script type="application/ld+json">42</script><script type="application/ld+json">[{"@type":"A"},{"@type":"B"}]</script></head><body></body></html>`;
    const d = build({ rawHtml: html });
    expect(d.structured.jsonLd).toEqual([{ "@type": "A" }, { "@type": "B" }]);
    expect(d.rendered!.structured.parseErrors.map((e) => [e.index, e.reason])).toEqual([[0, "empty"], [1, "not_object_or_array"]]);
    expect(d.structured.parseErrors).toHaveLength(4);
  });

  it("STORY-050 #6c · a parse error in the plain copy is reported even when the rendered copy is clean", () => {
    const bad = `<html><head><script type="application/ld+json">{oops</script></head><body></body></html>`;
    const good = `<html><head><script type="application/ld+json">{"@type":"A"}</script></head><body></body></html>`;
    const d = build({ rawHtml: bad, renderedHtml: good });
    expect(d.raw.structured.parseErrors).toHaveLength(1);
    expect(d.raw.structured.parseErrors[0]!.variant).toBe("raw");
    expect(d.rendered!.structured.parseErrors).toEqual([]);
    expect(d.rendered!.structured.jsonLd).toEqual([{ "@type": "A" }]);
    expect(d.raw.structured.jsonLd).toEqual([]);
  });

  it("STORY-050 #2b · KNOWN LIMITATION: on a <div>-only template the main text includes the sidebar and the cookie banner", () => {
    const html = `<html><body><div class="cookie-banner">We use cookies</div><div class="sidebar"><div>Related links</div></div><div class="content"><h1>Widgets</h1><p>The real article text.</p></div></body></html>`;
    const d = build({ rawHtml: html });
    // Without <main>, [role=main] or <article> only header/nav/aside/footer are dropped, so furniture in a <div> is counted as content
    // (AUX-R-020's main-to-total ratio then over-counts main text and under-fires). Recorded in STORY-050; readability is the fix.
    expect(d.raw.mainText).toBe("We use cookies\nRelated links\nWidgets\nThe real article text.");
    // The same furniture in semantic elements IS dropped, which is the behaviour a template that uses them gets.
    const semantic = build({ rawHtml: `<html><body><footer>We use cookies</footer><aside>Related links</aside><div><h1>Widgets</h1><p>The real article text.</p></div></body></html>` });
    expect(semantic.raw.mainText).toBe("Widgets\nThe real article text.");
  });

  it("STORY-050 #6d · the top-level parse errors are the union of both copies, so a rule reading d.structured misses neither", () => {
    const bad = `<html><head><script type="application/ld+json">{oops</script></head><body></body></html>`;
    const good = `<html><head><script type="application/ld+json">{"@type":"A"}</script></head><body></body></html>`;
    const rawOnly = build({ rawHtml: bad, renderedHtml: good });
    expect(rawOnly.structured.parseErrors.map((e) => e.variant)).toEqual(["raw"]);
    expect(rawOnly.structured.jsonLd).toEqual([{ "@type": "A" }]); // the data is still the rendered copy's
    const both = build({ rawHtml: bad, renderedHtml: bad });
    expect(both.structured.parseErrors.map((e) => e.variant)).toEqual(["raw", "rendered"]);
    expect(build({ rawHtml: bad, renderedHtml: null }).structured.parseErrors.map((e) => e.variant)).toEqual(["raw"]);
  });

  it("STORY-050 #6e · a parse error names the format it can be raised for: only JSON-LD is reported, microdata and RDFa are read leniently", () => {
    const d = build({ rawHtml: `<html><body><div itemprop="name">orphan</div><div property="name">orphan</div></body></html>` });
    expect(d.structured.parseErrors).toEqual([]);
    expect(d.structured.microdata).toEqual([]);
    expect(d.structured.rdfa).toEqual([]);
  });

  it("STORY-050 #6d · microdata and RDFa are extracted", () => {
    const html = `<html><body><div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Widget</span><meta itemprop="sku" content="W1"><div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><span itemprop="price">9.99</span></div></div>
<div vocab="https://schema.org/" typeof="Organization"><span property="name">Acme</span><a property="url" href="https://acme.test">site</a></div></body></html>`;
    const d = build({ rawHtml: html });
    expect(d.structured.microdata).toEqual([
      { type: "https://schema.org/Product", properties: { name: ["Widget"], sku: ["W1"], offers: [{ type: "https://schema.org/Offer", properties: { price: ["9.99"] } }] } },
    ]);
    expect(d.structured.rdfa).toEqual([{ type: "Organization", vocab: "https://schema.org/", properties: { name: ["Acme"], url: ["https://acme.test"] } }]);
  });

  it("STORY-050 #7 · nested headings give the tree and one block per heading section", () => {
    const html = `<html><body><main><p>preamble words</p><h1>A</h1><p>a1 a2</p><h2>B</h2><p>b1 b2 b3</p><h3>C</h3><p>c1</p><h2>D</h2><p>d1 d2 d3 d4</p></main></body></html>`;
    const d = build({ rawHtml: html });
    expect(d.raw.headingTree).toEqual([
      { level: 1, text: "A", children: [
        { level: 2, text: "B", children: [{ level: 3, text: "C", children: [] }] },
        { level: 2, text: "D", children: [] },
      ] },
    ]);
    expect(d.blocks.map((b) => [b.heading, b.level, b.tokens])).toEqual([[null, 0, 2], ["A", 1, 2], ["B", 2, 3], ["C", 3, 1], ["D", 2, 4]]);
  });

  it("STORY-050 #7b · a heading level skip nests under the nearest shallower heading; a leading H3 is a root", () => {
    const d = build({ rawHtml: `<html><body><main><h3>X</h3><h2>Y</h2><h4>Z</h4></main></body></html>` });
    expect(d.raw.headingTree).toEqual([
      { level: 3, text: "X", children: [] },
      { level: 2, text: "Y", children: [{ level: 4, text: "Z", children: [] }] },
    ]);
    expect(d.blocks.map((b) => b.tokens)).toEqual([0, 0, 0]);
  });

  it("STORY-050 #8 · a table and a list in one section are both recorded on that block, with sentence stats and code", () => {
    const html = `<html><body><main><h2>S</h2><p>One two three. Four five.</p><table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table><ul><li>x</li></ul><ol><li>y</li></ol><dl><dt>t</dt><dd>d</dd></dl><pre>code here</pre><p>use <code>npm i</code></p></main></body></html>`;
    const [b] = build({ rawHtml: html }).blocks;
    expect(b).toMatchObject({ heading: "S", tables: 2, lists: { unordered: 1, ordered: 1, definition: 1 }, codeSpans: 2 });
    expect(b!.sentences.count).toBeGreaterThanOrEqual(2);
    expect(b!.sentences.maxWords).toBeGreaterThanOrEqual(3);
    expect(b!.sentences.meanWords).not.toBeNull();
  });

  it("STORY-051 AC10 · longestUnstructuredTokens is the longest run of text between breaks (a list, a table), not the section's total, and the text inside a list or table is no run", () => {
    const html = `<html><body><main><h2>S</h2><p>a b c d e</p><ul><li>x y z</li></ul><p>f g</p><table><tr><td>t u v w</td></tr></table><p>h i j</p></main></body></html>`;
    const [b] = build({ rawHtml: html }).blocks;
    expect(b!.longestUnstructuredTokens).toBe(5);
    expect(b!.tokens).toBe(5 + 3 + 2 + 4 + 3);
  });
  it("STORY-051 AC10 · a section with no structure is one run: the run equals the section's tokens; an empty section is 0, not null", () => {
    const [a] = build({ rawHtml: `<html><body><main><h2>S</h2><p>one two three</p><p>four five</p></main></body></html>` }).blocks;
    expect(a!.longestUnstructuredTokens).toBe(5);
    expect(a!.longestUnstructuredTokens).toBe(a!.tokens);
    const [e] = build({ rawHtml: `<html><body><main><h2>Empty</h2></main></body></html>` }).blocks;
    expect(e!.longestUnstructuredTokens).toBe(0);
  });
  it("STORY-051 AC10 · a subheading ends the run: the next section starts its own", () => {
    const blocks = build({ rawHtml: `<html><body><main><h2>A</h2><p>a b c</p><h3>B</h3><p>d e f g</p></main></body></html>` }).blocks;
    expect(blocks.map((b) => [b.heading, b.longestUnstructuredTokens])).toEqual([["A", 3], ["B", 4]]);
  });
  it("STORY-051 AC10 · a list nested in a list does not restart the count, and a paragraph after a list is a new run", () => {
    const html = `<html><body><main><h2>S</h2><ul><li>a b<ul><li>c d</li></ul></li></ul><p>e f g h i j</p></main></body></html>`;
    const [b] = build({ rawHtml: html }).blocks;
    expect(b!.longestUnstructuredTokens).toBe(6);
  });

  it("STORY-050 #8b · a section with no sentences has meanWords null (not 0) and a paragraph length", () => {
    const [b] = build({ rawHtml: `<html><body><main><h2>Empty</h2></main></body></html>` }).blocks;
    expect(b!.sentences).toEqual({ count: 0, meanWords: null, maxWords: 0 });
    expect(b!.longestParagraphChars).toBe(0);
    const [p] = build({ rawHtml: `<html><body><main><h2>P</h2><p>${"x".repeat(901)}</p></main></body></html>` }).blocks;
    expect(p!.longestParagraphChars).toBe(901);
  });

  it("STORY-050 #9 · alt coverage counts non-empty alt text only; zero images is 0 of 0", () => {
    const d = build({ rawHtml: `<html><body><img src=1 alt="x"><img src=2 alt=""><img src=3 alt="  "><img src=4></body></html>` });
    expect(d.media).toEqual({ images: 4, imagesWithAlt: 1 });
    expect(build({ rawHtml: `<html><body>none</body></html>` }).media).toEqual({ images: 0, imagesWithAlt: 0 });
  });

  it("STORY-050 #10 · the final URL and the full redirect chain are carried", () => {
    const d = build({ url: "http://example.com/a", finalUrl: "https://www.example.com/b", redirectChain: ["http://example.com/a", "https://example.com/a"], rawHtml: FULL });
    expect(d.url).toBe("http://example.com/a");
    expect(d.finalUrl).toBe("https://www.example.com/b");
    expect(d.redirectChain).toEqual(["http://example.com/a", "https://example.com/a"]);
  });

  it("STORY-050 #12 · links: relative and www are internal, mailto/tel/fragment/javascript are not links", () => {
    const html = `<html><body><a href="/a">1</a><a href="https://www.example.com/b">2</a><a href="https://sub.example.com/c" rel="noopener NOFOLLOW">3</a><a href="https://x.org/">4</a><a href="mailto:a@b.c">5</a><a href="#top">6</a><a href="javascript:void 0">7</a><a href="tel:1">8</a><a>9</a></body></html>`;
    expect(build({ rawHtml: html }).links).toEqual({ internal: 3, external: 1, nofollow: 1 });
  });

  it("STORY-050 #13 · meta directives: nosnippet, googlebot, max-snippet, X-Robots-Tag, noai", () => {
    const head = (h: string): string => `<html><head>${h}</head><body></body></html>`;
    expect(build({ rawHtml: head(`<meta name="robots" content="NoSnippet, noindex">`) }).meta).toMatchObject({ googlebotNoSnippet: true });
    expect(build({ rawHtml: head(`<meta name="googlebot" content="nosnippet">`) }).meta.googlebotNoSnippet).toBe(true);
    expect(build({ rawHtml: head(``), headers: { "x-robots-tag": "googlebot: nosnippet" } }).meta.googlebotNoSnippet).toBe(true);
    expect(build({ rawHtml: head(``), headers: { "x-robots-tag": "bingbot: nosnippet" } }).meta.googlebotNoSnippet).toBe(false);
    expect(build({ rawHtml: head(`<meta name="robots" content="max-snippet:0">`) }).meta.maxSnippet).toBe(0);
    expect(build({ rawHtml: head(`<meta name="robots" content="max-snippet:80"><meta name="googlebot" content="max-snippet:20">`) }).meta.maxSnippet).toBe(20);
    expect(build({ rawHtml: head(`<meta name="robots" content="index">`) }).meta.maxSnippet).toBeUndefined();
    expect(build({ rawHtml: head(`<meta name="robots" content="noai, NoImageAI">`), headers: { "x-robots-tag": "noarchive" } }).meta.directives).toEqual(["noai", "noarchive", "noimageai"]);
    expect(build({ rawHtml: head(``) }).meta.directives).toEqual([]);
  });

  it("STORY-050 #14 · dates fall back to JSON-LD when no meta tag carries them", () => {
    const html = `<html><head><script type="application/ld+json">{"@type":"Article","datePublished":"2025-05-05","dateModified":"2026-06-06"}</script></head><body></body></html>`;
    expect(build({ rawHtml: html }).meta).toMatchObject({ datePublished: "2025-05-05", dateModified: "2026-06-06" });
  });

  it("STORY-050 #15 · main content falls back: <main>, then [role=main], then <article>, then body minus chrome", () => {
    expect(build({ rawHtml: `<body><div role="main">in role</div><p>outside</p></body>` }).raw.mainText).toBe("in role");
    expect(build({ rawHtml: `<body><article>in article</article><p>outside</p></body>` }).raw.mainText).toBe("in article");
    expect(build({ rawHtml: `<body><header>head</header><nav>nav</nav><p>body text</p><aside>side</aside><footer>foot</footer></body>` }).raw.mainText).toBe("body text");
  });

  it("STORY-050 #16 · the rendered variant is null (not an empty copy) when no rendered copy exists", () => {
    const d = build({ rawHtml: FULL, renderedHtml: null });
    expect(d.rendered).toBeNull();
    expect(d.blocks.length).toBeGreaterThan(0);
    expect(d.structured.jsonLd).toHaveLength(1);
  });

  it("STORY-050 #17 · an unmeasured timing stays null, a measured zero stays 0", () => {
    expect(build({ rawHtml: FULL, timing: { ttfbMs: null, loadMs: null } }).timing).toMatchObject({ ttfbMs: null, loadMs: null });
    expect(build({ rawHtml: FULL, timing: { ttfbMs: 0, loadMs: 0 } }).timing).toMatchObject({ ttfbMs: 0, loadMs: 0 });
  });

  it("STORY-050 #18 · empty and garbage input still build a model", () => {
    for (const html of ["", "<", "<<<>>>", "\u0000\u0001", "<html>"]) {
      const d = build({ rawHtml: html });
      expect(d.raw.tokenCount).toBeGreaterThanOrEqual(0);
      expect(d.blocks).toBeInstanceOf(Array);
    }
    expect(build({ rawHtml: "" }).raw).toMatchObject({ mainText: "", tokenCount: 0, headingTree: [] });
  });

  it("STORY-050 #19 · a hostile page cannot reach a script, a network or a stored control character", () => {
    const d = build({ rawHtml: `<html><body><main><p>a\u0000b</p><img src="http://169.254.169.254/x"><script>throw 1</script></main></body></html>` });
    expect(d.raw.mainText).toBe("ab");
  });

  it("STORY-050 #20 · a build emits one metric observation of its duration", () => {
    const spy = vi.spyOn(metrics, "observeValue");
    build({ rawHtml: FULL });
    expect(spy).toHaveBeenCalledWith("nominara_aux_document_build_duration_ms", expect.any(Number), {});
    spy.mockRestore();
  });
});

describe("STORY-050 no rule fetches", () => {
  // The files that OWN a network call: the page stage, the sitemap reader and the renderer port. Everything else under src/lib/aux
  // (the document model, the tokenizer, the snapshot loader, and any rule added under rules/) is checked BY DEFAULT: a new file is
  // fetch-free unless it is named here, so adding a rule never opts it out.
  const FETCH_OWNERS: readonly string[] = ["page-crawl.ts", "renderer.ts", "sitemap.ts"];
  const NETWORK = /guarded-fetch|\bfetch\s*\(|node:https?|node:net|node:dns|undici|\bXMLHttpRequest\b/u;
  // Prose is not a call: whole-line comments and block comments are dropped (a trailing `//` after code is kept, so code is never hidden).
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

  const sources = async (): Promise<Map<string, string>> => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = new URL(".", import.meta.url).pathname;
    const out = new Map<string, string>();
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".spec.ts")) out.set(relative(root, full), readFileSync(full, "utf8"));
      }
    };
    visit(root);
    return out;
  };

  it("STORY-050 #11 · no file under src/lib/aux outside the named fetch owners imports or calls a network facility", async () => {
    const files = await sources();
    expect(files.has("document-model.ts") && files.has("tokenizer.ts") && files.has("document-snapshot.ts")).toBe(true);
    for (const [file, src] of files) {
      if (FETCH_OWNERS.includes(file)) continue;
      expect(code(src), file).not.toMatch(NETWORK);
    }
  });

  it("STORY-050 #11 · the fetch-owner list is honest: every name exists and really owns a network call", async () => {
    const files = await sources();
    for (const owner of FETCH_OWNERS) {
      expect(files.has(owner), owner).toBe(true);
      expect(code(files.get(owner)!), owner).toMatch(NETWORK);
    }
  });

  it("STORY-050 #11 · the scan reads a call hidden after a URL string and ignores prose", () => {
    expect(code('const u = "http://x"; fetch(u);')).toMatch(NETWORK);
    expect(code("// a rule cannot fetch (anything)\n/* fetch(x) */\nconst a = 1;")).not.toMatch(NETWORK);
  });
});
