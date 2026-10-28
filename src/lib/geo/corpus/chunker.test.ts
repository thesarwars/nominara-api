import { describe, expect, it } from "vitest";
import { CORPUS } from "./constants.js";
import { chunkDocument, type TokenCounter } from "./chunker.js";

// A word is a token: exact enough to test the SPLITTING, which is what this file proves. The real cl100k counter is injected in production.
const words: TokenCounter = { count: (text) => (text.trim() === "" ? 0 : text.trim().split(/\s+/).length) };
const para = (n: number, tag = "w") => Array.from({ length: n }, (_, i) => `${tag}${String(i)}`).join(" ");

describe("chunkDocument - STORY-058 AC5", () => {
  it("AC5 - documents the reference constants: 512 tokens, 64 overlap", () => {
    expect(CORPUS.chunkTokens).toBe(512);
    expect(CORPUS.chunkOverlapTokens).toBe(64);
  });
  it("AC5 - a short document is one chunk", () => {
    const chunks = chunkDocument("# H\n\nshort body here", words);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.index).toBe(0);
    expect(chunks[0]!.tokenCount).toBe(words.count(chunks[0]!.text));
  });
  it("AC5 - an empty document is no chunks", () => {
    expect(chunkDocument("", words)).toEqual([]);
    expect(chunkDocument("  \n\n ", words)).toEqual([]);
  });
  it("AC5 - no chunk ever exceeds the size, whatever the paragraph", () => {
    const doc = [para(1300, "a"), para(10, "b"), para(511, "c"), para(512, "d"), para(513, "e")].join("\n\n");
    const chunks = chunkDocument(doc, words);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(512);
      expect(chunk.tokenCount).toBe(words.count(chunk.text));
    }
  });
  it("AC5 - paragraphs are packed whole: a split falls between paragraphs when one fits", () => {
    const doc = [para(300, "a"), para(300, "b")].join("\n\n");
    const chunks = chunkDocument(doc, words);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text.startsWith("a0")).toBe(true);
    expect(chunks[1]!.text).toContain("b299");
  });
  it("AC5 - a heading always starts a new chunk (no chunk spans two sections)", () => {
    const chunks = chunkDocument(`# One\n\n${para(20, "a")}\n\n# Two\n\n${para(20, "b")}`, words);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).not.toContain("b0");
    expect(chunks[1]!.text.startsWith("# Two")).toBe(true);
  });
  it("AC5 - consecutive chunks of one oversized paragraph overlap by at most 64 tokens, and by at least one", () => {
    const chunks = chunkDocument(para(1300, "x"), words);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1]!.text.split(/\s+/);
      const next = chunks[i]!.text.split(/\s+/);
      let shared = 0;
      for (let k = Math.min(prev.length, next.length); k >= 1; k -= 1) {
        if (prev.slice(-k).join(" ") === next.slice(0, k).join(" ")) {
          shared = k;
          break;
        }
      }
      expect(shared).toBeGreaterThan(0);
      expect(shared).toBeLessThanOrEqual(64);
    }
  });
  it("AC5 - every word of the source appears in some chunk (nothing dropped)", () => {
    const doc = `# A\n\n${para(700, "p")}\n\n## B\n\n${para(90, "q")}`;
    const all = new Set(chunkDocument(doc, words).flatMap((chunk) => chunk.text.split(/\s+/)));
    for (let i = 0; i < 700; i += 1) expect(all.has(`p${String(i)}`)).toBe(true);
    for (let i = 0; i < 90; i += 1) expect(all.has(`q${String(i)}`)).toBe(true);
  });
  it("AC5 - indexes run 0..n-1 in document order", () => {
    const chunks = chunkDocument(`# A\n\n${para(600, "p")}\n\n# B\n\n${para(10, "q")}`, words);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, i) => i));
  });
  it("AC5 - a counter that never fits cannot loop forever (single unsplittable token over the size is cut, not retried)", () => {
    const hostile: TokenCounter = { count: (text) => text.length };
    const chunks = chunkDocument("a ".repeat(3000), hostile, { size: 512, overlap: 64 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(512);
  });
});
