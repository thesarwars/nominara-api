import { describe, expect, it, vi } from "vitest";
import { EmbeddingProviderError } from "../../../src/modules/prompts/ports/embedding-provider.js";
import { StandInEmbeddingProvider, STAND_IN_EMBEDDING_MODEL } from "../../../src/modules/prompts/adapters/stand-in-embedding-provider.js";
import {
  OPENROUTER_EMBEDDINGS_ENDPOINT,
  OPENROUTER_EMBEDDING_MODEL,
  OpenRouterEmbeddingProvider,
} from "../../../src/modules/prompts/adapters/openrouter-embedding-provider.js";
import { selectEmbeddingProvider } from "../../../src/modules/prompts/embedding-provider.selector.js";

// Owner decision 41 (2026-10-30) - development embeddings through OpenRouter's free nvidia/nemotron-3.5-embed-1b:free, asked for 1536
// dimensions. Everything here runs against an injected HTTP layer; the one live call lives in the recorded fixture's provenance.
//
// The recorded shape (live call 2026-10-30, ids and provider stripped): the response names the model WITHOUT the ":free" suffix
// that the request carried, `usage` has prompt_tokens / total_tokens / cost, and each datum has object / embedding / index.

const RECORDED_RESPONSE_MODEL = "nvidia/nemotron-3.5-embed-1b";
const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
const FAKE_KEY = "sk-or-test-not-a-secret";

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function recorded(count: number, overrides: Record<string, unknown> = {}) {
  return {
    object: "list",
    model: RECORDED_RESPONSE_MODEL,
    data: Array.from({ length: count }, (_, index) => ({ object: "embedding", index, embedding: vector })),
    usage: { prompt_tokens: 13, total_tokens: 13, cost: 0, is_byok: false },
    ...overrides,
  };
}

function make(fetchFn: unknown, extra: Partial<ConstructorParameters<typeof OpenRouterEmbeddingProvider>[0]> = {}) {
  return new OpenRouterEmbeddingProvider({ apiKey: FAKE_KEY, fetch: fetchFn as typeof fetch, sleep: async () => undefined, ...extra });
}

describe("decision 41 - the OpenRouter embedding adapter, against an injected HTTP layer", () => {
  it("posts one OpenAI-compatible batch (model, input[], dimensions 1536) and reads the provider-reported usage", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      void init;
      return response(recorded(2));
    });
    const result = await make(fetchFn).embed(["one", "two"]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(OPENROUTER_EMBEDDINGS_ENDPOINT);
    expect(new URL(url).pathname).toBe("/api/v1/embeddings");
    expect(JSON.parse(String(init!.body))).toEqual({ model: "nvidia/nemotron-3.5-embed-1b:free", input: ["one", "two"], dimensions: 1536 });
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(result.totalTokens).toBe(13);
    expect(result.vectors).toHaveLength(2);
  });

  it("stores vectors under the provider's own model id, with the :free suffix the request used (decision 4 / EC-23)", async () => {
    const provider = make(async () => response(recorded(1)));
    expect(provider.model).toBe(OPENROUTER_EMBEDDING_MODEL);
    expect(provider.model).toBe("nvidia/nemotron-3.5-embed-1b:free");
    expect(provider.dimensions).toBe(1536);
    expect((await provider.embed(["x"])).model).toBe(OPENROUTER_EMBEDDING_MODEL);
  });

  it("refuses a response served by a different model (non-retryable), and one that names none", async () => {
    const other = (await make(async () => response(recorded(1, { model: "openai/text-embedding-3-small" })))
      .embed(["x"]).catch((e: unknown) => e)) as EmbeddingProviderError;
    expect(other).toBeInstanceOf(EmbeddingProviderError);
    expect(other.retryable).toBe(false);
    const none = await make(async () => response(recorded(1, { model: undefined }))).embed(["x"]).catch((e: unknown) => e);
    expect(none).toBeInstanceOf(EmbeddingProviderError);
  });

  it("orders vectors by index rather than array order", async () => {
    const a = vector.map((_, i) => (i === 1 ? 1 : 0));
    const body = recorded(2, { data: [{ index: 1, embedding: a }, { index: 0, embedding: vector }] });
    const result = await make(async () => response(body)).embed(["x", "y"]);
    expect(result.vectors[0]).toEqual(vector);
    expect(result.vectors[1]).toEqual(a);
  });

  it("refuses missing usage, a wrong count, a wrong dimension - it never estimates", async () => {
    await expect(make(async () => response(recorded(1, { usage: undefined }))).embed(["x"])).rejects.toBeInstanceOf(EmbeddingProviderError);
    await expect(make(async () => response(recorded(0))).embed(["x"])).rejects.toBeInstanceOf(EmbeddingProviderError);
    await expect(make(async () => response(recorded(1, { data: [{ index: 0, embedding: [1, 2] }] }))).embed(["x"])).rejects.toBeInstanceOf(EmbeddingProviderError);
  });

  it("a batch is 1 to 96 texts", async () => {
    const provider = make(async () => response(recorded(1)));
    await expect(provider.embed([])).rejects.toMatchObject({ retryable: false });
    await expect(provider.embed(Array.from({ length: 97 }, () => "x"))).rejects.toMatchObject({ retryable: false });
  });

  it("classifies failures: 429 and 5xx retry, 401 / 402 / 400 do not; the key and the provider's text never travel", async () => {
    const status = async (code: number) =>
      (await make(async () => response({ error: { message: `echo ${FAKE_KEY} secret prompt text` } }, code)).embed(["x"]).catch((e: unknown) => e)) as EmbeddingProviderError;
    expect(await status(429)).toMatchObject({ status: 429, retryable: true });
    expect(await status(503)).toMatchObject({ status: 503, retryable: true });
    expect(await status(402)).toMatchObject({ status: 402, retryable: false });
    expect(await status(401)).toMatchObject({ status: 401, retryable: false });
    expect(await status(400)).toMatchObject({ status: 400, retryable: false });
    const error = await status(401);
    expect(error.message).not.toContain(FAKE_KEY);
    expect(error.message).not.toContain("secret prompt text");
  });

  it("a 200 carrying an error envelope (OpenRouter does this on an upstream fault) is a provider error, not a result", async () => {
    const error = (await make(async () => response({ error: { code: 502, message: "upstream" } })).embed(["x"]).catch((e: unknown) => e)) as EmbeddingProviderError;
    expect(error).toBeInstanceOf(EmbeddingProviderError);
    expect(error.retryable).toBe(true);
  });

  it("a network failure is retryable, and a body that is not JSON is too", async () => {
    expect(await make(async () => { throw new Error("ECONNRESET"); }).embed(["x"]).catch((e: unknown) => e)).toMatchObject({ retryable: true });
    expect(await make(async () => new Response("<html>", { status: 200 })).embed(["x"]).catch((e: unknown) => e)).toMatchObject({ retryable: true });
  });

  it("paces calls to the free tier: the second call within the interval waits, the first does not", async () => {
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const provider = make(async () => response(recorded(1)), {
      requestsPerMinute: 6,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    await provider.embed(["a"]);
    await provider.embed(["b"]);
    expect(sleeps).toEqual([10_000]);
  });

  it("concurrent calls reserve distinct slots (no burst past the rate)", async () => {
    const sleeps: number[] = [];
    const provider = make(async () => response(recorded(1)), { requestsPerMinute: 6, now: () => 5_000, sleep: async (ms: number) => void sleeps.push(ms) });
    await Promise.all([provider.embed(["a"]), provider.embed(["b"]), provider.embed(["c"])]);
    expect([...sleeps].sort((x, y) => x - y)).toEqual([10_000, 20_000]);
  });
});

describe("decision 41 - which provider this process runs", () => {
  it("the default stays the stand-in even when an OpenRouter key is present (tests and every other process stay offline)", () => {
    expect(selectEmbeddingProvider({ NODE_ENV: "test", OPENROUTER_API_KEY: FAKE_KEY }).model).toBe(STAND_IN_EMBEDDING_MODEL);
    expect(selectEmbeddingProvider({ NODE_ENV: "development", OPENROUTER_API_KEY: FAKE_KEY }).model).toBe(STAND_IN_EMBEDDING_MODEL);
  });

  it("EMBEDDING_PROVIDER=openrouter with a key selects the OpenRouter adapter", () => {
    const provider = selectEmbeddingProvider({ NODE_ENV: "development", EMBEDDING_PROVIDER: "openrouter", OPENROUTER_API_KEY: FAKE_KEY });
    expect(provider).toBeInstanceOf(OpenRouterEmbeddingProvider);
    expect(provider.model).toBe(OPENROUTER_EMBEDDING_MODEL);
  });

  it("EMBEDDING_PROVIDER=openrouter with no key refuses on use - it does not quietly fall back to the stand-in", async () => {
    const provider = selectEmbeddingProvider({ NODE_ENV: "development", EMBEDDING_PROVIDER: "openrouter" });
    expect(provider).not.toBeInstanceOf(StandInEmbeddingProvider);
    await expect(provider.embed(["x"])).rejects.toMatchObject({ retryable: true });
  });

  it("OpenRouter's free embeddings are development only: under NODE_ENV=production it refuses even with a key", async () => {
    const provider = selectEmbeddingProvider({ NODE_ENV: "production", EMBEDDING_PROVIDER: "openrouter", OPENROUTER_API_KEY: FAKE_KEY });
    expect(provider).not.toBeInstanceOf(OpenRouterEmbeddingProvider);
    await expect(provider.embed(["x"])).rejects.toBeInstanceOf(EmbeddingProviderError);
  });

  it("EMBEDDING_PROVIDER=stand-in outside production is the stand-in even with an OpenAI key present", () => {
    expect(selectEmbeddingProvider({ NODE_ENV: "development", EMBEDDING_PROVIDER: "stand-in", OPENAI_API_KEY: "sk-x" }).model).toBe(STAND_IN_EMBEDDING_MODEL);
  });

  it("the pre-existing auto behaviour is unchanged: an OpenAI key selects OpenAI", () => {
    expect(selectEmbeddingProvider({ NODE_ENV: "development", OPENAI_API_KEY: "sk-x" }).model).toBe("text-embedding-3-large");
    expect(selectEmbeddingProvider({ NODE_ENV: "development", EMBEDDING_PROVIDER: "auto", OPENAI_API_KEY: "sk-x" }).model).toBe("text-embedding-3-large");
  });

  it("the requests-per-minute knob reaches the adapter", async () => {
    const provider = selectEmbeddingProvider({ NODE_ENV: "development", EMBEDDING_PROVIDER: "openrouter", OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_EMBED_REQUESTS_PER_MINUTE: 3 });
    expect((provider as OpenRouterEmbeddingProvider).requestsPerMinute).toBe(3);
  });
});
