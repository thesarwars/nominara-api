import { z } from "zod";
import { isRecord } from "./helpers.js";
import { defineRule } from "./types.js";

// render_mode — AUX-R-026, 027, 029. The first two compare the plain and the rendered variants (a ratio, and a set difference); the
// rendered copy is null when no capture exists, and then there is nothing to compare: no finding, which is not the same as a pass,
// and the audit's manifest already records that the page had no rendered copy. AUX-R-028 needs a click/scroll trace the document
// model does not carry (see AUX_RULES_NOT_EVALUATED).

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const jsOnlyMainContent = defineRule({
  code: "AUX-R-026",
  category: "render_mode",
  autoFixable: false,
  thresholds: strict({ warn_ratio: z.number().min(0).max(1), critical_ratio: z.number().min(0).max(1) }),
  evaluate(doc, t) {
    if (doc.rendered === null || doc.rendered.mainTokenCount === 0) return [];
    // (rendered - plain) / rendered, not 1 - plain / rendered: the second form turns 70/100 into 0.30000000000000004.
    const gap = (doc.rendered.mainTokenCount - doc.raw.mainTokenCount) / doc.rendered.mainTokenCount;
    if (!(gap > t.warn_ratio)) return [];
    const critical = gap > t.critical_ratio;
    return [{ severity: critical ? "critical" : "high", measured: gap, threshold: critical ? t.critical_ratio : t.warn_ratio, reason: "js_only_main_content", snippet: `plain ${String(doc.raw.mainTokenCount)} of rendered ${String(doc.rendered.mainTokenCount)} main-content tokens`, locator: "rendered.mainTokenCount" }];
  },
});

/** JSON with object keys sorted, so two blocks that differ only in key order are the same block. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isRecord(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export const structuredDataClientSideOnly = defineRule({
  code: "AUX-R-027",
  category: "render_mode",
  autoFixable: false,
  thresholds: strict({ min_missing_blocks: z.number().int().positive() }),
  evaluate(doc, t) {
    if (doc.rendered === null) return [];
    const served = new Set(doc.raw.structured.jsonLd.map(canonical));
    const injected = doc.rendered.structured.jsonLd.map((b, i) => ({ b, i })).filter(({ b }) => !served.has(canonical(b)));
    if (injected.length < t.min_missing_blocks) return [];
    const first = injected[0]!;
    return [{ severity: "critical", measured: injected.length, threshold: t.min_missing_blocks, reason: "jsonld_rendered_only", snippet: canonical(first.b), locator: `rendered.jsonld[${String(first.i)}]` }];
  },
});

export const slowFirstByteForBots = defineRule({
  code: "AUX-R-029",
  category: "render_mode",
  autoFixable: false,
  thresholds: strict({ max_ttfb_ms: z.number().positive(), max_load_ms: z.number().positive(), max_bytes: z.number().int().positive() }),
  evaluate(doc, t) {
    // A timing the fetcher did not record is null and is skipped; a measured 0 is a measurement.
    const breaches: { reason: string; measured: number; threshold: number }[] = [];
    if (doc.timing.ttfbMs !== null && doc.timing.ttfbMs > t.max_ttfb_ms) breaches.push({ reason: "ttfb_ms", measured: doc.timing.ttfbMs, threshold: t.max_ttfb_ms });
    if (doc.timing.loadMs !== null && doc.timing.loadMs > t.max_load_ms) breaches.push({ reason: "load_ms", measured: doc.timing.loadMs, threshold: t.max_load_ms });
    if (doc.timing.bytes > t.max_bytes) breaches.push({ reason: "bytes", measured: doc.timing.bytes, threshold: t.max_bytes });
    if (breaches.length === 0) return [];
    const first = breaches[0]!;
    return [{ severity: "medium", measured: first.measured, threshold: first.threshold, reason: breaches.map((b) => b.reason).join("+"), snippet: null, locator: "timing" }];
  },
});
