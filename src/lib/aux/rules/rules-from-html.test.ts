import { describe, expect, it } from "vitest";
import { CATALOG, PROJECT_ID } from "../../../../test/support/aux-rules.js";
import { buildAuxDocument, type DocumentSnapshot } from "../document-model.js";
import { cl100kTokenizer } from "../tokenizer-cl100k.js";
import { evaluateDocument } from "./engine.js";
import { AUX_RULES } from "./index.js";

// STORY-051 AC1, AC2, AC13 — the rules over a document model BUILT FROM HTML by STORY-050's builder, with the real cl100k_base
// tokenizer. The unit tests above hand-build models to put a value exactly on a boundary; these prove the two halves fit: the
// fields a rule reads are the fields the builder fills, and the whole catalog runs on a realistic page inside its latency share.

const snap = (rawHtml: string, over: Partial<DocumentSnapshot> = {}): DocumentSnapshot => ({
  url: "https://example.com/p", finalUrl: "https://example.com/p", httpStatus: 200, redirectChain: [], headers: {},
  rawHtml, renderedHtml: rawHtml, timing: { ttfbMs: 120, loadMs: 800 }, ...over,
});
const run = async (s: DocumentSnapshot) => evaluateDocument(buildAuxDocument(s, cl100kTokenizer), CATALOG, AUX_RULES, { projectId: PROJECT_ID });
const codes = (fs: readonly { rule_code: string }[]) => fs.map((f) => f.rule_code);

const GOOD = `<!doctype html><html><head><title>Acme Widgets</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme","url":"https://example.com","logo":"https://example.com/l.png","sameAs":["https://x.com/acme"],"description":"Widgets","dateModified":"2026-10-01"}</script>
</head><body><main><h1>Acme</h1><p>Acme makes widgets for teams. They ship fast.</p><table><tr><td>a</td></tr></table></main></body></html>`;

describe("STORY-051 · rules over a model built from HTML", () => {
  it("STORY-051 AC1 · a well-formed page raises no finding", async () => {
    expect(await run(snap(GOOD))).toEqual([]);
  });

  it("STORY-051 AUX-R-006 · an X-Robots-Tag noai header reaches the rule through the builder", async () => {
    expect(codes(await run(snap(GOOD, { headers: { "x-robots-tag": "noai" } })))).toEqual(["AUX-R-006"]);
  });

  it("STORY-051 AUX-R-008 · a broken JSON-LD block reaches the rule through the builder", async () => {
    const fs = await run(snap(GOOD.replace('"Acme","url"', '"Acme" "url"')));
    expect(codes(fs)).toContain("AUX-R-008");
  });

  it("STORY-051 #8 · JSON-LD present only in the rendered copy fires AUX-R-027 through the builder", async () => {
    const raw = GOOD.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/u, "");
    const fs = await run(snap(raw, { renderedHtml: GOOD }));
    expect(codes(fs)).toContain("AUX-R-027");
  });

  it("STORY-051 #9 · a 1,900-token section with no structure fires AUX-R-021 through the builder and the real tokenizer", async () => {
    const long = `<p>${"Widgets are built for teams that ship reliable software every week. ".repeat(210)}</p>`;
    const fs = await run(snap(GOOD.replace("</main>", `<h2>Long</h2>${long}</main>`)));
    const f = fs.find((x) => x.rule_code === "AUX-R-021");
    expect(f).toBeDefined();
    expect(f!.measured_value).toBeGreaterThan(1800);
    expect(f!.evidence.snippet).toBe("Long");
  });

  it("STORY-051 AC2 · the same snapshot gives the same findings twice", async () => {
    const s = snap(GOOD, { headers: { "x-robots-tag": "noai, noarchive" }, timing: { ttfbMs: 4000, loadMs: null } });
    expect(JSON.stringify(await run(s))).toBe(JSON.stringify(await run(s)));
  });

  it("STORY-051 #12 · the whole catalog on a ~2 MB page stays inside its share of the latency budget", { timeout: 60_000 }, async () => {
    // Same arithmetic as STORY-050 AC11: the audit has 600 s for 100 pages; the rules get one tenth, 600 ms a page. CPU time, not
    // wall time, so another worker holding the cores cannot fail a bound on the work.
    const paragraph = "Acme builds widgets for engineering teams that need reliable, well documented components, shipped on time. ".repeat(4);
    const sections: string[] = [];
    for (let i = 0; sections.join("").length < 2_000_000; i += 1) {
      sections.push(`<section><h2>Section ${String(i)}?</h2><p>${paragraph}</p><ul><li>${paragraph}</li></ul><img src="/i${String(i)}.png" alt="Widget"><table><tr><td>${String(i)}</td></tr></table></section>`);
    }
    const html = GOOD.replace("</main>", `${sections.join("")}</main>`);
    const document = buildAuxDocument(snap(html), cl100kTokenizer);
    const started = process.cpuUsage();
    let findings = 0;
    for (let i = 0; i < 10; i += 1) findings += (await evaluateDocument(document, CATALOG, AUX_RULES, { projectId: PROJECT_ID })).length;
    const cpu = process.cpuUsage(started);
    const perPageMs = (cpu.user + cpu.system) / 1000 / 10;
    expect(findings).toBeGreaterThan(0);
    expect(perPageMs).toBeLessThan(600);
  });
});
