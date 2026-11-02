import type { CaptureFailureCode } from "../failure-taxonomy.js";
import { FreeModelPathError, isFreeModel } from "./openrouter-adapter.js";
import { normaliseChat, OPENROUTER_MAX_TOKENS, OpenRouterCallError, parseChat, postChat } from "./openrouter-chat.js";

// Owner decision 42 - the DEV-ONLY free-model path: it exercises the OpenRouter plumbing (auth, request shape, response parsing,
// failure mapping) without spending credit, with a ':free' model such as google/gemma-4-26b-a4b-it:free.
//
// ⚠ IT MUST BE IMPOSSIBLE FOR THIS PATH TO WRITE A RESULT UNDER A TRACKED ENGINE'S NAME. Four independent locks:
//   1. This is NOT a CaptureAdapter: it has no `engineKey` and no `capture()`, and its result type carries neither an engine key nor the
//      RawCapture shape, so nothing that persists a capture can be handed one (a type error, and rawCaptureSchema rejects it at runtime).
//   2. registry.ts never imports this file (asserted by a source-scan test), so resolveEngine() cannot return it.
//   3. It accepts ONLY ':free' model ids and refuses to be built under NODE_ENV=production (FreeModelPathError); free providers may log input.
//   4. The mirror image: OpenRouterAdapter refuses a ':free' model id, and the registry leaves a tracked engine fixture-backed rather than
//      binding one.
// It sends no web plugin: search costs money even on a free model, and a probe is not a measurement.

export interface FreeProbeResult {
  readonly kind: "openrouter_free_probe";
  readonly model: string;
  readonly text: string;
  readonly citationUrls: readonly string[];
  readonly truncated: boolean;
  readonly costUsd: number;
  readonly latencyMs: number;
}

/** A failed probe call, already classified into the failure taxonomy. */
export class FreeProbeError extends Error {
  readonly code: CaptureFailureCode;
  constructor(code: CaptureFailureCode) {
    super(`openrouter free probe failed: ${code}`);
    this.name = "FreeProbeError";
    this.code = code;
  }
}

export interface OpenRouterFreeProbeConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly nodeEnv: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class OpenRouterFreeProbe {
  constructor(private readonly config: OpenRouterFreeProbeConfig) {
    if (config.nodeEnv === "production") throw new FreeModelPathError("the free-model probe is development only and refuses to run in production");
    if (!isFreeModel(config.model)) throw new FreeModelPathError("the free-model probe accepts ':free' model ids only");
  }

  async probe(promptText: string): Promise<FreeProbeResult> {
    const startedAt = performance.now();
    let body: unknown;
    try {
      body = await postChat({
        fetchFn: this.config.fetchImpl ?? fetch,
        apiKey: this.config.apiKey,
        request: { model: this.config.model, messages: [{ role: "user", content: promptText }], max_tokens: OPENROUTER_MAX_TOKENS, usage: { include: true } },
        timeoutMs: this.config.timeoutMs ?? 30_000,
      });
    } catch (error) {
      if (error instanceof OpenRouterCallError) throw new FreeProbeError(error.code);
      throw error;
    }
    const parsed = parseChat(body);
    if (!parsed.ok) throw new FreeProbeError("malformed_response");
    const chat = normaliseChat(parsed.data);
    return {
      kind: "openrouter_free_probe",
      model: chat.model ?? this.config.model,
      text: chat.text,
      citationUrls: chat.citations.map((c) => c.url),
      truncated: chat.truncated,
      costUsd: chat.costUsd,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    };
  }
}

export { FreeModelPathError };
