import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Audit finding: "owner decision 5" and "owner decision 3" were cited in code, tests and evidence while the
// decisions file listed other things under those numbers. Citations of the 2026-10-08 second list use the
// label R<n>, and every R<n> cited must have an entry in the VERSIONED docs/plans/decisions-2026-10-08.md.

const root = join(import.meta.dirname, "..", "..");
const decisionsPath = join(root, "docs/plans/decisions-2026-10-08.md");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|md)$/.test(name)) out.push(p);
  }
  return out;
}

const files = ["src", "test", "docs/plans/evidence", "docs/plans/docs-carry"].flatMap((d) => {
  try {
    return walk(join(root, d));
  } catch {
    return [];
  }
});

describe("decision citations resolve to a versioned record", () => {
  it("AUDIT-1 · the decisions file is in the repository and records R3 (spans deferral) and R5 (contracts:diff)", () => {
    const text = readFileSync(decisionsPath, "utf8");
    expect(text).toMatch(/^### R3\b/m);
    expect(text).toMatch(/^### R5\b/m);
    expect(text).toMatch(/OpenTelemetry/);
    expect(text).toMatch(/ADDED OPTIONAL field is MINOR at ANY depth/);
  });

  it("AUDIT-1 · no bare 'decision 5' or 'owner decision 3' citation is left (they collided with the first list)", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (f.endsWith("decision-citations.spec.ts")) continue;
      const t = readFileSync(f, "utf8");
      if (/\b(owner )?decisions? [35]\b/i.test(t.replace(/decisions? 3 and 5/gi, ""))) bad.push(f.replace(root, ""));
    }
    expect(bad).toEqual([]);
  });

  it("AUDIT-1 · the STORY-023 and NFR-REPO-02 edits are carried to a versioned location", () => {
    const story = readFileSync(join(root, "docs/plans/docs-carry/STORY-023.md"), "utf8");
    const nfr = readFileSync(join(root, "docs/plans/docs-carry/NFR-REPO-02.md"), "utf8");
    expect(story).toMatch(/decision R5/);
    expect(nfr).toMatch(/decision R5/);
  });
});
