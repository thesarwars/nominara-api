import { incrementCounter } from "../../telemetry/metrics.js";
import { BaseCaptureAdapter } from "../base-adapter.js";
import type { CaptureContext, CaptureInput, CaptureMode, EngineKey } from "../contract.js";
import { CaptureFailureError } from "../failure-taxonomy.js";
import { assertSimulatedModel, assertSimulationAllowed, ENGINE_SIMULATION_MODE, SIMULATED_DEFAULT_MODELS } from "./openrouter-simulated.js";
import {
  billedCostOfUnusableBody,
  normaliseChat,
  OPENROUTER_KEY_URL,
  OPENROUTER_MAX_TOKENS,
  OpenRouterCallError,
  parseChat,
  postChat,
  type OpenRouterRequest,
} from "./openrouter-chat.js";

// STORY-028 / owner decision 42 - ONE adapter class, bound three times (chatgpt, claude, perplexity), reaching each vendor through a
// single OpenRouter key. Native fetch, no SDK, single turn, grounding enforced BEFORE dispatch, hard per-capture timeout, the routed
// model recorded as modelFingerprint, cost from OpenRouter's own `usage.cost` through ctx.recordCost exactly once.
//
// Whether production goes direct to each vendor is decided per engine later, where citation accuracy matters (decision 42); this
// adapter is stamped with the engine key it serves, never inferred from a payload.
//
// A FREE MODEL NEVER SERVES A TRACKED ENGINE IN REAL USE. A ':free' model id is refused at construction (FreeModelPathError) UNLESS the
// adapter is built as a development-only simulated slot (owner decision 43, `simulated`, see openrouter-simulated.ts), which is
// guarded against production and flags every result. The plain free models otherwise exist only behind the dev-only free probe (a
// sibling file), which is not a CaptureAdapter and cannot be resolved as an engine.

export type OpenRouterEngineKey = "chatgpt" | "claude" | "perplexity";
export const OPENROUTER_ENGINE_KEYS: readonly OpenRouterEngineKey[] = ["chatgpt", "claude", "perplexity"];

/**
 * Model ids from GET /api/v1/models (2026-10-30). PLACEHOLDERS pending the owner's fidelity decision: model tier is a fidelity decision
 * (tracking-engine.md section 3), so a change here is a methodology event. Override per engine with OPENROUTER_MODEL_<ENGINE>.
 * Cost observed live, one capture each, web search included: gpt-5.4 ~$0.07, claude-sonnet-5.5 ~$0.11 (44k prompt tokens of search
 * context), perplexity/sonar ~$0.006. Mind the 5 USD placeholder ceilings.
 */
export const OPENROUTER_DEFAULT_MODELS: Readonly<Record<OpenRouterEngineKey, string>> = {
  chatgpt: "openai/gpt-5.4",
  claude: "anthropic/claude-sonnet-5.5",
  perplexity: "perplexity/sonar",
};

/** Thrown when a free model is pointed at a tracked engine, or the free probe is pointed at anything else. */
export class FreeModelPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreeModelPathError";
  }
}

/** Thrown BEFORE dispatch when a request would run without search grounding: an ungrounded answer measures the wrong thing. */
export class UngroundedRequestError extends Error {
  constructor(engineKey: string) {
    super(`openrouter request for '${engineKey}' refused before dispatch: web search grounding is not enabled`);
    this.name = "UngroundedRequestError";
  }
}

export function isFreeModel(model: string): boolean {
  return model.endsWith(":free");
}

export function buildOpenRouterRequest(engineKey: OpenRouterEngineKey, model: string, input: CaptureInput): OpenRouterRequest {
  const base = { model, messages: [{ role: "user", content: input.promptText }] as const, max_tokens: OPENROUTER_MAX_TOKENS, usage: { include: true } as const };
  // sonar is search-native and answers 404 to the plugin ("does not support native web search"); the others need it asked for.
  if (engineKey === "perplexity") return base;
  return { ...base, plugins: [{ id: "web", engine: "native", max_results: 5 }] };
}

/** chatgpt/claude: the web plugin on the NATIVE engine (an Exa-backed search is a different measurement). perplexity: a search-native sonar model. */
export function assertGrounded(engineKey: OpenRouterEngineKey, request: OpenRouterRequest): void {
  if (engineKey === "perplexity") {
    if (!request.model.startsWith("perplexity/sonar")) throw new UngroundedRequestError(engineKey);
    return;
  }
  const grounded = (request.plugins ?? []).some((plugin) => plugin.id === "web" && plugin.engine === "native");
  if (!grounded) throw new UngroundedRequestError(engineKey);
}

export interface OpenRouterAdapterConfig {
  readonly engineKey: OpenRouterEngineKey;
  readonly apiKey: string;
  /** Injected so unit tests never touch the network. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Hard per-capture timeout; an elapsed timeout is classified `timeout`. */
  readonly timeoutMs: number;
  readonly model?: string;
  /**
   * Owner decision 43 - DEVELOPMENT ONLY. Backs this slot with a ':free' model: no web plugin, every result flagged `simulated` and
   * stamped with the free model's id. `nodeEnv` is the process's NODE_ENV; production is refused here as well as at boot and in the registry.
   */
  readonly simulated?: { readonly nodeEnv: string | undefined };
}

export class OpenRouterAdapter extends BaseCaptureAdapter {
  readonly engineKey: EngineKey;
  readonly captureMode: CaptureMode = "api";
  readonly adapterVersion = "0.1.0";
  readonly supportsCitations = true;
  readonly concurrencyPerTask = 2;
  private readonly openRouterEngine: OpenRouterEngineKey;
  private readonly modelId: string;
  /** Owner decision 43: true only for a development free-model slot. */
  readonly isSimulated: boolean;

  constructor(protected readonly config: OpenRouterAdapterConfig) {
    super();
    if (!OPENROUTER_ENGINE_KEYS.includes(config.engineKey)) {
      throw new Error(`OpenRouterAdapter serves chatgpt, claude and perplexity only, not '${String(config.engineKey)}'`);
    }
    this.openRouterEngine = config.engineKey;
    this.engineKey = config.engineKey;
    this.isSimulated = config.simulated !== undefined;
    this.modelId = config.model ?? (config.simulated !== undefined ? SIMULATED_DEFAULT_MODELS : OPENROUTER_DEFAULT_MODELS)[config.engineKey];
    if (config.simulated !== undefined) {
      assertSimulatedModel(this.modelId);
      // The mode is implied by constructing a simulated adapter, so ask the guard as if the flag were set.
      assertSimulationAllowed({ NODE_ENV: config.simulated.nodeEnv, ENGINE_SIMULATION: ENGINE_SIMULATION_MODE });
    } else {
      if (isFreeModel(this.modelId)) throw new FreeModelPathError(`a free model cannot serve the tracked engine '${config.engineKey}'`);
      // Grounding is a property of the binding (engine + model), so a misconfigured model fails HERE, typed, not on every cell.
      assertGrounded(config.engineKey, buildOpenRouterRequest(config.engineKey, this.modelId, { promptText: "", locale: "en-US", sampleIndex: 0, requireCitations: true }));
    }
  }

  private get fetchFn(): typeof fetch {
    return this.config.fetchImpl ?? fetch;
  }

  private failure(error: OpenRouterCallError): CaptureFailureError {
    incrementCounter("nominara_openrouter_failures_total", { engine_key: this.engineKey, code: error.code });
    return new CaptureFailureError(error.code, this.engineKey, undefined, error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs });
  }

  protected async fetchVendorResponse(input: CaptureInput, ctx: CaptureContext): Promise<unknown> {
    // A simulated slot sends no search plugin (search is paid even on a free model), so grounding is not asserted for it.
    const request: OpenRouterRequest = this.isSimulated
      ? { model: this.modelId, messages: [{ role: "user", content: input.promptText }], max_tokens: OPENROUTER_MAX_TOKENS, usage: { include: true } }
      : buildOpenRouterRequest(this.openRouterEngine, this.modelId, input);
    if (!this.isSimulated) assertGrounded(this.openRouterEngine, request);

    const startedAt = performance.now();
    let body: unknown;
    try {
      body = await postChat({ fetchFn: this.fetchFn, apiKey: this.config.apiKey, request, timeoutMs: this.config.timeoutMs, signal: ctx.signal });
    } catch (error) {
      if (error instanceof OpenRouterCallError) throw this.failure(error);
      throw error;
    }
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));

    const parsed = parseChat(body);
    if (!parsed.ok) {
      incrementCounter("nominara_capture_malformed_response_total", { engine_key: this.engineKey, adapter_version: this.adapterVersion });
      const billed = billedCostOfUnusableBody(body);
      if (billed !== null) await ctx.recordCost(billed);
      const malformed = new CaptureFailureError("malformed_response", this.engineKey);
      ctx.span.recordException(malformed);
      throw malformed;
    }

    const chat = normaliseChat(parsed.data, this.isSimulated || isFreeModel(this.modelId));
    ctx.span.setAttribute("engine.key", this.engineKey);
    ctx.span.setAttribute("engine.latency_ms", latencyMs);
    if (this.isSimulated) ctx.span.setAttribute("engine.simulated", true);
    incrementCounter("nominara_openrouter_requests_total", { engine_key: this.engineKey, outcome: "ok" });

    return {
      text: chat.text,
      format: "markdown",
      structuredCitations: chat.citations,
      // A simulated result ALWAYS names the free model, even when the response omits it.
      ...(chat.model !== undefined ? { modelFingerprint: chat.model } : this.isSimulated ? { modelFingerprint: this.modelId } : {}),
      truncated: chat.truncated,
      responseTokensEst: chat.completionTokens ?? Math.ceil(chat.text.length / 4),
      latencyMs,
      ...(chat.vendorRequestId !== undefined ? { vendorRequestId: chat.vendorRequestId } : {}),
      costUsd: chat.costUsd,
      ...(chat.flags.length > 0 || this.isSimulated ? { flags: this.isSimulated ? [...chat.flags, "simulated"] : chat.flags } : {}),
    };
  }

  /** A free key-metadata GET: proves the credential and reachability without spending a generation, and reports an exhausted key limit. */
  async healthProbe(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const startedAt = performance.now();
    const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
    try {
      const response = await this.fetchFn(OPENROUTER_KEY_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!response.ok) {
        return { ok: false, latencyMs: elapsed(), detail: `HTTP ${String(response.status)}` };
      }
      const body = (await response.json().catch(() => undefined)) as { data?: { limit_remaining?: unknown } } | undefined;
      const remaining = body?.data?.limit_remaining;
      if (typeof remaining === "number" && remaining <= 0) {
        return { ok: false, latencyMs: elapsed(), detail: "key spend limit exhausted" };
      }
      return { ok: true, latencyMs: elapsed() };
    } catch (error) {
      const name = error instanceof Error ? error.name : "error";
      return { ok: false, latencyMs: elapsed(), detail: `network failure (${name})` };
    }
  }
}
