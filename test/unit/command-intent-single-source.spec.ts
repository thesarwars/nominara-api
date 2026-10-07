import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMAND_INTENTS } from "../../contracts/command/command-intent.schema.js";

// STORY-085 #7 / AC "the canonical intents are enumerated in exactly one
// place ... no second list, no count restated anywhere".
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "sql") return [];
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("STORY-085 #7 · one definition of the canonical intents", () => {
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "contracts"))].filter(
    (f) => !f.endsWith(".spec.ts") && !f.endsWith(".test.ts"),
  );
  const DEFINITION = join(ROOT, "contracts/command/command-intent.schema.ts");

  it("the list is the definition's own, and has no duplicates", () => {
    expect(new Set(COMMAND_INTENTS).size).toBe(COMMAND_INTENTS.length);
    expect(files).toContain(DEFINITION);
  });

  it("no other source file spells out a second list of the intents", () => {
    // A second list would repeat at least three of the intent names as string literals.
    const offenders = files.filter((file) => {
      if (file === DEFINITION) return false;
      const source = readFileSync(file, "utf8");
      return COMMAND_INTENTS.filter((intent) => source.includes(`"${intent}"`)).length >= 3;
    });
    expect(offenders.map((f) => f.replace(ROOT, ""))).toEqual([]);
  });

  it("no source file restates the count of intents", () => {
    const count = String(COMMAND_INTENTS.length);
    const words = ["fourteen", count];
    const offenders = files.filter((file) => {
      if (file === DEFINITION) return false;
      const source = readFileSync(file, "utf8");
      return words.some((w) => new RegExp(`\\b${w}\\s+(canonical\\s+)?intents?\\b`, "i").test(source));
    });
    expect(offenders.map((f) => f.replace(ROOT, ""))).toEqual([]);
  });
});
