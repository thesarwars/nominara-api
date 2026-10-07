import { describe, expect, it } from "vitest";
import { parseSeedDemoArgs, SeedDemoUsageError } from "../../src/db/seed-demo.js";

// NEW-A-8 — the engine filter and facts-only flags of `pnpm db:seed-demo`.
describe("NEW-A-8 · parseSeedDemoArgs", () => {
  const WS = "0190a000-0000-7000-8000-000000000001";
  const PROJECT = "0190a000-0000-7000-8000-000000000002";

  it("NEW-A-8 #1 · parses --exclude-engines (comma list), --facts-only and --project", () => {
    const args = parseSeedDemoArgs([
      "--workspace", WS, "--project", PROJECT, "--exclude-engines", "gemini, perplexity", "--facts-only",
    ]);
    expect(args.workspaceId).toBe(WS);
    expect(args.projectId).toBe(PROJECT);
    expect(args.excludeEngines).toEqual(["gemini", "perplexity"]);
    expect(args.factsOnly).toBe(true);
    expect(args.purge).toBe(false);
  });

  it("NEW-A-8 #2 · the defaults are the unchanged STORY-169 behaviour: nothing excluded, not facts-only", () => {
    const args = parseSeedDemoArgs(["--workspace", WS]);
    expect(args.excludeEngines ?? []).toEqual([]);
    expect(args.factsOnly ?? false).toBe(false);
    expect(args.projectId).toBeUndefined();
  });

  it("NEW-A-8 #3 · a missing or empty value is a usage error, never a silent no-op filter", () => {
    expect(() => parseSeedDemoArgs(["--exclude-engines"])).toThrow(SeedDemoUsageError);
    expect(() => parseSeedDemoArgs(["--exclude-engines", "--facts-only"])).toThrow(SeedDemoUsageError);
    expect(() => parseSeedDemoArgs(["--exclude-engines", " , "])).toThrow(SeedDemoUsageError);
    expect(() => parseSeedDemoArgs(["--project"])).toThrow(SeedDemoUsageError);
  });

  it("NEW-A-8 #4 · --purge cannot be combined with --facts-only or --exclude-engines (a purge always removes every demo-marked row)", () => {
    expect(() => parseSeedDemoArgs(["--purge", "--facts-only"])).toThrow(SeedDemoUsageError);
    expect(() => parseSeedDemoArgs(["--purge", "--exclude-engines", "gemini"])).toThrow(SeedDemoUsageError);
  });

  it("NEW-A-8 #5 · an unknown argument is still refused", () => {
    expect(() => parseSeedDemoArgs(["--facts-onl"])).toThrow(SeedDemoUsageError);
  });
});
