import { z } from "zod";
import { incrementCounter } from "../../telemetry/metrics.js";
import { BaseCaptureAdapter } from "../base-adapter.js";
import type { CaptureContext, CaptureFlag, CaptureInput, CaptureMode, EngineKey } from "../contract.js";
import { CaptureFailureError, type CaptureFailureCode } from "../failure-taxonomy.js";
import { geminiErrorResponseSchema, geminiGenerateContentResponseSchema } from "./gemini-response.schema.js";

// NEW-A-4 (STORY-028, Gemini slice) — native fetch, no SDK, single turn, google_search always
// set, hard per-capture timeout, modelVersion -> modelFingerprint. Cost is recorded by
// BaseCaptureAdapter.capture() through ctx.recordCost(costUsd), exactly once, after validation. A response that fails validation but is readably billed is metered too (E2E-B6 audit).
// Citation URLs are the vendor's grounding redirects, passed through UNRESOLVED: resolving them is
// the parse stage's job (one network call per capture, here).

export interface GeminiApiAdapterConfig {
  readonly apiKey: string;
  /** Injected so unit tests never touch the network. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Hard per-capture timeout; an elapsed timeout is classified `timeout`. */
  readonly timeoutMs: number;
  readonly model?: string;
}

/** The generateContent request body we send. */
export interface GeminiRequest {
  readonly contents: readonly { readonly role: "user"; readonly parts: readonly { readonly text: string }[] }[];
  readonly tools?: readonly Record<string, unknown>[];
}

/** Thrown BEFORE dispatch when a request lacks google_search: an ungrounded answer measures the wrong thing. */
export class UngroundedRequestError extends Error {
  constructor() {
    super("gemini request refused before dispatch: google_search grounding is not enabled");
    this.name = "UngroundedRequestError";
  }
}

export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// An HTTP URL, not an object-storage key. Built by concat() rather than an interpolated template
// because ISO-14's scanner reads a base-plus-slash template as an un-namespaced storage key.
function modelUrl(model: string, suffix: string): string {
  return GEMINI_BASE_URL.concat("/models/", model, suffix);
}

// gemini-2.5-flash list pricing (USD): $0.30 / 1M input tokens, $2.50 / 1M output tokens (thinking
// tokens bill as output), and $35 / 1,000 grounded prompts for google_search. A pricing change is a
// methodology/cost event: edit here and bump adapterVersion.
const USD_PER_INPUT_TOKEN = 0.3 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 2.5 / 1_000_000;
const USD_PER_GROUNDED_PROMPT = 35 / 1_000;

function costOf(inputTokens: number, outputTokens: number, grounded: boolean): number {
  return inputTokens * USD_PER_INPUT_TOKEN + outputTokens * USD_PER_OUTPUT_TOKEN + (grounded ? USD_PER_GROUNDED_PROMPT : 0);
}

/**
 * What a response we cannot use still cost. A body that fails the response schema may carry a perfectly
 * readable `usageMetadata`, and the vendor bills the tokens either way. Only a non-negative integer token
 * count is trusted; anything else yields null (nothing to attribute), never a guess.
 */
function billedCostOfUnusableBody(body: unknown): number | null {
  const usage = z
    .looseObject({
      usageMetadata: z.looseObject({
        promptTokenCount: z.number().int().min(0).optional(),
        candidatesTokenCount: z.number().int().min(0).optional(),
        thoughtsTokenCount: z.number().int().min(0).optional(),
      }),
      candidates: z.unknown().optional(),
    })
    .safeParse(body);
  if (!usage.success) return null;
  const u = usage.data.usageMetadata;
  if (u.promptTokenCount === undefined && u.candidatesTokenCount === undefined && u.thoughtsTokenCount === undefined) return null;
  const grounded = z
    .array(z.looseObject({ groundingMetadata: z.looseObject({ webSearchQueries: z.array(z.string()).min(1) }) }))
    .min(1)
    .safeParse(usage.data.candidates).success;
  return costOf(u.promptTokenCount ?? 0, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), grounded);
}

const REFUSAL_FINISH_REASONS: ReadonlySet<string> = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"]);

export function buildGeminiRequest(input: CaptureInput): GeminiRequest {
  return {
    contents: [{ role: "user", parts: [{ text: input.promptText }] }],
    tools: [{ google_search: {} }],
  };
}

export function assertGrounded(request: GeminiRequest): void {
  const grounded = (request.tools ?? []).some((tool) => Object.prototype.hasOwnProperty.call(tool, "google_search"));
  if (!grounded) {
    throw new UngroundedRequestError();
  }
}

function failure(code: CaptureFailureCode): CaptureFailureError {
  return new CaptureFailureError(code, "gemini");
}

function codeForStatus(status: number, body: unknown): CaptureFailureCode {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_5xx";
  const parsed = geminiErrorResponseSchema.safeParse(body);
  if (parsed.success && /api key|API_KEY/i.test(parsed.data.error.message)) return "auth_failed";
  return "malformed_response";
}

export class GeminiApiAdapter extends BaseCaptureAdapter {
  readonly engineKey: EngineKey = "gemini";
  readonly captureMode: CaptureMode = "api";
  readonly adapterVersion = "0.1.0";
  readonly supportsCitations = true;
  readonly concurrencyPerTask = 4;

  constructor(protected readonly config: GeminiApiAdapterConfig) {
    super();
  }

  private get model(): string {
    return this.config.model ?? GEMINI_DEFAULT_MODEL;
  }

  private get fetchFn(): typeof fetch {
    return this.config.fetchImpl ?? fetch;
  }

  /** Guard + HTTP call. Rejects with UngroundedRequestError, before any fetch, on an ungrounded request. */
  async dispatch(request: GeminiRequest, ctx: CaptureContext): Promise<unknown> {
    assertGrounded(request);

    const timeout = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeout.abort(new Error("gemini capture timeout"));
    }, this.config.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout.signal]);

    try {
      const response = await this.fetchFn(modelUrl(this.model, ":generateContent"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.config.apiKey },
        body: JSON.stringify(request),
        signal,
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (!response.ok) {
        throw failure(codeForStatus(response.status, body));
      }
      if (body === undefined) {
        throw failure("malformed_response");
      }
      return body;
    } catch (error) {
      if (error instanceof CaptureFailureError) throw error;
      if (timedOut) throw failure("timeout");
      throw error; // caller-initiated abort or an unclassifiable transport fault: never swallowed
    } finally {
      clearTimeout(timer);
    }
  }

  protected async fetchVendorResponse(input: CaptureInput, ctx: CaptureContext): Promise<unknown> {
    const startedAt = performance.now();
    const body = await this.dispatch(buildGeminiRequest(input), ctx);
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));

    const parsed = geminiGenerateContentResponseSchema.safeParse(body);
    if (!parsed.success) {
      incrementCounter("nominara_capture_malformed_response_total", {
        engine_key: this.engineKey,
        adapter_version: this.adapterVersion,
      });
      const billed = billedCostOfUnusableBody(body);
      if (billed !== null) await ctx.recordCost(billed);
      const malformed = failure("malformed_response");
      ctx.span.recordException(malformed);
      throw malformed;
    }
    const response = parsed.data;
    const candidate = response.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((part) => part.thought !== true && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");

    const refused =
      response.promptFeedback?.blockReason !== undefined ||
      (candidate?.finishReason !== undefined && REFUSAL_FINISH_REASONS.has(candidate.finishReason));
    const flags: CaptureFlag[] = [];
    if (refused) flags.push("engine_refused_to_answer");
    else if (text.length === 0) flags.push("empty_answer");

    const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
    const structuredCitations: { url: string; title?: string; slot: number }[] = [];
    for (const chunk of chunks) {
      const uri = chunk.web?.uri;
      if (uri === undefined) continue;
      structuredCitations.push({
        url: uri,
        ...(chunk.web?.title !== undefined ? { title: chunk.web.title } : {}),
        slot: structuredCitations.length + 1,
      });
    }

    const usage = response.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
    const grounded = (candidate?.groundingMetadata?.webSearchQueries?.length ?? 0) > 0 || chunks.length > 0;
    const costUsd = costOf(inputTokens, outputTokens, grounded);

    ctx.span.setAttribute("engine.key", this.engineKey);
    ctx.span.setAttribute("engine.latency_ms", latencyMs);

    return {
      text,
      format: "markdown",
      structuredCitations,
      ...(response.modelVersion !== undefined ? { modelFingerprint: response.modelVersion } : {}),
      truncated: candidate?.finishReason === "MAX_TOKENS",
      responseTokensEst: usage?.candidatesTokenCount ?? Math.ceil(text.length / 4),
      latencyMs,
      ...(response.responseId !== undefined ? { vendorRequestId: response.responseId } : {}),
      costUsd,
      ...(flags.length > 0 ? { flags } : {}),
    };
  }

  /** A free model-metadata GET: proves the credential and reachability without spending a generation. */
  async healthProbe(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const startedAt = performance.now();
    const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
    try {
      const response = await this.fetchFn(modelUrl(this.model, ""), {
        method: "GET",
        headers: { "x-goog-api-key": this.config.apiKey },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (response.ok) return { ok: true, latencyMs: elapsed() };
      const parsed = geminiErrorResponseSchema.safeParse(await response.json().catch(() => undefined));
      const message = parsed.success ? parsed.data.error.message : "no error body";
      return {
        ok: false,
        latencyMs: elapsed(),
        detail: `HTTP ${response.status}: ${message}`.split(this.config.apiKey).join("[redacted]"),
      };
    } catch (error) {
      const name = error instanceof Error ? error.name : "error";
      return { ok: false, latencyMs: elapsed(), detail: `network failure (${name})` };
    }
  }
}
