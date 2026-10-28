import { describe, expect, it } from "vitest";
import { buildAuxDocument } from "./document-model.js";
import { cl100kTokenizer } from "./tokenizer-cl100k.js";

// STORY-050 AC11 / NFR-AUX-01 — building the model for the documented page count stays inside its share of the audit's latency
// budget. The audit is allowed 600 s p95 for 100 pages (25 pages: 180 s). The crawl itself (politeness delay, a rendered fetch per
// page) is most of that; the model build is given ONE TENTH of it: 60 s for 100 pages, which is 600 ms a page. The test builds
// 10 models of a realistic 2 MB page, plain and rendered, with the real cl100k_base tokenizer (a full 100 takes ~28 s of unit-suite
// time for no extra information: the work is linear in pages), and asserts the run stays under the same per-page rate, scaled:
// 10 pages x 600 ms = 6 s. Measured on the development machine at ~275 ms a page, so the bound has about 2x headroom: a
// regression that doubles the build cost fails it, one that makes it quadratic fails it by orders of magnitude.

const DOCUMENTED_PAGES = 100;
const BUDGET_SHARE_MS = 60_000;
const PAGES = 10;

function realisticPage(): string {
  const paragraph = "Acme builds widgets for engineering teams that need reliable, well documented components, shipped on time. ".repeat(4);
  const sections: string[] = [];
  let i = 0;
  while (sections.join("").length < 2_000_000) {
    i += 1;
    sections.push(
      `<section><h2>Section ${String(i)} about widgets</h2><p>${paragraph}</p><p>${paragraph} <a href="/page-${String(i)}">internal</a> <a href="https://other.example.org/${String(i)}" rel="nofollow">external</a></p>` +
        `<ul><li>${paragraph}</li><li>One more point, in a list.</li></ul><img src="/i${String(i)}.png" alt="Widget ${String(i)}"><table><tr><td>${String(i)}</td><td>cell</td></tr></table></section>`,
    );
  }
  const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "Article", headline: "Widgets", dateModified: "2026-10-01" });
  return `<!doctype html><html lang="en"><head><title>Widgets</title><meta name="description" content="Widgets."><script type="application/ld+json">${ld}</script></head><body><header><nav>Menu</nav></header><main><h1>Widgets</h1>${sections.join("")}</main><footer>Footer</footer></body></html>`;
}

describe("STORY-050 AC11 · the model build inside its share of the latency budget", () => {
  it("STORY-050 #12 · a ~2 MB page, plain and rendered, builds at a rate that keeps 100 pages under a tenth of the 600 s audit budget", { timeout: 60_000 }, () => {
    const html = realisticPage();
    expect(html.length).toBeGreaterThan(1_000_000);
    expect(html.length).toBeLessThan(3_000_000);
    // CPU time of this process, not wall time: the unit suite runs many workers at once, and a bound on the work must not fail because
    // another worker held the cores. (Measured: ~3 s alone; ~8 s of WALL time inside the full suite, which failed a wall-clock version of this bound.)
    const started = process.cpuUsage();
    let blocks = 0;
    for (let n = 0; n < PAGES; n += 1) {
      const doc = buildAuxDocument(
        { url: "https://acme.com/p", finalUrl: "https://acme.com/p", httpStatus: 200, redirectChain: [], headers: {}, rawHtml: html, renderedHtml: html, timing: { ttfbMs: 1, loadMs: 2 } },
        cl100kTokenizer,
      );
      blocks += doc.blocks.length;
    }
    const used = process.cpuUsage(started);
    const elapsed = (used.user + used.system) / 1000;
    expect(blocks).toBeGreaterThan(PAGES);
    expect(elapsed).toBeLessThan((BUDGET_SHARE_MS / DOCUMENTED_PAGES) * PAGES);
  });
});
