import {
  EmbeddingProviderError,
  type EmbeddingBatchResult,
  type EmbeddingProvider,
} from "../ports/embedding-provider.js";

// STORY-133 - the EMBEDDING_PROVIDER port's real transport: OpenAI's REST embeddings endpoint over the platform `fetch`. No SDK:
// one endpoint does not earn a dependency (the Resend adapter's precedent), and the fetch is injectable so every test runs against
// a fake HTTP layer. It is only SELECTED when OPENAI_API_KEY is set (embedding-provider.selector.ts) and is never called in CI.
//
// `text-embedding-3-large` returns 3072 dimensions natively; the schema's vector columns are halfvec(1536), so the request asks for
// `dimensions: 1536` (OpenAI documents truncation to a smaller size as supported). The model id is pinned, not an alias.
//
// FAILURES. A 429, a 5xx, a network error or a timeout is `retryable`; every other 4xx is the request's own fault. The queue's
// retry ladder (section 4: 3x exponential) is the retry - this adapter makes ONE attempt, so a batch is one provider call and
// the idempotency key still means one spend. Provider text is never forwarded (it can quote the input back) and the key is
// never put in an error.
//
// USAGE comes from the response's `usage.total_tokens`. A response without it is refused rather than estimated.

export const OPENAI_EMBEDDINGS_ENDPOINT = "https://api.openai.com/v1/embeddings";
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-large";
export const OPENAI_EMBEDDING_DIMENSIONS = 1536;
export const OPENAI_EMBEDDING_TIMEOUT_MS = 30_000;

export interface OpenAiEmbeddingOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface OpenAiResponse {
  readonly data?: unknown;
  readonly usage?: { readonly total_tokens?: unknown };
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly model = OPENAI_EMBEDDING_MODEL;
  readonly dimensions = OPENAI_EMBEDDING_DIMENSIONS;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAiEmbeddingOptions) {
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? OPENAI_EMBEDDING_TIMEOUT_MS;
  }

  async embed(texts: readonly string[]): Promise<EmbeddingBatchResult> {
    if (texts.length === 0 || texts.length > 96) {
      throw new EmbeddingProviderError("a batch is 1 to 96 texts", { retryable: false });
    }
    let response: Response;
    try {
      response = await this.fetchFn(OPENAI_EMBEDDINGS_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dimensions, encoding_format: "float" }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new EmbeddingProviderError("embedding provider unreachable", { retryable: true });
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new EmbeddingProviderError(`embedding provider answered ${String(response.status)}`, { status: response.status, retryable });
    }
    let body: OpenAiResponse;
    try {
      body = (await response.json()) as OpenAiResponse;
    } catch {
      throw new EmbeddingProviderError("embedding provider answered with a body that is not JSON", { retryable: true });
    }
    return this.parse(body, texts.length);
  }

  private parse(body: OpenAiResponse, expected: number): EmbeddingBatchResult {
    const tokens = body.usage?.total_tokens;
    if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < 0) {
      throw new EmbeddingProviderError("embedding response carried no usage", { retryable: false });
    }
    const data = Array.isArray(body.data) ? (body.data as { index?: unknown; embedding?: unknown }[]) : [];
    if (data.length !== expected) {
      throw new EmbeddingProviderError("embedding response did not return one vector per text", { retryable: false });
    }
    // The API documents `index`; order by it rather than trusting array order.
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
