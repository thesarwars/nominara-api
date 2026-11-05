import { z } from "zod";
import type { CaptureFlag } from "../contract.js";
import type { CaptureFailureCode } from "../failure-taxonomy.js";
import { retryAfterMsOf } from "../gemini/gemini-api-adapter.js";
import { openRouterChatResponseSchema, openRouterErrorEnvelopeSchema, urlCitationSchema, type OpenRouterChatResponse } from "./openrouter-response.schema.js";

// STORY-028 / owner decision 42 - the transport and normalisation shared by the tracked-engine adapter and the dev-only free-model probe.
// Nothing here knows an engine key: that is what lets the probe share it without ever being able to stamp a result with one.
//
// HOW CITATIONS ARE OBTAINED (observed live 2026-10-30, one call per engine):
//   perplexity/sonar     search-native; NO plugin (sending one answers 404). `message.annotations[].url_citation`, one per source, with
//                        start_index = end_index = 0, so the array order is the only order. 18 on the recorded call.
//   openai/gpt-*         the `web` plugin on the native engine. NO annotations were returned: the sources are inline URLs in the text
//                        (`?utm_source=openai`), left for the citation pass to extract. structuredCitations stays empty - none invented.
//   anthropic/claude-*   the `web` plugin on the native engine. The recorded call spent its whole budget on reasoning (content null), so
//                        annotations were NOT observed. The documented shape is the same url_citation annotation; read if present.
// Direct URLs, never vendor wrappers, so nothing is marked for redirect resolution (contrast Gemini).

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
/** Reasoning models spend this budget on thinking before the answer; a small cap yields an empty, truncated answer (recorded). */
export const OPENROUTER_MAX_TOKENS = 4096;

export interface OpenRouterRequest {
  readonly model: string;
  readonly messages: readonly { readonly role: "user"; readonly content: string }[];
  readonly plugins?: readonly { readonly id: string; readonly engine?: string; readonly max_results?: number }[] | undefined;
  readonly max_tokens: number;
  readonly usage: { readonly include: true };
}

/** A failed OpenRouter call, already classified into the tracking-engine.md section 2 taxonomy. Carries no vendor text and no credential. */
export class OpenRouterCallError extends Error {
  readonly code: CaptureFailureCode;
  readonly retryAfterMs: number | undefined;
  constructor(code: CaptureFailureCode, retryAfterMs?: number) {
    super(`openrouter call failed: ${code}`);
    this.name = "OpenRouterCallError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * 401 -> auth_failed · 402 -> quota_exhausted (no credit, terminal) · 403 and 404 -> blocked · 408 -> timeout · 429 -> rate_limited ·
 * 5xx -> upstream_5xx · other 4xx -> malformed_response.
 *
 * 403 is NOT a credential signal on this vendor: it means the model requires moderation and the input was flagged (OpenRouter's own
 * pre-filter, decision 50c: `blocked`, never `engine_refused_to_answer`, so it stays out of visibility numbers; the flagged input is never
 * copied into the result or the error) or, for a free model, that the route is closed. The same mapping applies to an in-body 403 envelope. 404 is "no endpoints found" for a delisted or
 * renamed model, or a model without native web search: a CONFIGURATION fault, terminal, and not a vendor-payload (parser) fault. Both
 * are `blocked`: the engine could not be used as configured.
 */
export function failureCodeForStatus(status: number): CaptureFailureCode {
  if (status === 401) return "auth_failed";
  if (status === 403 || status === 404) return "blocked";
  if (status === 402) return "quota_exhausted";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_5xx";
  return "malformed_response";
}

function envelopeCode(body: unknown): number | undefined | null {
  const parsed = openRouterErrorEnvelopeSchema.safeParse(body);
  if (!parsed.success) return null; // not an error envelope
  const code = parsed.data.error.code;
  return typeof code === "number" ? code : undefined;
}

/**
 * POST one chat completion. Throws OpenRouterCallError for every non-answer; returns the parsed JSON body otherwise (validated by the
 * caller). The key travels only in the Authorization header. A timeout is classified `timeout`; a caller-initiated abort propagates.
 */
export async function postChat(options: {
  readonly fetchFn: typeof fetch;
  readonly apiKey: string;
  readonly request: OpenRouterRequest;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}): Promise<unknown> {
  const timeout = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeout.abort(new Error("openrouter capture timeout"));
  }, options.timeoutMs);
  const signal = options.signal === undefined ? timeout.signal : AbortSignal.any([options.signal, timeout.signal]);
  try {
    const response = await options.fetchFn(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(options.request),
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
      const code = failureCodeForStatus(response.status);
      throw new OpenRouterCallError(code, code === "rate_limited" ? retryAfterMsOf(response.headers, body) : undefined);
    }
    if (body === undefined) throw new OpenRouterCallError("malformed_response");
    const inBody = envelopeCode(body);
    if (inBody !== null) {
      throw new OpenRouterCallError(inBody === undefined ? "malformed_response" : failureCodeForStatus(inBody));
    }
    return body;
  } catch (error) {
    if (error instanceof OpenRouterCallError) throw error;
    if (timedOut) throw new OpenRouterCallError("timeout");
    throw error; // caller-initiated abort or an unclassifiable transport fault: never swallowed
  } finally {
    clearTimeout(timer);
  }
}

// A conservative fallback when OpenRouter reports no `usage.cost`: priced high enough that the spend meter over-reads rather than
// under-reads. $5 / 1M input and $25 / 1M output tokens (the dearest model in the default set is below this).
const FALLBACK_USD_PER_INPUT_TOKEN = 5 / 1_000_000;
const FALLBACK_USD_PER_OUTPUT_TOKEN = 25 / 1_000_000;

/** What a body we cannot use still cost: only a readable non-negative `usage.cost` is trusted; otherwise null (nothing to attribute). */
export function billedCostOfUnusableBody(body: unknown): number | null {
  const parsed = z.looseObject({ usage: z.looseObject({ cost: z.number().min(0) }) }).safeParse(body);
  return parsed.success ? parsed.data.usage.cost : null;
}

export interface NormalisedChat {
  readonly text: string;
  readonly citations: readonly { readonly url: string; readonly title?: string; readonly slot: number }[];
  readonly flags: readonly CaptureFlag[];
  readonly truncated: boolean;
  readonly model: string | undefined;
  readonly vendorRequestId: string | undefined;
  readonly completionTokens: number | undefined;
  readonly costUsd: number;
}

/** `free`: a ':free' model costs nothing, so a missing `usage.cost` is 0, never the token-priced fallback (which would invent spend). */
export function normaliseChat(response: OpenRouterChatResponse, free = false): NormalisedChat {
  const choice = response.choices[0]!;
  const message = choice.message;
  const text = message.content ?? "";
  const finish = choice.finish_reason ?? undefined;

  const refused = finish === "content_filter" || (typeof message.refusal === "string" && message.refusal.length > 0);
  const flags: CaptureFlag[] = [];
  if (refused) flags.push("engine_refused_to_answer");
  else if (text.length === 0) flags.push("empty_answer");

  // Structured citations: url_citation annotations in array order. A URL cited at several spans takes the slot of its first appearance.
  const seen = new Set<string>();
  const citations: { url: string; title?: string; slot: number }[] = [];
  for (const annotation of message.annotations ?? []) {
    const parsed = urlCitationSchema.safeParse(annotation);
    if (!parsed.success) continue;
    const { url, title } = parsed.data.url_citation;
    if (seen.has(url)) continue;
    seen.add(url);
    citations.push({ url, ...(title !== undefined ? { title } : {}), slot: citations.length + 1 });
  }

  const usage = response.usage;
  const costUsd = usage?.cost ?? (free ? 0 : (usage?.prompt_tokens ?? 0) * FALLBACK_USD_PER_INPUT_TOKEN + (usage?.completion_tokens ?? 0) * FALLBACK_USD_PER_OUTPUT_TOKEN);

  return {
    text,
    citations,
    flags,
    truncated: finish === "length",
    model: response.model,
    vendorRequestId: response.id,
    completionTokens: usage?.completion_tokens,
    costUsd,
  };
}

export function parseChat(body: unknown): { readonly ok: true; readonly data: OpenRouterChatResponse } | { readonly ok: false } {
  const parsed = openRouterChatResponseSchema.safeParse(body);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
}
