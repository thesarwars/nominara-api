import { describe, expect, it } from "vitest";
import { MAX_STORED_TEXT_CHARS, robotsSnapshotOf, sanitiseText } from "./sanitise.js";

// STORY-049 AC11 — crawled content is untrusted. The bytes of a page are stored exactly as fetched, in object storage
// (aux-and-geo-analysis.md AUX-R-027 needs the script a site ships). What is sanitised is the TEXT that reaches Postgres.
describe("STORY-049 AC11 · sanitiseText (text that reaches Postgres)", () => {
  it("removes NUL, which Postgres text cannot hold (a robots.txt with one would otherwise fail the whole audit write)", () => {
    expect(sanitiseText("User-agent: *\u0000Disallow: /")).toBe("User-agent: *Disallow: /");
  });

  it("removes other C0 and C1 control characters but keeps tab, newline and carriage return", () => {
    expect(sanitiseText("a\u0007b\u001bc\u0085d\te\nf\rg")).toBe("abcd\te\nf\rg");
  });

  it("replaces a lone surrogate with U+FFFD rather than emitting invalid UTF-8", () => {
    expect(sanitiseText("x\ud800y")).toBe("x�y");
    expect(sanitiseText("ok \u{1F600}")).toBe("ok \u{1F600}");
  });

  it("caps the length in characters and never splits a surrogate pair", () => {
    expect(sanitiseText("abcdef", 3)).toBe("abc");
    expect(sanitiseText("a\u{1F600}b", 2)).toBe("a\u{1F600}".slice(0, 1)); // 2 code units would split the pair: it is dropped whole
    expect(sanitiseText("abc", 3)).toBe("abc");
  });

  it("an empty string stays empty, and the default cap is the stated constant", () => {
    expect(sanitiseText("")).toBe("");
    expect(sanitiseText("x".repeat(MAX_STORED_TEXT_CHARS + 5)).length).toBe(MAX_STORED_TEXT_CHARS);
  });
});

// STORY-049 AC4 - the robots.txt snapshot is stored VERBATIM with its hash.
describe("STORY-049 AC4 - robotsSnapshotOf", () => {
  const snapshot = (bytes: Buffer): string => robotsSnapshotOf(bytes, bytes.toString("utf8"));

  it("STORY-049 AC4 - valid text is stored exactly: CRLF, tabs, trailing spaces, no final newline, a BOM and control characters Postgres can hold", () => {
    const text = "﻿User-agent: *\r\nDisallow:\t/private  \r\n# note \u0001 and \u0085\r\nAllow: /";
    const raw = Buffer.from(text, "utf8");
    expect(snapshot(raw)).toBe(text);
    // The proof the story asks for: the stored text re-encodes to the bytes the hash was taken over.
    expect(Buffer.from(snapshot(raw), "utf8").equals(raw)).toBe(true);
  });

  it("STORY-049 AC4 - a file past the old one-million-character cut is stored whole", () => {
    const text = `User-agent: *\n${"# padding\n".repeat(150_000)}Disallow: /x\n`;
    expect(text.length).toBeGreaterThan(1_000_000);
    expect(snapshot(Buffer.from(text, "utf8"))).toBe(text);
  });

  it("STORY-049 AC4 - an empty file is the empty string, not null", () => {
    expect(snapshot(Buffer.alloc(0))).toBe("");
  });

  it("STORY-049 AC4 - a NUL byte cannot be stored in a Postgres text column, so ONLY that case falls back to the sanitised decode", () => {
    const raw = Buffer.from("User-agent: *\u0000\nAllow: /\n", "utf8");
    expect(snapshot(raw)).toBe("User-agent: *\nAllow: /\n");
  });

  it("STORY-049 AC4 - bytes that are not valid UTF-8 fall back to the sanitised decode (the hash over the raw bytes remains the proof)", () => {
    const raw = Buffer.concat([Buffer.from("User-agent: *\n# "), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from("\n")]);
    const stored = snapshot(raw);
    expect(Buffer.from(stored, "utf8").equals(raw)).toBe(false);
    expect(stored).toContain("User-agent: *");
    expect(stored).not.toContain("\u0000");
  });
});
