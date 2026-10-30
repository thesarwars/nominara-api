import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureReadyEngineKeys, EngineRefusalError, healthProbeEngine, resolveEngine } from "../../../src/lib/engines/registry.js";
import type { EngineKey } from "../../../src/lib/engines/contract.js";
import { BaseCaptureAdapter } from "../../../src/lib/engines/base-adapter.js";
import { FIXTURE_ADAPTERS } from "../../../src/lib/engines/fixtures/index.js";

// STORY-027 · scenario 1 — "Resolve each engine key -> The correct adapter,
// or a clear refusal for a disabled engine." D3: the registry knows all 10
// DB-canonical keys; 4 are reserved and refuse explicitly, never resolve to
// `undefined`.
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DDL_PATH = resolve(REPO_ROOT, "src/db/migrations/sql/0003_projects_prompts_captures.up.sql");

/** Parses the literal `engines.key` CHECK list out of the DDL itself, so this test can never drift from a hand-duplicated list. */
function readEngineKeysFromDdl(): string[] {
  const ddl = readFileSync(DDL_PATH, "utf8");
  const match = ddl.match(/key\s+text\s+PRIMARY KEY CHECK \(key IN\s*\(([^)]+)\)\)/);
  if (!match?.[1]) {
    throw new Error("could not locate the engines.key CHECK list in the DDL — has the migration file moved or changed shape?");
  }
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);
}

const RESERVED_KEYS: readonly EngineKey[] = ["grok", "copilot", "meta_ai", "deepseek"];

describe("NEW-A-4 · gemini is the only capture-ready engine, and only with a key", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("no key: nothing is capture-ready and gemini resolves to the fixture adapter", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("SERP_API_KEY", "");
    expect(captureReadyEngineKeys()).toEqual([]);
    expect(resolveEngine("gemini")).toBe(FIXTURE_ADAPTERS.gemini);
  });

  it("with a key: exactly gemini is capture-ready, bound to the real adapter; the other five stay fixtures", () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-not-a-secret");
    vi.stubEnv("SERP_API_KEY", "");
    expect(captureReadyEngineKeys()).toEqual(["gemini"]);
    expect(resolveEngine("gemini")).not.toBe(FIXTURE_ADAPTERS.gemini);
    expect(resolveEngine("gemini").constructor.name).toBe("GeminiApiAdapter");
    for (const key of ["google_aio", "google_ai_mode", "perplexity", "chatgpt", "claude"] as const) {
      expect(resolveEngine(key)).toBe(FIXTURE_ADAPTERS[key]);
    }
  });

  it("the real adapter does not override capture()", () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-not-a-secret");
    expect(Object.getPrototypeOf(resolveEngine("gemini")).capture).toBe(BaseCaptureAdapter.prototype.capture);
  });
});

describe("STORY-029 · the Google surfaces are capture-ready only with SERP_API_KEY, each bound to its own endpoint", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("no key: both stay fixtures and are not capture-ready", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("SERP_API_KEY", "");
    expect(captureReadyEngineKeys()).toEqual([]);
    expect(resolveEngine("google_aio")).toBe(FIXTURE_ADAPTERS.google_aio);
    expect(resolveEngine("google_ai_mode")).toBe(FIXTURE_ADAPTERS.google_ai_mode);
  });

  it("with a key: exactly the two surfaces, two distinct adapters stamped licensed_serp, engine key from their own binding", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("SERP_API_KEY", "test-key-not-a-secret");
    expect([...captureReadyEngineKeys()].sort()).toEqual(["google_ai_mode", "google_aio"]);
    const aio = resolveEngine("google_aio");
    const mode = resolveEngine("google_ai_mode");
    expect(aio).not.toBe(mode);
    expect([aio.engineKey, mode.engineKey]).toEqual(["google_aio", "google_ai_mode"]);
    expect([aio.captureMode, mode.captureMode]).toEqual(["licensed_serp", "licensed_serp"]);
    expect(Object.getPrototypeOf(aio).capture).toBe(BaseCaptureAdapter.prototype.capture);
  });

  it("a rotated key builds a new adapter; the same key reuses it", () => {
    vi.stubEnv("SERP_API_KEY", "key-one-not-a-secret");
    const first = resolveEngine("google_aio");
    expect(resolveEngine("google_aio")).toBe(first);
    vi.stubEnv("SERP_API_KEY", "key-two-not-a-secret");
    expect(resolveEngine("google_aio")).not.toBe(first);
  });
});

describe("STORY-027 · scenario 1 · the registry resolves each engine key or refuses it clearly", () => {
  const ddlKeys = readEngineKeysFromDdl();

  it("the DDL itself lists exactly the 10 keys this registry is built against (sanity on the parser)", () => {
    expect(ddlKeys).toHaveLength(10);
  });

  it.each(ddlKeys)("%s — the 6 active keys resolve to an adapter whose engineKey equals the key looked up; the 4 reserved keys refuse", (key) => {
    const engineKey = key as EngineKey;
    if (RESERVED_KEYS.includes(engineKey)) {
      expect(() => resolveEngine(engineKey)).toThrow(EngineRefusalError);
      try {
        resolveEngine(engineKey);
        expect.unreachable("expected resolveEngine to throw for a reserved key");
      } catch (error) {
        expect(error).toBeInstanceOf(EngineRefusalError);
        expect((error as EngineRefusalError).reason).toBe("disabled");
        expect((error as EngineRefusalError).engineKey).toBe(engineKey);
      }
    } else {
      const adapter = resolveEngine(engineKey);
      // The adapter never infers its own key — it must equal the one looked up.
      expect(adapter.engineKey).toBe(engineKey);
    }
  });

  it("an unknown key throws a distinguishable 'unknown engine' refusal, never resolves to undefined", () => {
    expect(() => resolveEngine("bard")).toThrow(EngineRefusalError);
    try {
      resolveEngine("bard");
      expect.unreachable("expected resolveEngine to throw for an unknown key");
    } catch (error) {
      expect(error).toBeInstanceOf(EngineRefusalError);
      expect((error as EngineRefusalError).reason).toBe("unknown");
    }
  });

  it("the unknown-key refusal is distinguishable from the disabled-engine refusal", () => {
    let unknownReason: string | undefined;
    let disabledReason: string | undefined;
    try {
      resolveEngine("bard");
    } catch (error) {
      unknownReason = (error as EngineRefusalError).reason;
    }
    try {
      resolveEngine("grok");
    } catch (error) {
      disabledReason = (error as EngineRefusalError).reason;
    }
    expect(unknownReason).not.toBe(disabledReason);
  });

  it("healthProbe is exposed per adapter and returns {ok,latencyMs,detail?} for all 6 active engines", async () => {
    const activeKeys = ddlKeys.filter((key) => !RESERVED_KEYS.includes(key as EngineKey)) as EngineKey[];
    expect(activeKeys).toHaveLength(6);
    for (const key of activeKeys) {
      const health = await healthProbeEngine(key);
      expect(typeof health.ok).toBe("boolean");
      expect(typeof health.latencyMs).toBe("number");
    }
  });

  // TypeScript has no `final` keyword — nothing stops a future adapter
  // subclass from overriding capture() and bypassing the validate-before-
  // return path that is R-06's sole guard. This is the structural check
  // that fails CI the day that happens, rather than relying on a reviewer
  // noticing (code-review finding on this story).
  it("no registered adapter overrides capture() — the validate-before-return path can't be silently bypassed", () => {
    for (const [engineKey, adapter] of Object.entries(FIXTURE_ADAPTERS)) {
      expect(Object.getPrototypeOf(adapter).capture, engineKey).toBe(BaseCaptureAdapter.prototype.capture);
    }
  });
});
