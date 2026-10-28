import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ESLint } from "eslint";
import { describe, expect, it, vi } from "vitest";
import {
  EMBED_JOB_MAX_IDS,
  EMBED_PROVIDER_BATCH_SIZE,
  embedBatchKey,
  embedBatchPayloadSchema,
  splitIntoProviderBatches,
  splitIdsIntoJobs,
} from "../../../src/lib/embedding/embed-batch.js";
import { buildIdempotencyKey } from "../../../src/lib/queue/idempotency.js";
import { EmbeddingProviderError } from "../../../src/modules/prompts/ports/embedding-provider.js";
import { StandInEmbeddingProvider, STAND_IN_EMBEDDING_MODEL } from "../../../src/modules/prompts/adapters/stand-in-embedding-provider.js";
import { OPENAI_EMBEDDINGS_ENDPOINT, OpenAiEmbeddingProvider } from "../../../src/modules/prompts/adapters/openai-embedding-provider.js";
import { selectEmbeddingProvider } from "../../../src/modules/prompts/embedding-provider.selector.js";

// STORY-133 — the pure parts of the embedding client. The handler's database behaviour is test/integration/embed-batch-handler.spec.ts.

const ID_A = "01a06ccd-0000-7000-8000-00000000000a";
const ID_B = "01a06ccd-0000-7000-8000-00000000000b";
const ID_C = "01a06ccd-0000-7000-8000-00000000000c";

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `01a06ccd-0000-7000-8000-${String(i).padStart(12, "0")}`);
}

describe("STORY-133 · batch sizing and the content-addressed key", () => {
  it("pins section 4's batch of 96 to the literal", () => {
    expect(EMBED_PROVIDER_BATCH_SIZE).toBe(96);
  });

  it("scenario 1 — 96 texts are one provider batch", () => {
    expect(splitIntoProviderBatches(ids(96))).toHaveLength(1);
  });

  it("scenario 2 — 97 texts are two batches, none dropped and none duplicated", () => {
    const input = ids(97);
    const batches = splitIntoProviderBatches(input);
    expect(batches.map((batch) => batch.length)).toEqual([96, 1]);
    expect(batches.flat()).toEqual(input);
  });

  it("scenario 3 — one text is still a batch", () => {
    expect(splitIntoProviderBatches(["x"])).toEqual([["x"]]);
  });

  it("an empty list is no batches, not one empty call", () => {
    expect(splitIntoProviderBatches([])).toEqual([]);
  });

  it("splits a producer's ids into jobs of at most 96, so a job is normally one provider call", () => {
    const jobs = splitIdsIntoJobs(ids(200));
    expect(jobs.map((job) => job.length)).toEqual([96, 96, 8]);
  });

  it("the key is emb:{sha256(batch)} and is the topology's own pattern", () => {
    const key = embedBatchKey("tracked_prompts", [ID_A, ID_B]);
    expect(key).toMatch(/^emb:[0-9a-f]{64}$/);
    expect(key).toBe(buildIdempotencyKey("embed.batch", { "sha256(batch)": key.slice(4) }));
  });

  it("reordering the same batch gives the SAME key — the batch is sorted canonically before hashing", () => {
    expect(embedBatchKey("tracked_prompts", [ID_C, ID_A, ID_B])).toBe(embedBatchKey("tracked_prompts", [ID_A, ID_B, ID_C]));
  });

  it("letter case and a repeated id do not change the key", () => {
    expect(embedBatchKey("tracked_prompts", [ID_A.toUpperCase(), ID_A, ID_B])).toBe(embedBatchKey("tracked_prompts", [ID_A, ID_B]));
  });

  it("a different composition or a different table is a different key", () => {
    expect(embedBatchKey("tracked_prompts", [ID_A])).not.toBe(embedBatchKey("tracked_prompts", [ID_A, ID_B]));
    expect(embedBatchKey("tracked_prompts", [ID_A])).not.toBe(embedBatchKey("content_chunks", [ID_A]));
  });

  it("is a real sha256, not a lookalike", () => {
    const expected = createHash("sha256").update(`tracked_prompts\n${ID_A}\n${ID_B}`).digest("hex");
    expect(embedBatchKey("tracked_prompts", [ID_B, ID_A])).toBe(`emb:${expected}`);
  });

  it("the payload schema is strict, refuses an empty batch, an unknown table and an oversized job", () => {
    const ok = { workspaceId: ID_A, kid: "k", table: "tracked_prompts", ids: [ID_B] };
    expect(embedBatchPayloadSchema.safeParse(ok).success).toBe(true);
    expect(embedBatchPayloadSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(embedBatchPayloadSchema.safeParse({ ...ok, ids: [] }).success).toBe(false);
    expect(embedBatchPayloadSchema.safeParse({ ...ok, table: "users" }).success).toBe(false);
    expect(embedBatchPayloadSchema.safeParse({ ...ok, ids: ids(EMBED_JOB_MAX_IDS + 1) }).success).toBe(false);
    expect(embedBatchPayloadSchema.safeParse({ ...ok, ids: ids(EMBED_JOB_MAX_IDS) }).success).toBe(true);
  });
});

describe("STORY-133 · the stand-in provider", () => {
  const provider = new StandInEmbeddingProvider();

  it("returns the schema's dimension for every text, in order", async () => {
    const result = await provider.embed(["alpha beta", "gamma"]);
    expect(result.vectors).toHaveLength(2);
    for (const vector of result.vectors) expect(vector).toHaveLength(1536);
    expect(provider.dimensions).toBe(1536);
  });

  it("is deterministic: the same text, the same vector", async () => {
    const [a] = (await provider.embed(["best crm for small teams"])).vectors;
    const [b] = (await provider.embed(["best crm for small teams"])).vectors;
    expect(a).toEqual(b);
  });

  it("returns DISTINCT, non-zero vectors — a zero vector would make L2 suppress everything", async () => {
    const { vectors } = await provider.embed(["best crm for small teams", "how do i bake sourdough bread"]);
    expect(vectors[0]).not.toEqual(vectors[1]);
    for (const vector of vectors) expect(vector.some((component) => component !== 0)).toBe(true);
  });

  it("names itself, so a stand-in vector can never be mistaken for a real model's (EC-23)", async () => {
    expect(provider.model).toBe(STAND_IN_EMBEDDING_MODEL);
    expect(STAND_IN_EMBEDDING_MODEL).not.toMatch(/text-embedding/);
  });

  it("reports usage as a non-negative integer", async () => {
    const result = await provider.embed(["a b c"]);
    expect(Number.isInteger(result.totalTokens)).toBe(true);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it("refuses a batch above 96", async () => {
    await expect(provider.embed(Array.from({ length: 97 }, (_, i) => `t${String(i)}`))).rejects.toBeInstanceOf(EmbeddingProviderError);
  });
});

describe("STORY-133 · the OpenAI adapter, against an injected HTTP layer (never the network)", () => {
  function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }
  const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));

  it("posts one batched request, pins the dimension and the model, and reads the provider-reported usage", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      void init;
      return response({
        model: "text-embedding-3-large",
        data: [{ index: 1, embedding: vector }, { index: 0, embedding: vector }],
        usage: { prompt_tokens: 11, total_tokens: 11 },
      });
    });
    const provider = new OpenAiEmbeddingProvider({ apiKey: "sk-test", fetch: fetchFn as unknown as typeof fetch });
    const result = await provider.embed(["one", "two"]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(OPENAI_EMBEDDINGS_ENDPOINT);
    expect(new URL(url).pathname).toBe("/v1/embeddings");
    expect(JSON.parse(String(init!.body))).toEqual({ model: "text-embedding-3-large", input: ["one", "two"], dimensions: 1536, encoding_format: "float" });
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(result.totalTokens).toBe(11);
    expect(result.model).toBe("text-embedding-3-large");
    expect(result.vectors).toHaveLength(2);
  });

  it("scenario 6 — a 429 is a retryable provider error carrying the status", async () => {
    const provider = new OpenAiEmbeddingProvider({ apiKey: "sk-test", fetch: (async () => response({ error: { message: "slow down" } }, 429)) as unknown as typeof fetch });
    const error = await provider.embed(["x"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingProviderError);
    expect(error).toMatchObject({ status: 429, retryable: true });
  });

  it("a 400 is NOT retryable, and the provider's text is never forwarded", async () => {
    const provider = new OpenAiEmbeddingProvider({ apiKey: "sk-test", fetch: (async () => response({ error: { message: "secret prompt text echoed" } }, 400)) as unknown as typeof fetch });
    const error = (await provider.embed(["x"]).catch((e: unknown) => e)) as EmbeddingProviderError;
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain("secret prompt text");
  });

  it("refuses a response with missing usage, the wrong count, or the wrong dimension — it never estimates", async () => {
    const make = (body: unknown) => new OpenAiEmbeddingProvider({ apiKey: "k", fetch: (async () => response(body)) as unknown as typeof fetch });
    await expect(make({ model: "text-embedding-3-large", data: [{ index: 0, embedding: vector }] }).embed(["x"])).rejects.toBeInstanceOf(EmbeddingProviderError);
    await expect(make({ model: "text-embedding-3-large", data: [], usage: { total_tokens: 1 } }).embed(["x"])).rejects.toBeInstanceOf(EmbeddingProviderError);
    await expect(make({ model: "text-embedding-3-large", data: [{ index: 0, embedding: [1, 2] }], usage: { total_tokens: 1 } }).embed(["x"])).rejects.toBeInstanceOf(EmbeddingProviderError);
  });

  it("review - the response's own model is checked: a different model is refused (non-retryable) and the returned model is the response's", async () => {
    const make = (model: unknown) =>
      new OpenAiEmbeddingProvider({ apiKey: "k", fetch: (async () => response({ model, data: [{ index: 0, embedding: vector }], usage: { total_tokens: 3 } })) as unknown as typeof fetch });
    const ok = await make("text-embedding-3-large").embed(["x"]);
    expect(ok.model).toBe("text-embedding-3-large");
    const error = (await make("text-embedding-3-small").embed(["x"]).catch((e: unknown) => e)) as EmbeddingProviderError;
    expect(error).toBeInstanceOf(EmbeddingProviderError);
    expect(error.retryable).toBe(false);
    // A response that names no model at all is not the pinned one either.
    const missing = await make(undefined).embed(["x"]).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(EmbeddingProviderError);
  });

  it("a network failure is a retryable provider error", async () => {
    const provider = new OpenAiEmbeddingProvider({ apiKey: "k", fetch: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch });
    expect(await provider.embed(["x"]).catch((e: unknown) => e)).toMatchObject({ retryable: true });
  });

  it("never puts the key in an error", async () => {
    const provider = new OpenAiEmbeddingProvider({ apiKey: "sk-very-secret", fetch: (async () => response({}, 401)) as unknown as typeof fetch });
    const error = (await provider.embed(["x"]).catch((e: unknown) => e)) as Error;
    expect(String(error.message)).not.toContain("sk-very-secret");
  });
});

describe("STORY-133 · which provider this process runs", () => {
  it("a key selects the OpenAI adapter", () => {
    expect(selectEmbeddingProvider({ NODE_ENV: "development", OPENAI_API_KEY: "sk-x" }).model).toBe("text-embedding-3-large");
  });

  it("no key outside production selects the stand-in", () => {
    expect(selectEmbeddingProvider({ NODE_ENV: "development" }).model).toBe(STAND_IN_EMBEDDING_MODEL);
    expect(selectEmbeddingProvider({ NODE_ENV: "test" }).model).toBe(STAND_IN_EMBEDDING_MODEL);
  });

  it("no key IN PRODUCTION never falls back to a fake: it fails closed on use", async () => {
    const provider = selectEmbeddingProvider({ NODE_ENV: "production" });
    await expect(provider.embed(["x"])).rejects.toBeInstanceOf(EmbeddingProviderError);
  });
});

describe("STORY-133 · NFR-ARCH-01 — the port is reachable from the embed.batch handler and from nowhere else", () => {
  const eslint = new ESLint({ cwd: new URL("../../../", import.meta.url).pathname });

  async function lintMessages(filePath: string, code: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: new URL(`../../../${filePath}`, import.meta.url).pathname });
    return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
  }

  it("scenario 15 — a request handler importing the port fails lint", async () => {
    const messages = await lintMessages(
      "src/modules/prompts/prompts.service.ts",
      'import { EMBEDDING_PROVIDER } from "./ports/embedding-provider.js";\nexport const x = EMBEDDING_PROVIDER;\n',
    );
    expect(messages.join("\n")).toMatch(/embed\.batch/);
  });

  it("a controller importing an adapter or the selector fails lint too", async () => {
    expect(await lintMessages("src/modules/prompts/prompts.controller.ts", 'import { OPENAI_EMBEDDINGS_ENDPOINT, OpenAiEmbeddingProvider } from "./adapters/openai-embedding-provider.js";\nexport const x = OpenAiEmbeddingProvider;\n')).not.toEqual([]);
    expect(await lintMessages("src/api/anything.ts", 'import { selectEmbeddingProvider } from "../modules/prompts/embedding-provider.selector.js";\nexport const x = selectEmbeddingProvider;\n')).not.toEqual([]);
  });

  it("the embed.batch handler itself may import the port", async () => {
    expect(
      await lintMessages(
        "src/lib/queue/handlers/embed-batch.handler.ts",
        'import type { EmbeddingProvider } from "../../../modules/prompts/ports/embedding-provider.js";\nexport type X = EmbeddingProvider;\n',
      ),
    ).toEqual([]);
  });
});

describe("STORY-133 · scenario 17 — no numeric loop over embeddings in application code", () => {
  const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
  // The consumers: the handler, the request helper and L2. The provider adapters PRODUCE vectors and are not consumers.
  const consumers = ["src/lib/queue/handlers/embed-batch.handler.ts", "src/lib/embedding/embed-batch.ts", "src/lib/embedding/prompt-embedding-request.ts", "src/lib/capture/l2-semantic-reuse.ts"];

  it.each(consumers)("%s does no vector arithmetic: no dot product, norm, cosine or index loop", (path) => {
    const source = read(path).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toMatch(/Math\.(sqrt|acos|hypot|abs)\s*\(/);
    expect(source).not.toMatch(/\bfor\s*\([^)]*\b(vector|embedding|vec)\w*\s*\[/i);
    expect(source).not.toMatch(/\.(reduce)\s*\([^)]*\*/);
    expect(source).not.toMatch(/\b(dot|norm|cosine)\w*\s*\(/i);
  });

  it("the handler hands vectors to SQL as text and compares nothing itself", () => {
    expect(read("src/lib/queue/handlers/embed-batch.handler.ts")).toMatch(/::halfvec/);
  });
});
