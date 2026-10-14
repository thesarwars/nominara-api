import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as conventions from "../../src/db/conventions.js";
import * as maintenance from "../../src/workers/rollup/maintenance.js";
import { parseCatchUpArgs } from "../../src/workers/rollup/catch-up-default-partition.js";

const ROOT = join(import.meta.dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("STORY-142 · catchUpDefaultPartition is an operator-only ops script", () => {
  it("STORY-142 AC9 · --table names exactly one partitioned fact table", () => {
    expect(parseCatchUpArgs(["--table", "answer_captures"])).toEqual(["answer_captures"]);
  });

  it("STORY-142 AC9 · --all names every partitioned fact table", () => {
    expect(parseCatchUpArgs(["--all"])).toEqual([...conventions.PARTITIONED_FACT_TABLES]);
  });

  it("STORY-142 AC9 · no argument is a usage error, never an implicit run over every table", () => {
    expect(() => parseCatchUpArgs([])).toThrow(/usage/i);
  });

  it("STORY-142 AC9 · an unknown table is refused (it is interpolated into DDL)", () => {
    expect(() => parseCatchUpArgs(["--table", "users; drop table users"])).toThrow(/unknown table/i);
  });

  it("STORY-142 AC9 · --table together with --all is refused as ambiguous", () => {
    expect(() => parseCatchUpArgs(["--all", "--table", "answer_captures"])).toThrow(/usage/i);
  });

  it("STORY-142 AC9 · a pnpm script exposes it", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["db:maintenance:catch-up"]).toBe("tsx src/workers/rollup/catch-up-default-partition.ts");
  });

  it("STORY-142 AC9 · nothing under src/lib/queue (handlers, schedule) calls it", () => {
    const offenders = sourceFiles(join(ROOT, "src", "lib", "queue")).filter((file) =>
      /catchUpDefaultPartition\s*\(|catch-up-default-partition/.test(readFileSync(file, "utf8").replace(/\/\/.*$/gm, "")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("STORY-142 · the cold-tier step is removed (cold_tier is not provisioned)", () => {
  it("STORY-142 AC10 · maintenance exports no cold-tier move", () => {
    expect(Object.keys(maintenance)).not.toContain("moveColdPartitions");
  });

  it("STORY-142 AC10 · conventions carries no cold tablespace constant", () => {
    expect(Object.keys(conventions)).not.toContain("COLD_TABLESPACE");
  });

  it("STORY-142 AC10 · the monthly orchestration no longer references a cold tier", () => {
    const source = readFileSync(join(ROOT, "src", "workers", "rollup", "maintenance.ts"), "utf8");
    expect(source).not.toMatch(/coldTier|SET TABLESPACE/);
  });
});
