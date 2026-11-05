import {
  EmbeddingProviderError,
  type EmbeddingBatchResult,
  type EmbeddingProvider,
} from "../ports/embedding-provider.js";

// Owner decision 41 (2026-10-30) - DEVELOPMENT embeddings through OpenRouter's free `nvidia/nemotron-3.5-embed-1b:free`, behind the
// same EMBEDDING_PROVIDER port as the OpenAI adapter. Plain `fetch`, no SDK, no new dependency; the fetch is injectable so every test
// runs against a fake HTTP layer. It is only SELECTED by EMBEDDING_PROVIDER=openrouter outside production
// (embedding-provider.selector.ts): free providers may log their input, so this is not a production path.
//
// WIRE FORMAT. OpenAI-compatible: POST {model, input[], dimensions}. The model is asked for `dimensions: 1536` because the vector
// columns are halfvec(1536) (checked live 2026-10-30: 1536 dimensions, sensible cosines). RECORDED QUIRK: the request names
// `...:free` and the response names the model WITHOUT the suffix (`nvidia/nemotron-3.5-embed-1b`). The response is therefore checked
// against the id with `:free` stripped, and the result carries THIS adapter's own id, which is what lands in `embedding_model`
// beside every vector (EC-23, decision 4): a later switch to another model re-embeds.
//
// RATE. The free tier is 20 requests a minute (and a daily cap on an account with no credit). This adapter paces itself to a
// conservative OPENROUTER_EMBED_REQUESTS_PER_MINUTE (default 10): each call reserves the next slot synchronously, so concurrent
// callers queue rather than burst. It makes ONE attempt per call; the queue's retry ladder is the retry, so a batch is one spend.
//
// FAILURES. 429 / 5xx / network / a timeout / an error envelope with a 429 or 5xx code are `retryable`; every other 4xx is not
// (including 402, no credit: retrying cannot help). The provider's text is never forwarded (it can quote the input back) and the key
// is never put in an error. USAGE is `usage.total_tokens` as reported; a response without it is refused, never estimated. It is
// internal metering (embed_tokens), never the wallet.

export const OPENROUTER_EMBEDDINGS_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
export const OPENROUTER_EMBEDDING_MODEL = "nvidia/nemotron-3.5-embed-1b:free";
export const OPENROUTER_EMBEDDING_DIMENSIONS = 1536;
export const OPENROUTER_EMBEDDING_TIMEOUT_MS = 30_000;
export const OPENROUTER_EMBED_DEFAULT_REQUESTS_PER_MINUTE = 10;

export interface OpenRouterEmbeddingOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Conservative pacing for the free tier. Defaults to 10 a minute. */
  readonly requestsPerMinute?: number;
  /** Injected clock and sleeper so pacing is testable without waiting. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface OpenRouterEmbeddingResponse {
  readonly model?: unknown;
  readonly data?: unknown;
  readonly usage?: { readonly total_tokens?: unknown };
  readonly error?: { readonly code?: unknown };
}

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly model = OPENROUTER_EMBEDDING_MODEL;
  readonly dimensions = OPENROUTER_EMBEDDING_DIMENSIONS;
  readonly requestsPerMinute: number;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextSlotAt = 0;

  constructor(options: OpenRouterEmbeddingOptions) {
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? OPENROUTER_EMBEDDING_TIMEOUT_MS;
    this.requestsPerMinute = options.requestsPerMinute ?? OPENROUTER_EMBED_DEFAULT_REQUESTS_PER_MINUTE;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Reserves the next send slot synchronously (so concurrent callers queue) and waits for it. No transaction is open here (ADR-0003). */
  private async paced(): Promise<void> {
    const interval = 60_000 / this.requestsPerMinute;
    const now = this.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + interval;
    if (slot > now) await this.sleep(slot - now);
  }

  async embed(texts: readonly string[]): Promise<EmbeddingBatchResult> {
    if (texts.length === 0 || texts.length > 96) {
      throw new EmbeddingProviderError("a batch is 1 to 96 texts", { retryable: false });
    }
    await this.paced();
    let response: Response;
    try {
      response = await this.fetchFn(OPENROUTER_EMBEDDINGS_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dimensions }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new EmbeddingProviderError("embedding provider unreachable", { retryable: true });
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new EmbeddingProviderError(`embedding provider answered ${String(response.status)}`, { status: response.status, retryable });
    }
    let body: OpenRouterEmbeddingResponse;
    try {
      body = (await response.json()) as OpenRouterEmbeddingResponse;
    } catch {
      throw new EmbeddingProviderError("embedding provider answered with a body that is not JSON", { retryable: true });
    }
    return this.parse(body, texts.length);
  }

  private parse(body: OpenRouterEmbeddingResponse, expected: number): EmbeddingBatchResult {
    // OpenRouter can answer 200 with an error envelope when the upstream faulted.
    if (body.error !== undefined && body.error !== null) {
      const code = body.error.code;
      const status = typeof code === "number" ? code : undefined;
      const retryable = status === undefined || status === 429 || status >= 500;
      throw new EmbeddingProviderError("embedding provider answered with an error envelope", { ...(status !== undefined ? { status } : {}), retryable });
    }
    const tokens = body.usage?.total_tokens;
    if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < 0) {
      throw new EmbeddingProviderError("embedding response carried no usage", { retryable: false });
    }
    // The response names the model that served it, minus the ":free" routing suffix. Anything else is not the pinned model.
    if (typeof body.model !== "string" || body.model !== this.model.replace(/:free$/, "")) {
      throw new EmbeddingProviderError("embedding response was not served by the pinned model", { retryable: false });
    }
    const data = Array.isArray(body.data) ? (body.data as { index?: unknown; embedding?: unknown }[]) : [];
    if (data.length !== expected) {
      throw new EmbeddingProviderError("embedding response did not return one vector per text", { retryable: false });
    }
    const ordered = [...data].sort((a, b) => Number(a.index) - Number(b.index));
    const vectors = ordered.map((item, position) => {
      const embedding = item.embedding;
      if (item.index !== position || !Array.isArray(embedding) || embedding.length !== this.dimensions) {
        throw new EmbeddingProviderError("embedding response had a vector of the wrong shape", { retryable: false });
      }
      return embedding as number[];
    });
    return { vectors, model: this.model, totalTokens: tokens };
  }
}
