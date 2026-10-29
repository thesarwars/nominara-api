import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// STORY-051 AC5 — thresholds are data. A rule file holds no numeric threshold of its own: a presence bar ("at least one") is the one
// named constant PRESENCE_THRESHOLD, never a literal beside `threshold:`, and ordering never depends on the host locale.
const dir = new URL("./", import.meta.url);
const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

describe("STORY-051 AC5 · no threshold literal in a rule", () => {
  for (const file of sources) {
    it(`STORY-051 AC5 · ${file} returns no numeric literal as threshold`, () => {
      const src = readFileSync(new URL(file, dir), "utf8");
      expect(src.match(/\bthreshold:\s*-?\d/gu) ?? []).toEqual([]);
    });
    it(`STORY-051 AC2 · ${file} does not order by the host locale`, () => {
      expect(readFileSync(new URL(file, dir), "utf8")).not.toMatch(/\.localeCompare\(/u);
    });
  }
});
