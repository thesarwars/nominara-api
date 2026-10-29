import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// STORY-059 AC10 / NFR-OPT-02 - "ranking-guarantee language is prohibited". There is no repository-wide copy lint yet, so this is the
// guard (AC10 stays PARTIAL on its "lint-prohibited" half: this is a scoped vitest scan, not an ESLint rule, and covers no other module or client copy) for the code that WRITES the strings customers read: no string literal in the alignment library (comments excluded) may
// promise a ranking, a citation or an outcome. The contract's own caveat is scanned in contracts/analytics/geo-alignment.schema.test.ts.

const BANNED = /\b(guarantee[sd]?|will\s+(?:rank|be\s+cited|appear)|rank(?:s|ing)?\s+(?:higher|#?1|first)|ensures?\s+(?:citation|ranking|visibility)|boosts?\s+your\s+rank|#1\s+rank)/i;

describe("STORY-059 AC10 - no ranking-guarantee wording in the alignment library", () => {
  const dir = import.meta.dirname;
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("scans every source file of the library", () => {
    expect(files).toEqual(expect.arrayContaining(["node-types.ts", "payload.ts", "analyse-nodes.ts"]));
  });

  it.each(files)("%s has no guarantee wording in a string", (file) => {
    const source = readFileSync(path.join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
    const strings = [...source.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? "");
    expect(strings.filter((s) => BANNED.test(s))).toEqual([]);
  });

  it("the guard itself bites: it catches a guarantee and lets the caveat through", () => {
    expect(BANNED.test("This guarantees you will rank higher")).toBe(true);
    expect(BANNED.test("Your page will be cited")).toBe(true);
    expect(BANNED.test("Modeled estimate of embedding proximity")).toBe(false);
  });
});
