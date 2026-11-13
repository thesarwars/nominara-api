import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MEASURED_FLOOR_COPY } from "../../contracts/attribution/index.js";

// STORY-116 AC13 / scenario 14 - "remove the measured-floor caveat from a figure or an export: fails". A vitest gate, as decision 19 settled
// for the causal-phrasing rule (not an ESLint rule). Every path that produces attribution figures must take the caveat from the ONE shared
// constant; the gate defaults to REPORT, so a new producer that omits it fails here rather than being allow-listed.
const ROOT = resolve(import.meta.dirname, "../..");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(full)) out.push(full);
  }
  return out;
};
const rel = (p: string): string => relative(ROOT, p);

/** Why a source file breaks the rule (empty when it keeps it). */
export function caveatFindings(path: string, text: string): string[] {
  const found: string[] = [];
  // 1. The caveat's words live only in the constant: a hand-typed copy can drift from, or replace, the shared one.
  if (path !== "contracts/attribution/attribution-report.schema.ts" && /measured counts and a floor/i.test(text)) found.push(`${path}: hand-written caveat text`);
  // 2. Every attribution report literal takes the note from the constant.
  for (const m of text.matchAll(/measured_floor_note:\s*([^,\n;}]+)/g)) {
    const value = m[1]!.trim();
    if (!/^z\.string\(\)$/.test(value) && value !== "MEASURED_FLOOR_COPY") found.push(`${path}: measured_floor_note is set from ${value}`);
  }
  for (const m of text.matchAll(/measuredFloorNote:\s*([^,\n;}]+)/g)) {
    const value = m[1]!.trim();
    if (!/^string$/.test(value) && value !== "MEASURED_FLOOR_COPY") found.push(`${path}: measuredFloorNote is set from ${value}`);
  }
  return found;
}

describe("STORY-116 AC13 · the measured-floor caveat cannot be omitted (decision 19: a vitest gate)", () => {
  it("scenario 14 - no source file hand-writes the caveat or sets it from anything but the shared constant", () => {
    const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "contracts"))];
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap((f) => caveatFindings(rel(f), readFileSync(f, "utf8")))).toEqual([]);
  });

  it("scenario 14 - the response contract REQUIRES the note (not optional, not nullable), so an omitting producer fails to type-check", () => {
    const schema = readFileSync(join(ROOT, "contracts/attribution/attribution-report.schema.ts"), "utf8");
    const line = /measured_floor_note:[^\n]*/.exec(schema)?.[0] ?? "";
    expect(line).toMatch(/z\.string\(\)/);
    expect(line).not.toMatch(/optional|nullable|nullish/);
  });

  it("scenario 14 - both producers use it: the report service and the export builder", () => {
    expect(readFileSync(join(ROOT, "src/modules/attribution/attribution.service.ts"), "utf8")).toMatch(/measured_floor_note: MEASURED_FLOOR_COPY/);
    expect(readFileSync(join(ROOT, "src/lib/reports/export-document.ts"), "utf8")).toMatch(/measuredFloorNote: MEASURED_FLOOR_COPY/);
  });

  it("the gate is live: a producer that reworded the caveat is reported", () => {
    expect(caveatFindings("src/x.ts", "const r = { measured_floor_note: 'all good' };")).toHaveLength(1);
    expect(caveatFindings("src/x.ts", "const r = { measuredFloorNote: reword(MEASURED_FLOOR_COPY) };")).toHaveLength(1);
    expect(caveatFindings("src/x.ts", `const note = "Figures are measured counts and a floor";`)).toHaveLength(1);
    expect(caveatFindings("src/x.ts", "const r = { measured_floor_note: MEASURED_FLOOR_COPY };")).toEqual([]);
    expect(MEASURED_FLOOR_COPY).toMatch(/measured counts and a floor/);
  });
});
