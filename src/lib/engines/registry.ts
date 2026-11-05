import type { CaptureAdapter, EngineKey } from "./contract.js";
import { engineKeySchema } from "./contract.js";
import { FIXTURE_ADAPTERS } from "./fixtures/index.js";
import { GeminiApiAdapter } from "./gemini/gemini-api-adapter.js";
import { isFreeModel, OPENROUTER_DEFAULT_MODELS, OPENROUTER_ENGINE_KEYS, OpenRouterAdapter, type OpenRouterEngineKey, UngroundedRequestError } from "./openrouter/openrouter-adapter.js";
import { assertSimulatedModel, assertSimulationAllowed, SIMULATED_DEFAULT_MODELS, simulationEnabled } from "./openrouter/openrouter-simulated.js";
import { LicensedSerpAdapter, SERP_CAPTURE_TIMEOUT_MS, type LicensedSurface } from "./serp/licensed-serp.js";
import { SerpApiProvider } from "./serp/serpapi-provider.js";

// STORY-027 — mirrors src/lib/auth/oauth-providers.ts's static-map shape and
// src/modules/identity/ports/oauth-client.ts's interface-only port shape. No
// DI container, no Nest provider: a plain static Record the rest of the
// system reads through resolveEngine()/healthProbeEngine().
//
// D3 (Implementation decisions) — the registry knows all 10 DB-canonical
// `engines.key` values (0003_projects_prompts_captures.up.sql). Adapters
// exist for the 6 active engines only; the 4 reserved keys resolve to an
// explicit, typed refusal — never `undefined`.
export type EngineRefusalReason = "disabled" | "unknown";

export class EngineRefusalError extends Error {
  readonly engineKey: string;
  readonly reason: EngineRefusalReason;

  constructor(engineKey: string, reason: EngineRefusalReason) {
    super(
      reason === "disabled"
        ? `engine '${engineKey}' is disabled — no adapter is enabled for it (tracking-engine.md §3)`
        : `unknown engine key '${engineKey}'`,
    );
    this.name = "EngineRefusalError";
    this.engineKey = engineKey;
    this.reason = reason;
  }
}

type EngineRegistration =
  | { readonly status: "active"; readonly adapter: CaptureAdapter; readonly captureReady: boolean }
  | { readonly status: "disabled" };

// Wired to the fixture adapters (STORY-027 T14) — every active key's
// adapter is stamped with its own engineKey (never inferred from a
// payload), read straight off FIXTURE_ADAPTERS.
//
// ⚠ `captureReady: false` ON ALL SIX, AND IT IS NOT DECORATION. STORY-152.
//
// A fixture adapter matches `input.promptText` against six hard-coded strings
// by EXACT equality and throws otherwise. Every prompt a real project
// generates misses. So the moment STORY-152 seeded the catalog and the
// scheduler began resolving engines, a fixture-backed engine would have been
// planned, attempted, and thrown on — unwinding the transaction so that no
// capture row of any status survived, burning all five retry attempts, and
// landing every cell in the dead-letter queue behind a `healthProbe()` that
// returns ok unconditionally.
//
// The alternative considered was a new `adapter_unsupported` failure code, so
// the attempt would at least be RECORDED. It was rejected on two counts. It
// needs a ninth entry in tracking-engine.md §2's taxonomy, which says in terms
// "Fixed, because the circuit breaker and retry ladder branch on it" and which
// `failure-taxonomy.spec.ts` pins at length 8. And it would have been a lie to
// the customer anyway: the matrix renders a failed cell as "We asked and no
// answer came back", and we would not have asked anyone — there is no vendor
// adapter in this repository and there cannot be until STORY-001 opens the
// accounts.
//
// So the honest state is that these engines are entitled but not capturable,
// and the place to say so is BEFORE a cell is planned. `plan-cells.ts` reads
// this flag; nothing is attempted, so nothing fails.
//
// Each engine's own adapter story flips its flag to `true` in the same commit
// that binds a real adapter. The flag is not `adapter !== FIXTURE_ADAPTERS[k]`
// because a declared fact survives a refactor that an `instanceof` does not.
const REGISTRY: Record<EngineKey, EngineRegistration> = {
  google_aio: { status: "active", adapter: FIXTURE_ADAPTERS.google_aio, captureReady: false },
  google_ai_mode: { status: "active", adapter: FIXTURE_ADAPTERS.google_ai_mode, captureReady: false },
  perplexity: { status: "active", adapter: FIXTURE_ADAPTERS.perplexity, captureReady: false },
  chatgpt: { status: "active", adapter: FIXTURE_ADAPTERS.chatgpt, captureReady: false },
  // STORY-029: google_aio and google_ai_mode are real when SERP_API_KEY is set (registrationFor), like gemini with its key.
  // NEW-A-4: gemini is the first real adapter. Its binding is resolved per call (see geminiBinding)
  // because it exists only when GEMINI_API_KEY does; this static entry is the keyless fallback.
  gemini: { status: "active", adapter: FIXTURE_ADAPTERS.gemini, captureReady: false },
  claude: { status: "active", adapter: FIXTURE_ADAPTERS.claude, captureReady: false },
  grok: { status: "disabled" },
  copilot: { status: "disabled" },
  meta_ai: { status: "disabled" },
  deepseek: { status: "disabled" },
};

// NEW-A-4 — hard per-capture timeout for the real Gemini adapter (p95 profile is ~11 s).
const GEMINI_CAPTURE_TIMEOUT_MS = 30_000;
let geminiAdapterCache: { readonly key: string; readonly adapter: GeminiApiAdapter } | undefined;

// STORY-029 - the licensed-SERP capture timeout is SERP_CAPTURE_TIMEOUT_MS (licensed-serp.ts): the 5-minute queued wait of tracking-engine.md section 3 plus follow-up headroom (owner decision 29, 2026-10-30).
const serpAdapterCache = new Map<LicensedSurface, { readonly key: string; readonly adapter: LicensedSerpAdapter }>();

/** The licensed-SERP adapter for a surface when SERP_API_KEY is configured. THE PROVIDER IS CHOSEN HERE: a fallback vendor is a different provider on this line (docs/licensed-serp-fallback.md). */
function serpAdapterFor(surface: LicensedSurface, key: string): LicensedSerpAdapter {
  const cached = serpAdapterCache.get(surface);
  if (cached?.key === key) return cached.adapter;
  const adapter = new LicensedSerpAdapter(surface, { provider: new SerpApiProvider({ apiKey: key }), timeoutMs: SERP_CAPTURE_TIMEOUT_MS });
  serpAdapterCache.set(surface, { key, adapter });
  return adapter;
}

// STORY-028 / owner decision 42 - chatgpt, claude and perplexity are real through ONE OpenRouter key. Hard per-capture timeout: the slowest
// profile is claude at p95 16 s (tracking-engine.md section 3); OpenRouter's native search adds routing, and a reasoning model can think
// for a while, so 60 s.
const OPENROUTER_CAPTURE_TIMEOUT_MS = 60_000;
const openRouterAdapterCache = new Map<OpenRouterEngineKey, { readonly cacheKey: string; readonly adapter: OpenRouterAdapter }>();

/**
 * The OpenRouter adapter for a tracked engine, or undefined when the paid path is not opted into (ENGINE_OPENROUTER=paid), or its configured model is a ':free' one, or cannot ground the engine. A free model NEVER serves a
 * tracked engine: the engine is then left fixture-backed and not capture-ready, rather than silently measuring with a free model.
 */
function openRouterAdapterFor(engineKey: OpenRouterEngineKey, apiKey: string): OpenRouterAdapter | undefined {
  // Owner decision 43 - DEVELOPMENT ONLY free-model slots. Checked FIRST and fail closed: with the flag set outside development this
  // throws (it never falls through to the paid path or to a free model), and a non-free model id is refused, not sent.
  if (simulationEnabled(process.env)) {
    assertSimulationAllowed(process.env);
    const configured = process.env[`OPENROUTER_SIMULATED_MODEL_${engineKey.toUpperCase()}`]?.trim();
    const simModel = configured !== undefined && configured.length > 0 ? configured : SIMULATED_DEFAULT_MODELS[engineKey];
    assertSimulatedModel(simModel);
    const simKey = `sim|${apiKey}|${simModel}`;
    const hit = openRouterAdapterCache.get(engineKey);
    if (hit?.cacheKey === simKey) return hit.adapter;
    const simulated = new OpenRouterAdapter({ engineKey, apiKey, model: simModel, timeoutMs: OPENROUTER_CAPTURE_TIMEOUT_MS, simulated: { nodeEnv: process.env.NODE_ENV } });
    openRouterAdapterCache.set(engineKey, { cacheKey: simKey, adapter: simulated });
    return simulated;
  }
  // Decision 44 - the PAID path is an explicit opt-in (ENGINE_OPENROUTER=paid), exactly as EMBEDDING_PROVIDER is: the key alone (it is also
  // the free dev-embedding key) never starts spending credit or switches a tracked engine to a placeholder model.
  if (process.env.ENGINE_OPENROUTER !== "paid") return undefined;
  const override = process.env[`OPENROUTER_MODEL_${engineKey.toUpperCase()}`]?.trim();
  const model = override !== undefined && override.length > 0 ? override : OPENROUTER_DEFAULT_MODELS[engineKey];
  if (isFreeModel(model)) return undefined;
  const cacheKey = `${apiKey}|${model}`;
  const cached = openRouterAdapterCache.get(engineKey);
  if (cached?.cacheKey === cacheKey) return cached.adapter;
  let adapter: OpenRouterAdapter;
  try {
    adapter = new OpenRouterAdapter({ engineKey, apiKey, model, timeoutMs: OPENROUTER_CAPTURE_TIMEOUT_MS });
  } catch (error) {
    // A model that cannot ground the engine (e.g. a non-sonar perplexity) is a configuration defect: leave the engine unbound.
    if (error instanceof UngroundedRequestError) return undefined;
    throw error;
  }
  openRouterAdapterCache.set(engineKey, { cacheKey, adapter });
  return adapter;
}

/** The real registration when a key is configured; otherwise the honest keyless fallback. */
function registrationFor(engineKey: EngineKey): EngineRegistration {
  if (engineKey === "google_aio" || engineKey === "google_ai_mode") {
    const key = process.env.SERP_API_KEY;
    if (key !== undefined && key.trim().length > 0) {
      return { status: "active", adapter: serpAdapterFor(engineKey, key), captureReady: true };
    }
  }
  if (engineKey === "gemini") {
    const key = process.env.GEMINI_API_KEY;
    if (key !== undefined && key.trim().length > 0) {
      if (geminiAdapterCache?.key !== key) {
        geminiAdapterCache = { key, adapter: new GeminiApiAdapter({ apiKey: key, timeoutMs: GEMINI_CAPTURE_TIMEOUT_MS }) };
      }
      return { status: "active", adapter: geminiAdapterCache.adapter, captureReady: true };
    }
  }
  if ((OPENROUTER_ENGINE_KEYS as readonly string[]).includes(engineKey)) {
    const key = process.env.OPENROUTER_API_KEY;
    if (key !== undefined && key.trim().length > 0) {
      const adapter = openRouterAdapterFor(engineKey as OpenRouterEngineKey, key);
      if (adapter !== undefined) return { status: "active", adapter, captureReady: true };
    }
  }
  return REGISTRY[engineKey];
}

// STORY-031 — derived from REGISTRY (never hand-duplicated) so the canary
// (canary.ts) and anything else needing "every dispatching engine" can
// never drift from this file's own active/disabled classification.
export const ACTIVE_ENGINE_KEYS: readonly EngineKey[] = (Object.keys(REGISTRY) as EngineKey[]).filter(
  (key) => REGISTRY[key].status === "active",
);

export function resolveEngine(engineKey: string): CaptureAdapter {
  const parsed = engineKeySchema.safeParse(engineKey);
  if (!parsed.success) {
    throw new EngineRefusalError(engineKey, "unknown");
  }
  const registration = registrationFor(parsed.data);
  if (registration.status === "disabled") {
    throw new EngineRefusalError(parsed.data, "disabled");
  }
  return registration.adapter;
}

export async function healthProbeEngine(engineKey: string): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  return resolveEngine(engineKey).healthProbe();
}

/**
 * The engine keys a capture may actually be attempted on.
 *
 * ⚠ EMPTY WITHOUT A KEY, DELIBERATELY. Gemini (NEW-A-4, GEMINI_API_KEY) and the two Google surfaces (STORY-029, SERP_API_KEY) have
 * real adapters, each only when its key is set. The rest are fixture-backed; none can answer a real prompt. Planning a
 * cell for one would manufacture a failure out of a thing we never tried.
 *
 * Derived from REGISTRY rather than listed, so an adapter story cannot bind a
 * real adapter and forget to make it reachable, or the reverse.
 */
export function captureReadyEngineKeys(): readonly EngineKey[] {
  return (Object.keys(REGISTRY) as EngineKey[]).filter((key) => {
    const entry = registrationFor(key);
    return entry.status === "active" && entry.captureReady;
  });
}
