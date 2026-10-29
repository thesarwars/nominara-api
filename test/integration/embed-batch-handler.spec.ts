import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { UnrecoverableError, type Job } from "bullmq";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { EMBED_PROVIDER_BATCH_SIZE, embedBatchKey } from "../../src/lib/embedding/embed-batch.js";
import { embedBatchPayloadSchema } from "../../src/lib/embedding/embed-batch.js";
import { requestPromptEmbeddings, type EnqueueEmbedBatch } from "../../src/lib/embedding/prompt-embedding-request.js";
import { cellKey, probeSemanticReuse, type L2Candidate } from "../../src/lib/capture/l2-semantic-reuse.js";
import { lockNodeScope } from "../../src/lib/geo/alignment/scope-lock.js";
import { createEmbedBatchHandler } from "../../src/lib/queue/handlers/embed-batch.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { CircuitBreaker } from "../../src/lib/resilience/circuit-breaker.js";
import { resolveBillingPeriod } from "../../src/lib/usage/billing-period.js";
import { OpenAiEmbeddingProvider } from "../../src/modules/prompts/adapters/openai-embedding-provider.js";
import { StandInEmbeddingProvider, STAND_IN_EMBEDDING_MODEL } from "../../src/modules/prompts/adapters/stand-in-embedding-provider.js";
import { EmbeddingProviderError, type EmbeddingBatchResult, type EmbeddingProvider } from "../../src/modules/prompts/ports/embedding-provider.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-133 - the embed.batch handler against real Postgres + pgvector.
//
// The provider is the deterministic STAND-IN behind the port (owner decision 2026-10-28 #1), or a scripted wrapper around it that
// counts calls and fails on demand. Nothing here touches a network. The one acceptance criterion this file CANNOT close is
// "L2 fires against a REAL embedding": the vectors below come from the stand-in, so scenario 9 proves the pipeline (handler ->
// column -> L2 probe) and not the model. The real adapter plus one run of scenario 9 against it closes that AC.

const KEYS = { current: { kid: "k1", key: Buffer.from("embed-batch-test-signing-key-32by") } };
const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "embed.batch")!;

class CountingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions = 1536;
  readonly calls: string[][] = [];
  failWith: (() => Error | undefined) | undefined;
  private readonly inner = new StandInEmbeddingProvider();
  constructor(model = STAND_IN_EMBEDDING_MODEL) {
    this.model = model;
  }
  async embed(texts: readonly string[]): Promise<EmbeddingBatchResult> {
    const failure = this.failWith?.();
    if (failure) throw failure;
    this.calls.push([...texts]);
    const result = await this.inner.embed(texts);
    return { ...result, model: this.model };
  }
}

describe("STORY-133 · embed.batch", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query(
      "TRUNCATE usage_ledger, usage_counters, content_chunks, corpus_passages, answer_captures, tracked_prompts, capture_runs, projects, workspaces CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, 'P', $3, 'https://example.test', 'example.test')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  // ---- fixtures ---------------------------------------------------------------------------------------------------------

  async function addPrompt(text: string, over: { status?: string } = {}): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', $6)`,
      [id, workspaceId, projectId, text, Buffer.from(text, "utf8"), over.status ?? "active"],
    );
    return id;
  }

  async function addPrompts(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) ids.push(await addPrompt(`how do teams compare option number ${String(i)} for reporting`));
    return ids;
  }

  async function addChunk(text: string, over: { model?: string | null; vector?: boolean; isDraft?: boolean; hash?: Buffer } = {}): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO content_chunks (id, workspace_id, project_id, url, chunk_index, text, token_count, content_hash, embedding_model, embedding, is_draft)
       VALUES ($1, $2, $3, 'https://example.test/a', 0, $4, 10, $5, $6, $7::halfvec, $8)`,
      [
        id,
        workspaceId,
        projectId,
        text,
        over.hash ?? createHash("sha256").update(text).digest(),
        over.model ?? null,
        over.vector === true ? `[${["1", ...new Array<string>(1535).fill("0")].join(",")}]` : null,
        over.isDraft ?? false,
      ],
    );
    return id;
  }

  function handler(provider: EmbeddingProvider, breaker?: CircuitBreaker) {
    const context = { pool: undefined, env: { NODE_ENV: "test" } } as unknown as QueueHandlerContext;
    return createEmbedBatchHandler(context, { provider, ...(breaker === undefined ? {} : { breaker }) });
  }

  function job(ids: string[], table = "tracked_prompts"): Job {
    const payload = embedBatchPayloadSchema.parse({ workspaceId, kid: "k1", table, ids });
    return { data: signQueueJobPayload(payload, KEYS.current.key) } as unknown as Job;
  }

  /** The handler as the worker runs it: verified, then the ADR-0003 split into two short tenant transactions around the provider. */
  async function runAsWorker(h: ReturnType<typeof handler>, j: Job): Promise<unknown> {
    const process = createJobProcessor(ENTRY, {
      keys: KEYS,
      getClient: () => pool.connect(),
      releaseClient: (client) => (client as PoolClient).release(),
      process: h,
    });
    return process(j);
  }

  async function vectorState(ids: string[]): Promise<{ id: string; has_vector: boolean; embedding_model: string | null }[]> {
    const r = await db.query<{ id: string; has_vector: boolean; embedding_model: string | null }>(
      "SELECT id, embedding IS NOT NULL AS has_vector, embedding_model FROM tracked_prompts WHERE id = ANY($1::uuid[]) ORDER BY id",
      [ids],
    );
    return r.rows;
  }

  async function seedCounter(limit: number, used = 0): Promise<string> {
    const period = await resolveBillingPeriod(db, workspaceId);
    await db.query(
      `INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value, billable)
       VALUES ($1, 'embed_tokens', $2, $3, $4, false)`,
      [workspaceId, period.start, limit, used],
    );
    return period.start;
  }

  async function usedTokens(): Promise<number | undefined> {
    const r = await db.query<{ used_value: string }>("SELECT used_value FROM usage_counters WHERE workspace_id = $1 AND metric = 'embed_tokens'", [workspaceId]);
    return r.rows[0] === undefined ? undefined : Number(r.rows[0].used_value);
  }

  // ---- batching ---------------------------------------------------------------------------------------------------------

  it("scenario 1 - 96 texts in one job make exactly one provider call", async () => {
    const provider = new CountingProvider();
    const ids = await addPrompts(96);
    await runAsWorker(handler(provider), job(ids));
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toHaveLength(96);
    expect((await vectorState(ids)).every((row) => row.has_vector)).toBe(true);
  }, 60_000);

  it("scenario 2 - 97 texts make two calls, no text dropped or duplicated", async () => {
    const provider = new CountingProvider();
    const ids = await addPrompts(97);
    await runAsWorker(handler(provider), job(ids));
    expect(provider.calls.map((call) => call.length)).toEqual([EMBED_PROVIDER_BATCH_SIZE, 1]);
    const sent = provider.calls.flat();
    expect(new Set(sent).size).toBe(97);
    expect((await vectorState(ids)).filter((row) => row.has_vector)).toHaveLength(97);
  }, 60_000);

  it("scenario 3 - one text still goes through the batch path, in one call", async () => {
    const provider = new CountingProvider();
    const [id] = await addPrompts(1);
    await runAsWorker(handler(provider), job([id!]));
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toHaveLength(1);
  }, 60_000);

  // ---- idempotency, L7 --------------------------------------------------------------------------------------------------

  it("scenario 4 - the same batch redelivered writes the same vectors, makes ZERO further calls and meters nothing more", async () => {
    await seedCounter(-1);
    const provider = new CountingProvider();
    const ids = await addPrompts(3);
    const h = handler(provider);
    await runAsWorker(h, job(ids));
    const first = await db.query("SELECT id, embedding::text AS v FROM tracked_prompts WHERE id = ANY($1::uuid[]) ORDER BY id", [ids]);
    const tokensAfterFirst = await usedTokens();
    expect(tokensAfterFirst).toBeGreaterThan(0);

    await runAsWorker(h, job([...ids].reverse()));

    expect(provider.calls).toHaveLength(1);
    expect(await usedTokens()).toBe(tokensAfterFirst);
    const second = await db.query("SELECT id, embedding::text AS v FROM tracked_prompts WHERE id = ANY($1::uuid[]) ORDER BY id", [ids]);
    expect(second.rows).toEqual(first.rows);
    // And the producer's key is the same for the reordered batch.
    expect(embedBatchKey("tracked_prompts", ids)).toBe(embedBatchKey("tracked_prompts", [...ids].reverse()));
  }, 60_000);

  it("scenario 5 - L7: a chunk whose content_hash already holds a vector is never sent to the provider", async () => {
    const provider = new CountingProvider();
    const hash = createHash("sha256").update("shared chunk body").digest();
    // The stored sibling (a LIVE chunk) and the new row (a DRAFT of the same text): same content, so the vector is reused.
    const stored = await addChunk("shared chunk body", { model: STAND_IN_EMBEDDING_MODEL, vector: true, hash, isDraft: false });
    const fresh = await addChunk("shared chunk body", { hash, isDraft: true });

    await runAsWorker(handler(provider), job([fresh], "content_chunks"));

    expect(provider.calls, "L7 happens BEFORE the provider call").toHaveLength(0);
    const rows = await db.query<{ id: string; model: string | null; same: boolean }>(
      `SELECT c.id, c.embedding_model AS model, c.embedding = s.embedding AS same
         FROM content_chunks c, content_chunks s WHERE c.id = $1 AND s.id = $2`,
      [fresh, stored],
    );
    expect(rows.rows[0]).toMatchObject({ model: STAND_IN_EMBEDDING_MODEL, same: true });
  }, 60_000);

  it("scenario 5 - L7 sends identical texts inside one batch once", async () => {
    const provider = new CountingProvider();
    const a = await addPrompt("first distinct wording about crm");
    const b = await addPrompt("second distinct wording about invoicing");
    await db.query("UPDATE tracked_prompts SET text = 'first distinct wording about crm', text_hash = sha256('other'::bytea) WHERE id = $1", [b]);
    await runAsWorker(handler(provider), job([a, b]));
    expect(provider.calls.flat()).toEqual(["first distinct wording about crm"]);
    expect((await vectorState([a, b])).every((row) => row.has_vector)).toBe(true);
  }, 60_000);

  it("a chunk whose key an embedded sibling already holds is a duplicate: not sent, not overwritten", async () => {
    const provider = new CountingProvider();
    const hash = createHash("sha256").update("dup").digest();
    await addChunk("dup", { model: STAND_IN_EMBEDDING_MODEL, vector: true, hash });
    const duplicate = await addChunk("dup", { hash });
    await runAsWorker(handler(provider), job([duplicate], "content_chunks"));
    expect(provider.calls).toHaveLength(0);
  }, 60_000);

  // ---- failure ----------------------------------------------------------------------------------------------------------

  it("scenario 6 - a 429 then success: retried, one set of vectors, tokens counted once", async () => {
    await seedCounter(-1);
    const provider = new CountingProvider();
    const ids = await addPrompts(2);
    const h = handler(provider);
    let first = true;
    provider.failWith = () => {
      if (!first) return undefined;
      first = false;
      return new EmbeddingProviderError("rate limited", { status: 429, retryable: true });
    };

    await expect(runAsWorker(h, job(ids))).rejects.toThrow();
    expect((await vectorState(ids)).some((row) => row.has_vector)).toBe(false);
    expect(await usedTokens()).toBe(0);

    await runAsWorker(h, job(ids));
    expect(provider.calls).toHaveLength(1);
    expect((await vectorState(ids)).every((row) => row.has_vector)).toBe(true);
    const spent = await db.query<{ q: string }>("SELECT sum(quantity)::text AS q FROM usage_ledger WHERE metric = 'embed_tokens'");
    expect(Number(spent.rows[0]!.q)).toBe(await usedTokens());
  }, 60_000);

  it("scenario 7 - a provider that fails after one batch succeeded leaves NO partial vectors, and the spend is still metered", async () => {
    await seedCounter(-1);
    const provider = new CountingProvider();
    const ids = await addPrompts(97);
    let calls = 0;
    provider.failWith = () => {
      calls += 1;
      return calls === 2 ? new EmbeddingProviderError("boom", { status: 500, retryable: true }) : undefined;
    };

    await expect(runAsWorker(handler(provider), job(ids))).rejects.toThrow(/embed\.batch provider failure/);

    expect((await vectorState(ids)).some((row) => row.has_vector), "no partial batch").toBe(false);
    expect(provider.calls).toHaveLength(1);
    // The first call really was charged; the discarded attempt's spend is not invisible.
    expect(await usedTokens()).toBeGreaterThan(0);
  }, 60_000);

  it("scenario 7 - every attempt failing writes nothing and meters nothing", async () => {
    await seedCounter(-1);
    const provider = new CountingProvider();
    const ids = await addPrompts(2);
    provider.failWith = () => new EmbeddingProviderError("down", { status: 503, retryable: true });
    const h = handler(provider);
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(runAsWorker(h, job(ids))).rejects.toThrow();
    expect((await vectorState(ids)).some((row) => row.has_vector)).toBe(false);
    expect(await usedTokens()).toBe(0);
  }, 60_000);

  it("scenario 8 - an open circuit: no provider call, vectors stay NULL, and L2 simply finds no hit", async () => {
    const provider = new CountingProvider();
    const breaker = new CircuitBreaker({ name: "embedding-provider" });
    breaker.forceOpen();
    const [target, source] = await addPrompts(2);
    await expect(runAsWorker(handler(provider, breaker), job([target!, source!]))).rejects.toThrow(/embed\.batch provider failure/);
    expect(provider.calls).toHaveLength(0);

    // The capture run is unaffected: the planner's probe reads NULL embeddings and returns no hit, rather than erroring.
    const candidate: L2Candidate = { promptId: target!, engineKey: "perplexity", sampleIndex: 0, ttlSeconds: 86_400 };
    const hits = await probeSemanticReuse(db, { workspaceId, projectId }, [candidate]);
    expect(hits.size).toBe(0);
  }, 60_000);

  // ---- the model --------------------------------------------------------------------------------------------------------

  it("scenario 12 - embedding_model is written beside every vector and equals the configured model", async () => {
    const provider = new CountingProvider("pinned-model-v1");
    const ids = await addPrompts(2);
    await runAsWorker(handler(provider), job(ids));
    expect((await vectorState(ids)).map((row) => row.embedding_model)).toEqual(["pinned-model-v1", "pinned-model-v1"]);
  }, 60_000);

  it("scenario 12 - and a model that differs from the one the provider announced is refused, never stored", async () => {
    const provider = new CountingProvider("pinned-model-v1");
    const lying = new CountingProvider("pinned-model-v1");
    const embed = lying.embed.bind(lying);
    lying.embed = async (texts) => ({ ...(await embed(texts)), model: "some-other-model" });
    const ids = await addPrompts(1);
    await expect(runAsWorker(handler(lying), job(ids))).rejects.toThrow();
    expect((await vectorState(ids))[0]!.has_vector).toBe(false);
    void provider;
  }, 60_000);

  it("scenario 13 - rows under two models cannot share a key: ux_content_chunks includes the model", async () => {
    const hash = createHash("sha256").update("same text").digest();
    await addChunk("same text", { model: "model-a", vector: true, hash });
    await addChunk("same text", { model: "model-b", vector: true, hash });
    await expect(addChunk("same text", { model: "model-a", vector: true, hash })).rejects.toThrow(/ux_content_chunks/);
  }, 60_000);

  it("a corpus passage stored under another model is not this job's to embed", async () => {
    const provider = new CountingProvider();
    const id = randomUUID();
    await db.query(
      `INSERT INTO corpus_passages (id, workspace_id, project_id, citation_url_hash, url, domain, passage_index, text, token_count, content_hash, embedding_model, expires_at)
       VALUES ($1, $2, $3, sha256('u'::bytea), 'https://x.test/a', 'x.test', 0, 'cited passage', 3, sha256('p'::bytea), 'legacy-model', now() + interval '30 days')`,
      [id, workspaceId, projectId],
    );
    await runAsWorker(handler(provider), job([id], "corpus_passages"));
    expect(provider.calls).toHaveLength(0);
  }, 60_000);

  it("a corpus passage under the configured model is embedded", async () => {
    const provider = new CountingProvider();
    const id = randomUUID();
    await db.query(
      `INSERT INTO corpus_passages (id, workspace_id, project_id, citation_url_hash, url, domain, passage_index, text, token_count, content_hash, embedding_model, expires_at)
       VALUES ($1, $2, $3, sha256('u'::bytea), 'https://x.test/a', 'x.test', 0, 'cited passage', 3, sha256('p'::bytea), $4, now() + interval '30 days')`,
      [id, workspaceId, projectId, STAND_IN_EMBEDDING_MODEL],
    );
    await runAsWorker(handler(provider), job([id], "corpus_passages"));
    const row = await db.query<{ has: boolean }>("SELECT embedding IS NOT NULL AS has FROM corpus_passages WHERE id = $1", [id]);
    expect(row.rows[0]!.has).toBe(true);
  }, 60_000);

  // ---- STORY-059: the semantic_nodes path -------------------------------------------------------------------------------

  async function addNode(phrase: string, cluster: string | null = null): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO semantic_nodes (id, workspace_id, project_id, prompt_cluster_id, phrase, phrase_normalized, node_type, corpus_doc_ratio, evidence_url, evidence_snippet)
       VALUES ($1, $2, $3, $4, $5, $5, 'capability', 0.5, 'https://doc.example/p', $5)`,
      [id, workspaceId, projectId, cluster, phrase],
    );
    return id;
  }

  it("STORY-059 review round 3 - a semantic_nodes job redelivered makes ZERO provider calls, adds no usage_ledger row, and leaves the vector unchanged", async () => {
    const provider = new CountingProvider();
    const ids = [await addNode("audit logging"), await addNode("single sign on")];
    const h = handler(provider);
    await runAsWorker(h, job(ids, "semantic_nodes"));
    const ledger = async (): Promise<number> => Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM usage_ledger WHERE workspace_id = $1", [workspaceId])).rows[0]!.n);
    const vectors = async () => (await db.query("SELECT id, embedding::text AS v, embedding_model FROM semantic_nodes WHERE id = ANY($1::uuid[]) ORDER BY id", [ids])).rows;
    const first = await vectors();
    expect(first.every((row) => row.v !== null && row.embedding_model === STAND_IN_EMBEDDING_MODEL)).toBe(true);
    expect(provider.calls).toHaveLength(1);
    const ledgerAfterFirst = await ledger();
    expect(ledgerAfterFirst).toBeGreaterThan(0);

    await runAsWorker(h, job([...ids].reverse(), "semantic_nodes"));

    expect(provider.calls, "no further provider call").toHaveLength(1);
    expect(await ledger(), "no new usage_ledger row").toBe(ledgerAfterFirst);
    expect(await vectors(), "the vector is unchanged").toEqual(first);
  }, 60_000);

  it("STORY-059 review round 3 - the semantic_nodes write takes the scope lock, so it cannot interleave with an analysis of the same (project, cluster)", async () => {
    const provider = new CountingProvider();
    const cluster = randomUUID();
    const ids = [await addNode("audit logging", cluster), await addNode("single sign on", cluster)];
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await lockNodeScope(holder, projectId, cluster); // an analysis of this scope is mid-flight
      let settled = false;
      const running = runAsWorker(handler(provider), job(ids, "semantic_nodes")).then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(settled, "the write waits for the scope's lock").toBe(false);
      expect((await db.query("SELECT count(*) AS n FROM semantic_nodes WHERE embedding IS NOT NULL")).rows[0]!.n).toBe("0");
      await holder.query("COMMIT");
      await running;
      expect((await db.query("SELECT count(*) AS n FROM semantic_nodes WHERE embedding IS NOT NULL")).rows[0]!.n).toBe("2");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  }, 60_000);

  // ---- metering never gates ---------------------------------------------------------------------------------------------

  it("scenario 14 - embed_tokens at or over its ceiling: the job still succeeds and the overage is visible", async () => {
    await seedCounter(10, 10);
    const provider = new CountingProvider();
    const ids = await addPrompts(2);
    await runAsWorker(handler(provider), job(ids));
    expect((await vectorState(ids)).every((row) => row.has_vector)).toBe(true);
    expect(await usedTokens()).toBeGreaterThan(10);
  }, 60_000);

  it("scenario 14 - an ABSENT counter row cannot fail the job, and the spend still lands in the usage ledger", async () => {
    const provider = new CountingProvider();
    const ids = await addPrompts(2);
    await runAsWorker(handler(provider), job(ids));
    expect((await vectorState(ids)).every((row) => row.has_vector)).toBe(true);
    const ledger = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM usage_ledger WHERE metric = 'embed_tokens' AND workspace_id = $1", [workspaceId]);
    expect(Number(ledger.rows[0]!.n)).toBe(1);
  }, 60_000);

  it("records the provider-reported token count, not an estimate", async () => {
    await seedCounter(-1);
    const provider = new CountingProvider();
    const inner = provider.embed.bind(provider);
    provider.embed = async (texts) => ({ ...(await inner(texts)), totalTokens: 4242 });
    const [id] = await addPrompts(1);
    await runAsWorker(handler(provider), job([id!]));
    expect(await usedTokens()).toBe(4242);
  }, 60_000);

  // ---- review round 1: permanent failures, model switch, defence in depth ------------------------------------------------

  it("a NON-retryable provider failure is an UnrecoverableError: one attempt, not the whole retry ladder", async () => {
    const provider = new CountingProvider();
    const ids = await addPrompts(2);
    provider.failWith = () => new EmbeddingProviderError("bad request", { status: 400, retryable: false });
    const failure = await runAsWorker(handler(provider), job(ids)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnrecoverableError);
    expect((failure as Error).message).toMatch(/embed\.batch provider failure/);
    expect((await vectorState(ids)).some((row) => row.has_vector)).toBe(false);
  }, 60_000);

  it("a RETRYABLE provider failure is not unrecoverable: it rides the retry ladder", async () => {
    const provider = new CountingProvider();
    provider.failWith = () => new EmbeddingProviderError("down", { status: 503, retryable: true });
    const failure = await runAsWorker(handler(provider), job(await addPrompts(1))).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(UnrecoverableError);
  }, 60_000);

  it("a paid-for response that does not match the request is permanent, and the spend is still metered", async () => {
    await seedCounter(-1);
    const lying = new CountingProvider("pinned-model-v1");
    const embed = lying.embed.bind(lying);
    lying.embed = async (texts) => ({ ...(await embed(texts)), model: "some-other-model" });
    const failure = await runAsWorker(handler(lying), job(await addPrompts(1))).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnrecoverableError);
    expect(await usedTokens(), "the discarded call was still charged").toBeGreaterThan(0);
  }, 60_000);

  it("EC-23 - prompt vectors written under ANOTHER model (the stand-in) are re-embedded when the configured model changes", async () => {
    const id = await addPrompt("a prompt the stand-in embedded earlier");
    await runAsWorker(handler(new CountingProvider("stand-in-model")), job([id]));
    expect((await vectorState([id]))[0]!.embedding_model).toBe("stand-in-model");

    const real = new CountingProvider("real-model");
    await runAsWorker(handler(real), job([id]));
    expect(real.calls, "the stale vector is replaced, not compared against").toHaveLength(1);
    expect((await vectorState([id]))[0]!.embedding_model).toBe("real-model");

    // And a redelivery under the same model is a no-op again.
    await runAsWorker(handler(real), job([id]));
    expect(real.calls).toHaveLength(1);
  }, 60_000);

  it("defence in depth - even with RLS bypassed (superuser), a job signed for A cannot embed a prompt of workspace B", async () => {
    const otherWs = randomUUID();
    const otherProject = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'Other', $2, 'growth')", [otherWs, `o-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, 'P', $3, 'https://other.test', 'other.test')`,
      [otherProject, otherWs, `p-${randomUUID().slice(0, 8)}`],
    );
    const foreign = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status)
       VALUES ($1, $2, $3, 'foreign prompt', sha256('foreign prompt'::bytea), 'recommendation', 'consideration', 'active')`,
      [foreign, otherWs, otherProject],
    );
    const provider = new CountingProvider();
    const own = await addPrompt("my own prompt");
    await runAsWorker(handler(provider), job([own, foreign]));
    expect(provider.calls.flat()).toEqual(["my own prompt"]);
    expect((await vectorState([foreign]))[0]).toMatchObject({ has_vector: false, embedding_model: null });
  }, 60_000);

  // ---- the producer -----------------------------------------------------------------------------------------------------

  it("scenario 16 - a committed activation queues an embed job for the prompt; a rolled-back one leaves no orphan", async () => {
    const enqueued: { key: string; payload: Record<string, unknown> }[] = [];
    const enqueue: EnqueueEmbedBatch = async (_queue, _ws, payload, key) => {
      enqueued.push({ key, payload });
    };
    const logger = { log: vi.fn(), error: vi.fn() };
    const [committedId, rolledBackId] = await addPrompts(2);

    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      await requestPromptEmbeddings(tx as unknown as Parameters<typeof requestPromptEmbeddings>[0], workspaceId, [committedId!], enqueue, logger);
      expect(enqueued, "nothing is enqueued before COMMIT").toHaveLength(0);
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.payload).toEqual({ table: "tracked_prompts", ids: [committedId] });
    expect(enqueued[0]!.key).toBe(embedBatchKey("tracked_prompts", [committedId!]));

    enqueued.length = 0;
    await expect(
      withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await requestPromptEmbeddings(tx as unknown as Parameters<typeof requestPromptEmbeddings>[0], workspaceId, [rolledBackId!], enqueue, logger);
        throw new Error("activation refused after the embedding request");
      }),
    ).rejects.toThrow(/activation refused/);
    await new Promise((resolve) => setImmediate(resolve));
    expect(enqueued, "a rolled-back activation leaves no orphan job").toHaveLength(0);
  }, 60_000);

  it("the request skips prompts that are archived or already embedded", async () => {
    const enqueued: string[] = [];
    const enqueue: EnqueueEmbedBatch = async (_q, _w, payload) => {
      enqueued.push(...(payload.ids as string[]));
    };
    const active = await addPrompt("an active prompt about crm tools");
    const archived = await addPrompt("an archived prompt about crm tools", { status: "archived" });
    const embedded = await addPrompt("an embedded prompt about crm tools");
    await db.query("UPDATE tracked_prompts SET embedding = $2::halfvec, embedding_model = 'm' WHERE id = $1", [embedded, `[${["1", ...new Array<string>(1535).fill("0")].join(",")}]`]);
    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
      requestPromptEmbeddings(tx as unknown as Parameters<typeof requestPromptEmbeddings>[0], workspaceId, [active, archived, embedded], enqueue, { log: vi.fn(), error: vi.fn() }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(enqueued).toEqual([active]);
  }, 60_000);

  // ---- L2 against pipeline vectors (the stand-in, NOT a real model) -----------------------------------------------------

  const BASE = "which project management tool is best for a remote marketing team that needs reporting and client approvals every week";

  async function cosineBetween(a: string, b: string): Promise<number> {
    const r = await db.query<{ c: number }>("SELECT 1 - (x.embedding <=> y.embedding) AS c FROM tracked_prompts x, tracked_prompts y WHERE x.id = $1 AND y.id = $2", [a, b]);
    return Number(r.rows[0]!.c);
  }

  async function addCapture(promptId: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash, status, cache_layer)
       VALUES ($1, $2, $3, $4, $5, 'perplexity', now() - interval '60 seconds', 'api', '1.0.0', 'v1', sha256('x'::bytea), 'parsed', 'live')`,
      [id, workspaceId, projectId, randomUUID(), promptId],
    );
    return id;
  }

  async function l2Hits(target: string): Promise<number> {
    const candidate: L2Candidate = { promptId: target, engineKey: "perplexity", sampleIndex: 0, ttlSeconds: 86_400 };
    const hits = await probeSemanticReuse(db, { workspaceId, projectId }, [candidate]);
    void cellKey;
    return hits.size;
  }

  it("scenario 9 - L2 suppresses a near-duplicate whose vectors came through embed.batch (stand-in vectors, not a real model)", async () => {
    const source = await addPrompt(BASE);
    const target = await addPrompt(BASE.replace("best", "ideal"));
    await addCapture(source);
    const provider = new CountingProvider();
    await runAsWorker(handler(provider), job([source, target]));

    expect(await cosineBetween(source, target)).toBeGreaterThanOrEqual(0.94);
    expect(await l2Hits(target), "the first real hit this layer has ever had").toBe(1);
  }, 60_000);

  it("scenario 10 (the L2 half) - a pair below 0.94 is NOT suppressed by L2", async () => {
    const source = await addPrompt(BASE);
    // Three words changed of twenty-one: well under the threshold.
    const target = await addPrompt(BASE.replace("best", "ideal").replace("remote", "hybrid").replace("weekly", "monthly").replace("every week", "every month"));
    await addCapture(source);
    await runAsWorker(handler(new CountingProvider()), job([source, target]));
    const cosine = await cosineBetween(source, target);
    expect(cosine).toBeLessThan(0.94);
    expect(await l2Hits(target)).toBe(0);
  }, 60_000);

  it("a prompt that was never embedded is kept out of the suppression decision, not compared as a zero vector", async () => {
    const source = await addPrompt(BASE);
    const target = await addPrompt(BASE.replace("best", "ideal"));
    await addCapture(source);
    await runAsWorker(handler(new CountingProvider()), job([source]));
    expect(await l2Hits(target)).toBe(0);
  }, 60_000);
});

// STORY-133 - the ONE acceptance criterion this suite cannot close in CI ("L2 fires against a REAL embedding"). Opt-in: it runs
// only when OPENAI_API_KEY is set, makes real, paid provider calls, and is therefore excluded from every CI run. Flipping the AC =
// export the key + `pnpm test:integration -- embed-batch-handler`; no code change.
describe.runIf(Boolean(process.env.OPENAI_API_KEY))("STORY-133 · scenario 9/10 against the REAL OpenAI embedding (opt-in, needs OPENAI_API_KEY)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 300_000);
  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  async function seed(texts: string[]): Promise<{ workspaceId: string; projectId: string; ids: string[] }> {
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, 'P', $3, 'https://example.test', 'example.test')`, [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`]);
    const ids: string[] = [];
    for (const text of texts) {
      const id = randomUUID();
      ids.push(id);
      await db.query(
        `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status)
         VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', 'active')`,
        [id, workspaceId, projectId, text, Buffer.from(text, "utf8")],
      );
    }
    return { workspaceId, projectId, ids };
  }

  async function embedAll(workspaceId: string, ids: string[]): Promise<void> {
    const context = { pool: undefined, env: { NODE_ENV: "test" } } as unknown as QueueHandlerContext;
    const process = createJobProcessor(ENTRY, {
      keys: KEYS,
      getClient: () => pool.connect(),
      releaseClient: (client) => (client as PoolClient).release(),
      process: createEmbedBatchHandler(context, { provider: new OpenAiEmbeddingProvider({ apiKey: openAiKey() }) }),
    });
    const payload = embedBatchPayloadSchema.parse({ workspaceId, kid: "k1", table: "tracked_prompts", ids });
    await process({ data: signQueueJobPayload(payload, KEYS.current.key) } as unknown as Job);
  }

  const L2_SOURCE = "which project management tool is best for a remote marketing team that needs reporting and client approvals every week";

  async function l2Hits(workspaceId: string, projectId: string, source: string, target: string): Promise<{ cosine: number; hits: number }> {
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash, status, cache_layer)
       VALUES ($1, $2, $3, $4, $5, 'perplexity', now() - interval '60 seconds', 'api', '1.0.0', 'v1', sha256('x'::bytea), 'parsed', 'live')`,
      [randomUUID(), workspaceId, projectId, randomUUID(), source],
    );
    const cosine = Number((await db.query<{ c: number }>("SELECT 1 - (x.embedding <=> y.embedding) AS c FROM tracked_prompts x, tracked_prompts y WHERE x.id = $1 AND y.id = $2", [source, target])).rows[0]!.c);
    const hits = await probeSemanticReuse(db, { workspaceId, projectId }, [{ promptId: target, engineKey: "perplexity", sampleIndex: 0, ttlSeconds: 86_400 }]);
    return { cosine, hits: hits.size };
  }

  it("scenario 9 (REAL model) - a paraphrase of the same question scores >= 0.94 and L2 suppresses it", async () => {
    const { workspaceId, projectId, ids } = await seed([L2_SOURCE, "what is the ideal project management tool for a remote marketing team that needs reporting and client approvals each week"]);
    await embedAll(workspaceId, ids);
    const result = await l2Hits(workspaceId, projectId, ids[0]!, ids[1]!);
    expect(result.cosine).toBeGreaterThanOrEqual(0.94);
    expect(result.hits).toBe(1);
  }, 120_000);

  it("scenario 10 (REAL model) - a different question about the same product stays under 0.94 and L2 does not suppress it", async () => {
    const { workspaceId, projectId, ids } = await seed([L2_SOURCE, "how much does a project management tool cost per seat for a ten person agency"]);
    await embedAll(workspaceId, ids);
    const result = await l2Hits(workspaceId, projectId, ids[0]!, ids[1]!);
    expect(result.cosine).toBeLessThan(0.94);
    expect(result.hits).toBe(0);
  }, 120_000);
});

function openAiKey(): string {
  return process.env.OPENAI_API_KEY ?? "";
}
