import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// NEW-E-100b AC5 (owner decision 4, 2026-10-08) — the PDF bundles Inter (SIL OFL 1.1), regular and bold, as
// .ttf files under the API, next to the renderer, with the licence beside them. No font is fetched at render
// time; per-theme fonts are a later story.

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "lib", "reports", "fonts");

describe("NEW-E-100b AC5 · the bundled Inter font files", () => {
  for (const file of ["Inter-Regular.ttf", "Inter-Bold.ttf"]) {
    it(`NEW-E-100b AC5 — ${file} ships with the API as a real TrueType file`, () => {
      const full = path.join(FONT_DIR, file);
      expect(existsSync(full), full).toBe(true);
      expect(statSync(full).size).toBeGreaterThan(100_000);
      // sfnt version 0x00010000 = TrueType outlines
      expect(readFileSync(full).subarray(0, 4).toString("hex")).toBe("00010000");
    });
  }

  it("NEW-E-100b AC5 — the SIL Open Font License 1.1 and the Inter copyright travel with the font files", () => {
    const full = path.join(FONT_DIR, "OFL.txt");
    expect(existsSync(full), full).toBe(true);
    const licence = readFileSync(full, "utf8");
    expect(licence).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(licence).toContain("The Inter Project Authors");
  });
});
