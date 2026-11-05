import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvValidationError, loadEnv } from "../../../config/env.js";
import { applyFakeApiEnv } from "../../../../test/support/fake-env.js";
import { rawCaptureSchema, type CaptureContext, type CaptureInput } from "../contract.js";
import { CaptureFailureError } from "../failure-taxonomy.js";
import { captureReadyEngineKeys, resolveEngine } from "../registry.js";
import { OpenRouterAdapter, type OpenRouterEngineKey } from "./openrouter-adapter.js";
import {
  assertSimulationAllowed,
  SIMULATED_DEFAULT_MODELS,
  SimulationRefusedError,
  simulationEnabled,
} from "./openrouter-simulated.js";
import { freeGemma, insufficientCredits402, rateLimited429 } from "./fixtures/openrouter-recorded.js";

// Owner decision 43 - in DEVELOPMENT ONLY the chatgpt / claude / perplexity slots are backed by free OpenRouter models. Every result is
// stored with a 'simulated' flag plus the free model's id (model_fingerprint); a hard guard refuses the mode outside development.
// No network: every test injects a fake fetch.

const FAKE_KEY = "sk-or-test-not-a-secret-0000";
const input: CaptureInput = { promptText: "best CRM for a 50-person startup", locale: "en-US", sampleIndex: 0, requireCitations: false };
const SLOTS: readonly OpenRouterEngineKey[] = ["chatgpt", "claude", "perplexity"];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function fetchReturning(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => jsonResponse(body, status));
}
function makeCtx() {
  const recordCost = vi.fn();
  const ctx: CaptureContext = { signal: new AbortController().signal, span: { setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() }, recordCost };
  return { ctx, recordCost };
}
function simulated(engine: OpenRouterEngineKey, fetchImpl: typeof fetch, nodeEnv = "development", model = "google/gemma-4-31b-it:free") {
  return new OpenRouterAdapter({ engineKey: engine, apiKey: FAKE_KEY, fetchImpl, timeoutMs: 5000, model, simulated: { nodeEnv } });
}

describe("decision 43 · the guard", () => {
  it("D43-G1 the mode is on only with the explicit flag", () => {
    expect(simulationEnabled({ NODE_ENV: "development", ENGINE_SIMULATION: "openrouter-free" })).toBe(true);
    expect(simulationEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(simulationEnabled({ NODE_ENV: "development", ENGINE_SIMULATION: "off" })).toBe(false);
  });
  it("D43-G2 production is refused whatever else is set (the guard throws, it does not return false)", () => {
    expect(() => assertSimulationAllowed({ NODE_ENV: "production", ENGINE_SIMULATION: "openrouter-free" })).toThrow(SimulationRefusedError);
    expect(() => assertSimulationAllowed({ NODE_ENV: "production" })).not.toThrow(); // not asked for: nothing to refuse
    expect(() => assertSimulationAllowed({ NODE_ENV: "development", ENGINE_SIMULATION: "openrouter-free" })).not.toThrow();
    expect(() => assertSimulationAllowed({ NODE_ENV: "test", ENGINE_SIMULATION: "openrouter-free" })).not.toThrow();
  });
  it("D43-G3 an unknown NODE_ENV fails closed", () => {
    expect(() => assertSimulationAllowed({ NODE_ENV: "staging", ENGINE_SIMULATION: "openrouter-free" })).toThrow(SimulationRefusedError);
    expect(() => assertSimulationAllowed({ ENGINE_SIMULATION: "openrouter-free" })).toThrow(SimulationRefusedError);
  });
  it("D43-G4 the adapter's own constructor refuses production and a non-free model", () => {
    expect(() => simulated("chatgpt", fetchReturning(freeGemma), "production")).toThrow(SimulationRefusedError);
    expect(() => simulated("chatgpt", fetchReturning(freeGemma), "development", "openai/gpt-5.4")).toThrow(SimulationRefusedError);
  });
  it("D50-A1 a non-sonar model in the perplexity SIMULATED slot is allowed (labelled simulated, no grounding claim); the paid path still refuses it", async () => {
    const fetchImpl = fetchReturning(freeGemma);
    const adapter = simulated("perplexity", fetchImpl, "development", "nvidia/nemotron-3.5-super-vl:free");
    const result = await adapter.capture(input, makeCtx().ctx);
    expect(result.flags).toContain("simulated");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).model).toBe("nvidia/nemotron-3.5-super-vl:free");
    expect(() => new OpenRouterAdapter({ engineKey: "perplexity", apiKey: FAKE_KEY, timeoutMs: 1000, fetchImpl, model: "nvidia/nemotron-3.5-super-vl:free" })).toThrow();
    expect(() => new OpenRouterAdapter({ engineKey: "perplexity", apiKey: FAKE_KEY, timeoutMs: 1000, fetchImpl, model: "openai/gpt-5.4" })).toThrow();
  });
  it("D50-E1 boot refuses ENGINE_SIMULATION=openrouter-free together with ENGINE_OPENROUTER=paid, naming both", () => {
    applyFakeApiEnv();
    const base = { ...process.env, NODE_ENV: "development" };
    expect(() => loadEnv({ ...base, ENGINE_SIMULATION: "openrouter-free", ENGINE_OPENROUTER: "paid" })).toThrow(/ENGINE_SIMULATION.*ENGINE_OPENROUTER|ENGINE_OPENROUTER.*ENGINE_SIMULATION/s);
    expect(() => loadEnv({ ...base, ENGINE_SIMULATION: "openrouter-free", ENGINE_OPENROUTER: "off" })).not.toThrow();
    expect(() => loadEnv({ ...base, ENGINE_SIMULATION: "off", ENGINE_OPENROUTER: "paid" })).not.toThrow();
  });
  it("D43-G5 boot refuses ENGINE_SIMULATION under NODE_ENV=production (loadEnv), and allows it in development", () => {
    applyFakeApiEnv();
    expect(() => loadEnv({ ...process.env, NODE_ENV: "production", ENGINE_SIMULATION: "openrouter-free" })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...process.env, NODE_ENV: "production", ENGINE_SIMULATION: "off" })).not.toThrow();
    expect(loadEnv({ ...process.env, NODE_ENV: "development", ENGINE_SIMULATION: "openrouter-free" }).ENGINE_SIMULATION).toBe("openrouter-free");
  });
});

describe("decision 43 · what a simulated capture stores", () => {
  it.each(SLOTS)("D43-S1 %s: flag 'simulated' plus the free model's id, under the slot's own engine key, at zero cost", async (engine) => {
    const fetchImpl = fetchReturning(freeGemma);
    const { ctx, recordCost } = makeCtx();
    const result = await simulated(engine, fetchImpl).capture(input, ctx);
    expect(rawCaptureSchema.safeParse(result).success).toBe(true);
    expect(result.flags).toContain("simulated");
    expect(result.modelFingerprint).toBe("google/gemma-4-26b-a4b-it:free"); // what OpenRouter says routed
    expect(result.costUsd).toBe(0);
    expect(recordCost).toHaveBeenCalledTimes(1);
  });
  it("D43-S2 with no model in the response the CONFIGURED free id is still recorded", async () => {
    const { model: _omit, ...withoutModel } = freeGemma;
    const result = await simulated("claude", fetchReturning(withoutModel)).capture(input, makeCtx().ctx);
    expect(result.modelFingerprint).toBe("google/gemma-4-31b-it:free");
    expect(result.flags).toContain("simulated");
  });
  it("D43-S3 the request carries no web plugin (search is paid) and the configured free model id", async () => {
    const fetchImpl = fetchReturning(freeGemma);
    await simulated("chatgpt", fetchImpl).capture(input, makeCtx().ctx);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.model).toBe("google/gemma-4-31b-it:free");
    expect(body.plugins).toBeUndefined();
  });
  it("D43-S4 a real (non-simulated) adapter never carries the flag", async () => {
    const real = new OpenRouterAdapter({ engineKey: "perplexity", apiKey: FAKE_KEY, fetchImpl: fetchReturning({ ...freeGemma, model: "perplexity/sonar" }), timeoutMs: 5000 });
    expect((await real.capture(input, makeCtx().ctx)).flags ?? []).not.toContain("simulated");
  });
  it("D43-S6 a free model that omits usage.cost is metered at 0, never at the token-priced fallback", async () => {
    const { usage: _usage, ...noUsage } = freeGemma;
    const withTokens = { ...noUsage, usage: { prompt_tokens: 100000, completion_tokens: 4000 } };
    const { ctx, recordCost } = makeCtx();
    const result = await simulated("chatgpt", fetchReturning(withTokens)).capture(input, ctx);
    expect(result.costUsd).toBe(0);
    expect(recordCost).toHaveBeenCalledWith(0);
  });
  it("D43-S5 a 402 and a 429 on the simulated path are typed failures, not untyped throws", async () => {
    const e402 = await simulated("chatgpt", fetchReturning(insufficientCredits402, 402)).capture(input, makeCtx().ctx).then(() => undefined, (e: unknown) => e);
    expect(e402).toBeInstanceOf(CaptureFailureError);
    const e429 = await simulated("chatgpt", fetchReturning(rateLimited429, 429)).capture(input, makeCtx().ctx).then(() => undefined, (e: unknown) => e);
    expect(e429).toBeInstanceOf(CaptureFailureError);
    expect((e429 as CaptureFailureError).code).toBe("rate_limited");
  });
});

describe("decision 43 · the registry", () => {
  beforeEach(() => {
    vi.stubEnv("ENGINE_OPENROUTER", "");
    vi.stubEnv("OPENROUTER_API_KEY", FAKE_KEY);
    for (const k of ["CHATGPT", "CLAUDE", "PERPLEXITY"]) {
      vi.stubEnv(`OPENROUTER_MODEL_${k}`, "");
      vi.stubEnv(`OPENROUTER_SIMULATED_MODEL_${k}`, "");
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  it("D43-R1 the default slot models are the owner's three free ids", () => {
    expect(SIMULATED_DEFAULT_MODELS).toEqual({
      chatgpt: "nvidia/nemotron-3-ultra-550b-a55b:free",
      claude: "google/gemma-4-31b-it:free",
      perplexity: "nvidia/nemotron-3.5-super-vl:free",
    });
  });
  it("D43-R2 with the flag in development, each slot is a simulated adapter, capture-ready, on its default model", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ENGINE_SIMULATION", "openrouter-free");
    for (const engine of SLOTS) {
      const fetchImpl = fetchReturning(freeGemma);
      vi.stubGlobal("fetch", fetchImpl);
      try {
        const result = await resolveEngine(engine).capture(input, makeCtx().ctx);
        expect(result.flags).toContain("simulated");
        expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).model).toBe(SIMULATED_DEFAULT_MODELS[engine]);
      } finally {
        vi.unstubAllGlobals();
      }
      expect(captureReadyEngineKeys()).toContain(engine);
    }
  });
  it("D43-R3 the slot models are configurable in .env (OPENROUTER_SIMULATED_MODEL_*)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ENGINE_SIMULATION", "openrouter-free");
    vi.stubEnv("OPENROUTER_SIMULATED_MODEL_CLAUDE", "google/gemma-4-26b-a4b-it:free");
    const fetchImpl = fetchReturning(freeGemma);
    vi.stubGlobal("fetch", fetchImpl);
    try {
      await resolveEngine("claude").capture(input, makeCtx().ctx);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).model).toBe("google/gemma-4-26b-a4b-it:free");
  });
  it("D43-R4 a configured simulated model that is not ':free' is refused, never sent", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ENGINE_SIMULATION", "openrouter-free");
    vi.stubEnv("OPENROUTER_SIMULATED_MODEL_CHATGPT", "openai/gpt-5.4");
    expect(() => resolveEngine("chatgpt")).toThrow(SimulationRefusedError);
  });
  it("D43-R5 in production the registry refuses (fail closed), it never falls back to a free model", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENGINE_SIMULATION", "openrouter-free");
    for (const engine of SLOTS) expect(() => resolveEngine(engine)).toThrow(SimulationRefusedError);
  });
  it("D43-R6 without the flag the slots are the paid adapter (not simulated) and the free probe is still unreachable", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ENGINE_SIMULATION", "");
    vi.stubEnv("ENGINE_OPENROUTER", "paid");
    expect(resolveEngine("chatgpt")).toBeInstanceOf(OpenRouterAdapter);
    expect((resolveEngine("chatgpt") as OpenRouterAdapter).isSimulated).toBe(false);
  });
  it("D43-R7 without the key the simulated mode has nothing to call: the slots stay not capture-ready", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ENGINE_SIMULATION", "openrouter-free");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    for (const engine of SLOTS) expect(captureReadyEngineKeys()).not.toContain(engine);
  });
});
