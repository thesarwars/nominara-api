import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureContext, CaptureInput } from "../../../src/lib/engines/contract.js";
import { FIXTURE_CASES, type FixtureCase } from "../../../src/lib/engines/fixtures/fixture-cases.js";
import { healthProbeEngine, resolveEngine } from "../../../src/lib/engines/registry.js";

// STORY-027 · scenario 7 — "Run the whole capture path on fixtures ->
// Succeeds with no network egress." The 4 success-shaped cases resolve
// schema-valid; refusal/empty resolve flagged, never throw — the whole
// point of NFR-SIM-07 is that neither ever reaches an error path.
const ACTIVE_ENGINE_KEYS = ["google_aio", "google_ai_mode", "perplexity", "chatgpt", "gemini", "claude"] as const;

function makeInput(fixtureCase: FixtureCase): CaptureInput {
  return {
    promptText: fixtureCase,
    locale: "en-US",
    sampleIndex: 0,
    requireCitations: false,
  };
}

function makeContext(recordCost = vi.fn()): CaptureContext {
  return {
    signal: new AbortController().signal,
    span: { setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() },
    recordCost,
  };
}

describe("STORY-027 · scenario 7 · the whole capture path runs on fixtures with no network egress", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn(() => {
      throw new Error("network egress attempted during a fixture-only capture path");
    });
    // @ts-expect-error — test-only override of the global fetch for the suite duration.
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("runs registry.resolve(key).capture(input, ctx) end to end for all 6 engines x 6 cases with zero fetch calls, recordCost called exactly once per capture", async () => {
    for (const engineKey of ACTIVE_ENGINE_KEYS) {
      const adapter = resolveEngine(engineKey);
      for (const fixtureCase of FIXTURE_CASES) {
        const recordCost = vi.fn();
        const result = await adapter.capture(makeInput(fixtureCase), makeContext(recordCost));
        expect(result, `${engineKey}/${fixtureCase}`).toBeDefined();
        expect(recordCost, `${engineKey}/${fixtureCase}`).toHaveBeenCalledTimes(1);
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("healthProbe() returns ok:true for all 6 active engines, with no network", async () => {
    for (const engineKey of ACTIVE_ENGINE_KEYS) {
      const health = await healthProbeEngine(engineKey);
      expect(health.ok, engineKey).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Static half of the egress guard — the existing eslint rule
// (no-request-handler-network-call) does NOT cover src/lib/engines/**, so
// this file-scan is the only guard for this directory. Style follows
// test/unit/contracts-drift-check.spec.ts's source-reading approach.
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const ENGINES_DIR = join(REPO_ROOT, "src/lib/engines");
const BANNED_IMPORT_PATTERN = /from\s+["'](node:http|node:https|undici|axios|got)["']|require\(\s*["'](node:http|node:https|undici|axios|got)["']\s*\)/;
const BANNED_FETCH_CALL_PATTERN = /(?<![.\w])fetch\s*\(/;

function listFilesRecursively(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...listFilesRecursively(fullPath));
    } else if (extname(entry) === ".ts") {
      files.push(fullPath);
    }
  }
  return files;
}

describe("STORY-027 · scenario 7 · static egress guard over src/lib/engines/**", () => {
  it("no file under src/lib/engines/** imports a banned network module or calls bare fetch(", () => {
    const files = listFilesRecursively(ENGINES_DIR);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (BANNED_IMPORT_PATTERN.test(content) || BANNED_FETCH_CALL_PATTERN.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});
