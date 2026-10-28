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

  // Counts generated ONCE with Python tiktoken 0.14.0 (`get_encoding("cl100k_base").encode(text, disallowed_special=())`) and
  // committed; gpt-tokenizer produced none of them. These are the inputs pages really produce, which five ASCII strings are not.
  it.each([
    ["mixed Unicode", "Caf\u00e9 na\u00efve \u2014 \u6771\u4eac\u30bf\u30ef\u30fc \u{1F680} \u0645\u0631\u062d\u0628\u0627", 21],
    ["CJK", "\u4eca\u5929\u5929\u6c14\u5f88\u597d\uff0c\u6211\u4eec\u53bb\u516c\u56ed\u6563\u6b65\u5427\u3002", 20],
    ["emoji with a skin-tone modifier", "Great job \u{1F44D}\u{1F3FD}\u{1F389}\u{1F389} done!", 15],
    ["a long whitespace run, blank lines and a tab", `a${" ".repeat(40)}b\n\n\n\tc`, 5],
    ["digits and a date", "Order 1234567890123 shipped 3 days before 2026-10-28", 19],
    ["a newline-joined multi-line main text", "Widgets\nAcme builds widgets for engineering teams.\nThey ship on time, every time. Really!\n\nContact: sales@acme.example", 27],
    ["a 60-digit number", "9".repeat(60), 20],
  ])("STORY-050 #4 · %s is the tiktoken cl100k_base count", (_name, text, expected) => {
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
