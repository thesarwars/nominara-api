import { z } from "zod";
import type { ContentBlock, Heading } from "../document-model.js";
import { PRESENCE_THRESHOLD, clip, flattenHeadings, variantOf } from "./helpers.js";
import { defineRule, type RuleHit } from "./types.js";

// context_fitness — AUX-R-019..025, the truncation family. Every threshold is a TOKEN count or a ratio over tokens the document
// model counted with the embedding model's own tokenizer (STORY-050), and comes from the rule's catalog row.

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const pageTokensExcessive = defineRule({
  code: "AUX-R-019",
  category: "context_fitness",
  autoFixable: false,
  thresholds: strict({ warn_tokens: z.number().int().positive(), critical_tokens: z.number().int().positive() }),
  evaluate(doc, t) {
    const tokens = variantOf(doc).tokenCount;
    if (!(tokens > t.warn_tokens)) return [];
    const critical = tokens > t.critical_tokens;
    return [{ severity: critical ? "critical" : "high", measured: tokens, threshold: critical ? t.critical_tokens : t.warn_tokens, reason: "page_tokens", snippet: null, locator: doc.rendered === null ? "raw.tokenCount" : "rendered.tokenCount" }];
  },
});

export const mainContentRatioLow = defineRule({
  code: "AUX-R-020",
  category: "context_fitness",
  autoFixable: false,
  thresholds: strict({ min_ratio: z.number().min(0).max(1) }),
  evaluate(doc, t) {
    const v = variantOf(doc);
    // No tokens at all = no ratio (a null, not a 0): an empty capture is not a page that is all boilerplate.
    if (v.tokenCount === 0) return [];
    const ratio = v.mainTokenCount / v.tokenCount;
    if (!(ratio < t.min_ratio)) return [];
    return [{ severity: "high", measured: ratio, threshold: t.min_ratio, reason: "main_content_ratio", snippet: `${String(v.mainTokenCount)} of ${String(v.tokenCount)} tokens`, locator: doc.rendered === null ? "raw.mainTokenCount" : "rendered.mainTokenCount" }];
  },
});

const hasStructure = (b: ContentBlock): boolean => b.tables > 0 || b.lists.ordered + b.lists.unordered + b.lists.definition > 0;

// Interim reading (STORY-050 model gap: contiguous unstructured-run tokens per block): a list or table anywhere in a section counts as a break.
export const contextBlockTruncation = defineRule({
  code: "AUX-R-021",
  category: "context_fitness",
  autoFixable: false,
  thresholds: strict({ warn_tokens: z.number().int().positive(), critical_tokens: z.number().int().positive() }),
  evaluate(doc, t) {
    const hits: RuleHit[] = [];
    doc.blocks.forEach((b, i) => {
      // A heading section already ends at its next heading; a table or list inside it is the other kind of break.
      if (!(b.tokens > t.warn_tokens) || hasStructure(b)) return;
      const critical = b.tokens > t.critical_tokens;
      hits.push({ severity: critical ? "critical" : "high", measured: b.tokens, threshold: critical ? t.critical_tokens : t.warn_tokens, reason: "section_tokens", snippet: b.heading === null ? "(content before the first heading)" : b.heading, locator: `blocks[${String(i)}]` });
    });
    return hits;
  },
});

export const paragraphDensity = defineRule({
  code: "AUX-R-022",
  category: "context_fitness",
  autoFixable: false,
  thresholds: strict({ max_paragraph_chars: z.number().int().positive(), max_mean_sentence_words: z.number().positive() }),
  evaluate(doc, t) {
    const hits: RuleHit[] = [];
    doc.blocks.forEach((b, i) => {
      const long = b.longestParagraphChars > t.max_paragraph_chars;
      // A section with no sentences has a null mean; null is not a long sentence.
      const dense = b.sentences.meanWords !== null && b.sentences.meanWords > t.max_mean_sentence_words;
      if (!long && !dense) return;
      hits.push({
        severity: "medium",
        measured: long ? b.longestParagraphChars : b.sentences.meanWords,
        threshold: long ? t.max_paragraph_chars : t.max_mean_sentence_words,
        reason: long && dense ? "paragraph_chars+sentence_words" : long ? "paragraph_chars" : "sentence_words",
        snippet: b.heading,
        locator: `blocks[${String(i)}]`,
      });
    });
    return hits.slice(0, 1);
  },
});

// Interim reading (STORY-050 model gap: per-paragraph sentence counts): a whole short section stands in for the summary paragraph.
export const answerShapedContentAbsent = defineRule({
  code: "AUX-R-023",
  category: "context_fitness",
  autoFixable: true,
  thresholds: strict({ window_tokens: z.number().int().positive(), max_summary_sentences: z.number().int().positive() }),
  evaluate(doc, t) {
    let before = 0;
    for (const b of doc.blocks) {
      if (before >= t.window_tokens) break; // a section that starts after the window is not "in the first 400 tokens"
      const shaped = b.tables > 0 || b.lists.ordered > 0 || b.lists.definition > 0;
      const summary = b.sentences.count >= 1 && b.sentences.count <= t.max_summary_sentences && b.tokens <= t.window_tokens;
      if (shaped || summary) return [];
      before += b.tokens;
    }
    return [{ severity: "medium", measured: 0, threshold: PRESENCE_THRESHOLD, reason: "no_answer_shaped_content", snippet: doc.blocks[0]?.heading ?? null, locator: "blocks[0]" }];
  },
});

export const headingHierarchyBroken = defineRule({
  code: "AUX-R-024",
  category: "context_fitness",
  autoFixable: true,
  thresholds: strict({ max_h1: z.number().int().positive(), max_level_step: z.number().int().positive() }),
  evaluate(doc, t) {
    const tree = variantOf(doc).headingTree;
    const all = flattenHeadings(tree);
    const h1 = all.filter((h) => h.level === 1);
    const hits: { reason: string; snippet: string | null; locator: string }[] = [];
    if (h1.length === 0) hits.push({ reason: "no_h1", snippet: null, locator: "headings" });
    if (h1.length > t.max_h1) hits.push({ reason: "multiple_h1", snippet: h1[1]!.text, locator: "headings" });
    const visit = (parent: Heading, path: string): void => {
      parent.children.forEach((c, i) => {
        if (c.level - parent.level > t.max_level_step) hits.push({ reason: "level_skip", snippet: c.text, locator: `${path}.children[${String(i)}]` });
        visit(c, `${path}.children[${String(i)}]`);
      });
    };
    // A heading that opens the page below the H1's level (an H3 before the H1) skips the levels above it; a root has no parent to compare with.
    if (tree.length > 0 && tree[0]!.level - 1 > t.max_level_step) hits.push({ reason: "level_skip", snippet: tree[0]!.text, locator: "headings[0]" });
    tree.forEach((r, i) => visit(r, `headings[${String(i)}]`));
    if (hits.length === 0) return [];
    return [{ severity: "medium", measured: hits.length, threshold: PRESENCE_THRESHOLD, reason: hits[0]!.reason, snippet: hits[0]!.snippet === null ? null : clip(hits[0]!.snippet), locator: hits[0]!.locator }];
  },
});

// AUX-R-025 reads the plain HTML of the page. It cannot see inside an image, so "key facts" is judged by what the image is called
// (file name, alt text) against the catalog's keyword list; "adjacent text" is the text within `adjacent_window_chars` characters of the tag, headings
// excluded, of at least as many characters as the alt bar; the rule says so in its guidance rather than pretending to read pixels.
const IMG_TAG = /<img\b[^>]*>/giu;
const attr = (tag: string, name: string): string => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "iu").exec(tag)?.slice(1).find((x) => x !== undefined) ?? "";
const stripTags = (s: string): string => s.replace(/<(script|style|h[1-6])\b[\s\S]*?<\/\1>/giu, " ").replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();

// Interim reading (STORY-050 model gap: per-image records): images come from the plain HTML only, so script-injected images are not seen.
export const keyFactsInMedia = defineRule({
  code: "AUX-R-025",
  category: "context_fitness",
  autoFixable: false,
  thresholds: strict({ min_alt_chars: z.number().int().positive(), min_adjacent_chars: z.number().int().positive(), adjacent_window_chars: z.number().int().positive(), keywords: z.array(z.string().min(1)).min(1) }),
  evaluate(doc, t) {
    const html = doc.raw.html;
    const hits: RuleHit[] = [];
    for (const m of html.matchAll(IMG_TAG)) {
      const tag = m[0];
      const src = attr(tag, "src");
      const alt = attr(tag, "alt").trim();
      const label = `${src.split("?")[0]!.split("/").pop() ?? ""} ${alt}`.toLowerCase();
      if (!t.keywords.some((k) => label.includes(k.toLowerCase()))) continue;
      const altLength = [...alt].length;
      if (altLength >= t.min_alt_chars) continue;
      const at = m.index;
      const around = `${stripTags(html.slice(Math.max(0, at - t.adjacent_window_chars), at))} ${stripTags(html.slice(at + tag.length, at + tag.length + t.adjacent_window_chars))}`.trim();
      if ([...around].length >= t.min_adjacent_chars || /<figcaption\b/iu.test(html.slice(at, at + tag.length + t.adjacent_window_chars))) continue;
      hits.push({ severity: "high", measured: altLength, threshold: t.min_alt_chars, reason: "key_fact_image", snippet: clip(tag), locator: `raw.html@${String(at)}` });
    }
    return hits.slice(0, 1);
  },
});
