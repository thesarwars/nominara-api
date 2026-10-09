import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { entityProminence, shareOfVoice, visibilityScore } from "../../../src/lib/scoring/index.js";

// STORY-041 AC1 — "The library imports nothing outside the standard library.
// No clock, no randomness, no input or output."
//
// ASSERTED, NOT ASSUMED. The story makes the constraint absolute rather than
// aspirational and says why: "A hidden dependency on the clock or on a
// database read would make the golden set unable to distinguish a bug from an
// environment difference, and THE GATE WOULD BECOME ADVISORY."
//
// An advisory gate on the four differentiators and every chart in the product
// is worth a static check, because the failure it prevents is silent: a
// `Date.now()` added here would not break a single behavioural test.

const SCORING_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../src/lib/scoring");

function scoringSources(): { file: string; source: string }[] {
  return readdirSync(SCORING_DIR)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, source: readFileSync(join(SCORING_DIR, file), "utf8") }));
}

describe("STORY-041 AC1 · the scoring library is pure", () => {
  it("finds the library at all — a sweep over nothing passes vacuously", () => {
    expect(scoringSources().length).toBeGreaterThanOrEqual(4);
  });

  it("imports NOTHING — not the standard library, not even a sibling module", () => {
    // `index.ts` re-exports its own siblings, which is the one permitted
    // import: it moves no logic and adds no dependency.
    const offenders = scoringSources().flatMap(({ file, source }) =>
      [...source.matchAll(/^\s*import\s.*?from\s+["']([^"']+)["']/gmu)]
        .map((match) => ({ file, specifier: match[1]! }))
        .filter(({ specifier }) => !(file === "index.ts" && specifier.startsWith("./"))),
    );

    expect(offenders, "the scoring library must import nothing").toEqual([]);
  });

  it("reads no clock and no randomness", () => {
    // The two that would make a golden-set regression non-reproducible, and
    // the two most likely to be added by accident — a `Date.now()` for a
    // "recency weight", a `Math.random()` for a tie-break.
    const forbidden = [/\bDate\s*\./u, /\bnew\s+Date\b/u, /\bMath\s*\.\s*random\b/u, /\bperformance\s*\./u];
    for (const { file, source } of scoringSources()) {
      // Comments quote the reference and may legitimately mention a date.
      const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${file} must not reference ${String(pattern)}`).toBe(false);
      }
    }
  });

  it("performs no input or output", () => {
    const forbidden = [/\bprocess\s*\./u, /\bconsole\s*\./u, /\bfetch\s*\(/u, /\brequire\s*\(/u];
    for (const { file, source } of scoringSources()) {
      const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${file} must not reference ${String(pattern)}`).toBe(false);
      }
    }
  });
});

describe("STORY-056 · the displacement comparison imports nothing", () => {
  it("src/lib/analytics/displacement.ts has an empty import list and reads no clock", () => {
    const source = readFileSync(join(SCORING_DIR, "../analytics/displacement.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    expect([...code.matchAll(/^\s*import\s.*?from\s+["']([^"']+)["']/gmu)]).toEqual([]);
    expect(/\bDate\s*\./u.test(code) || /\bnew\s+Date\b/u.test(code) || /\bMath\s*\.\s*random\b/u.test(code)).toBe(false);
  });
});

describe("STORY-041 · determinism, which is what purity buys", () => {
  it("gives byte-identical results across repeated calls", () => {
    const input = {
      responseLength: 2418,
      mentions: [
        { entityKey: "a", charStart: 52, listPosition: 1, clause: "recommendation" as const, contrastivePivotAway: false, inLink: false },
        { entityKey: "b", charStart: 176, listPosition: 2, clause: "neutral" as const, contrastivePivotAway: true, inLink: false },
      ],
    };

    const first = JSON.stringify([...entityProminence(input)]);
    for (let i = 0; i < 50; i += 1) {
      expect(JSON.stringify([...entityProminence(input)])).toBe(first);
    }
  });

  it("does not mutate its inputs", () => {
    // A caller reusing a cell list across engines must not find it changed.
    const cells = [
      { status: "answered" as const, engineWeight: 1, sov: 0.5, brandPresent: true },
      { status: "failed" as const, engineWeight: 1, sov: 0, brandPresent: false },
    ];
    const before = JSON.stringify(cells);
    shareOfVoice(cells);
    expect(JSON.stringify(cells)).toBe(before);
  });

  it("AC14 — a score recomputed by hand matches to 1e-9", () => {
    // The success metric the whole slice exists to prove: "a Visibility Score
    // on screen that you can recompute by hand from an exported cell list and
    // match EXACTLY to 1e-9."
    const components = { presenceRate: 0.6, shareOfVoice: 0.42, citationShare: 0.31, sentimentScore: 68 };
    const byHand = 100 * (0.4 * 0.6 + 0.25 * 0.42 + 0.2 * 0.31 + 0.15 * (68 / 100));

    expect(visibilityScore(components)!).toBeCloseTo(byHand, 9);
  });
});
