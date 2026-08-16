import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSERTIONS } from "../assertions/registry.js";

// STORY-012 T6/T27 — structural completeness of the breaker matrix: every
// registered assertion has EXACTLY one paired breaker. Reads the ids from
// test/isolation/assertions/ itself (iso-NN-*.ts) rather than a hardcoded
// list, so an assertion module added but never registered in registry.ts is
// actually caught, instead of a stale literal list quietly agreeing with a
// stale registry.
const ASSERTIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assertions");

function idsFromAssertionModules(): string[] {
  return readdirSync(ASSERTIONS_DIR)
    .filter((f) => /^iso-\d\d-.+\.ts$/.test(f))
    .map((f) => `ISO-${f.slice(4, 6)}`)
    .sort();
}

describe("STORY-012 · breaker matrix completeness", () => {
  it("registry size equals the number of assertion modules discovered on disk", () => {
    expect(ASSERTIONS.length).toBe(idsFromAssertionModules().length);
  });

  it("every discovered assertion module id is registered exactly once, each with exactly one breaker", () => {
    const ids = ASSERTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect([...ids].sort()).toEqual(idsFromAssertionModules());
    for (const entry of ASSERTIONS) {
      expect(entry.breaker.id).toBe(entry.id);
      expect(typeof entry.breaker.apply).toBe("function");
      expect(typeof entry.breaker.revert).toBe("function");
    }
  });
});
