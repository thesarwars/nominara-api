import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAuxDocument } from "./document-model.js";
import { cl100kTokenizer, CL100K_PACKAGE_VERSION } from "./tokenizer-cl100k.js";
import { tokenizerLabel } from "./tokenizer.js";

// STORY-050 #4 and #5 — parity with the embedding model's tokenizer. The expected counts are the published cl100k_base counts
// (OpenAI's tiktoken: "hello world" = [15339, 1917], "tiktoken is great!" = [83, 1609, 5963, 374, 2294, 0]), independent of
// the package under test and nothing like a word count: "tiktoken is great!" is 3 words and 6 tokens.

describe("STORY-050 tokenizer parity", () => {
  it.each([
    ["", 0],
    ["hello world", 2],
    ["tiktoken is great!", 6],
    ["Hello", 1],
    ["   ", 1],
  ])("STORY-050 #4 · %j is %i cl100k_base tokens", (text, expected) => {
    expect(cl100kTokenizer.count(text)).toBe(expected);
  });

  it("STORY-050 #4 · the count is not a word count", () => {
    const text = "Antidisestablishmentarianism supercalifragilisticexpialidocious 2026-10-28";
    expect(cl100kTokenizer.count(text)).toBeGreaterThan(text.split(/\s+/u).length * 2);
  });

  it("STORY-050 #4 · special-token text on a hostile page is counted as ordinary text, never thrown", () => {
    expect(cl100kTokenizer.count("a <|endoftext|> b")).toBe(8);
  });

  it("STORY-050 #4 · the model's token counts are the tokenizer's counts of the text", () => {
    const html = `<html><body><main><h1>Title</h1><p>tiktoken is great!</p></main></body></html>`;
    const d = buildAuxDocument({ url: "https://e.com/", finalUrl: "https://e.com/", httpStatus: 200, redirectChain: [], headers: {}, rawHtml: html, renderedHtml: html, timing: { ttfbMs: 1, loadMs: 2 } }, cl100kTokenizer);
    expect(d.raw.mainText).toBe("Title\ntiktoken is great!");
    expect(d.raw.mainTokenCount).toBe(cl100kTokenizer.count("Title\ntiktoken is great!"));
    expect(d.blocks.map((b) => b.tokens)).toEqual([6]);
  });

  it("STORY-050 #5 · the identity names the encoding and the package version, and matches the pinned dependency", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["gpt-tokenizer"]).toBe(CL100K_PACKAGE_VERSION);
    expect(tokenizerLabel(cl100kTokenizer.identity)).toBe(`cl100k_base@gpt-tokenizer@${CL100K_PACKAGE_VERSION}`);
  });
});
