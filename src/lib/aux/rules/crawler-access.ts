import { z } from "zod";
import { defineRule } from "./types.js";

// AUX-R-006 — `noai` / `noimageai` / `noarchive` on a tracked page (the document-model half of crawler_access; AUX-R-001..004 and
// 007 judge the site files, in ../site-files.ts). `meta.directives` already holds the bare indexing directives of the meta robots tag,
// the googlebot meta tag and X-Robots-Tag that apply to everyone or to Googlebot, lowercased and sorted.

export const noAiDirective = defineRule({
  code: "AUX-R-006",
  category: "crawler_access",
  autoFixable: true,
  thresholds: z.object({ directives: z.array(z.string().min(1)).min(1), min_matches: z.number().int().positive() }).strict(),
  evaluate(doc, t) {
    const wanted = new Set(t.directives.map((d) => d.toLowerCase()));
    const matched = doc.meta.directives.filter((d) => wanted.has(d));
    if (matched.length < t.min_matches) return [];
    const inHeader = Object.entries(doc.headers).some(([k, v]) => k.toLowerCase() === "x-robots-tag" && matched.some((m) => v.toLowerCase().includes(m)));
    return [{ severity: "high", measured: matched.length, threshold: t.min_matches, reason: "directive", snippet: matched.join(", "), locator: inHeader ? "headers.x-robots-tag" : "meta.robots" }];
  },
});
