import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { embedBatchPayloadSchema } from "../../src/lib/embedding/embed-batch.js";
import { buildCorpus, type CorpusBuildDeps } from "../../src/lib/geo/corpus/build-corpus.js";
import { computeCentroid } from "../../src/lib/geo/corpus/centroid.js";
import type { PageFetcher, PageFetchResult } from "../../src/lib/geo/corpus/page-fetcher.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createEmbedBatchHandler } from "../../src/lib/queue/handlers/embed-batch.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { StandInEmbeddingProvider, STAND_IN_EMBEDDING_MODEL } from "../../src/modules/prompts/adapters/stand-in-embedding-provider.js";
import type { EmbeddingBatchResult, EmbeddingProvider } from "../../src/modules/prompts/ports/embedding-provider.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-058 - the corpus builder and the SQL centroid, against real Postgres + pgvector, under the RUNTIME role (RLS in force).
//
// The embedding provider is the deterministic STAND-IN behind the STORY-133 port (owner decision 2026-10-28 #1), driven through the
// REAL embed.batch handler. What this file therefore cannot prove is that the centroid is SEMANTICALLY right: the stand-in is a
// hashed bag of words. It proves the pipeline - selection, directive extraction, guarded fetch, chunking, lexical filter, dedupe,
// expiry, weighting, the one-statement centroid, disclosure and suppression - and the real model flips only the "means the right
// thing" half of AC7/AC9 (docs list in the story report).

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));

const KEYS = { current: { kid: "k1", key: Buffer.from("embed-batch-test-signing-key-32by") } };
const EMBED_ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "embed.batch")!;
const MODEL_B = "stand-in-model-b";

const words = { count: (text: string): number => (text.trim() === "" ? 0 : text.trim().split(/\s+/).length) };
const PROMPT_TEXTS = ["how do teams compare reporting tools", "best reporting tools for teams"];

class CountingProvider implements EmbeddingProvider {
  readonly dimensions = 1536;
  readonly sent: string[] = [];
  private readonly inner = new StandInEmbeddingProvider();
  constructor(readonly model: string) {}
  async embed(texts: readonly string[]): Promise<EmbeddingBatchResult> {
    this.sent.push(...texts);
    return { ...(await this.inner.embed(texts)), model: this.model };
  }
}

const articleHtml = (topic: string, nav = ""): string =>
  `<html><body><main>${nav}<h1>${topic} guide</h1><p>Teams compare reporting tools by ${topic} and export formats. Reporting tools differ in ${topic}.</p></main></body></html>`;

describe("STORY-058 - corpus passages and centroid", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let appDb: Client;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let clusterId: string;
  let txOpen = false;
  const enqueued: { workspaceId: string; payload: Record<string, unknown>; key: string }[] = [];
  const fetchCalls: string[] = [];
  let pages = new Map<string, PageFetchResult>();
  let fetchSawOpenTx = false;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    appDb = new Client({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password });
    await appDb.connect();
  }, 300_000);

  afterAll(async () => {
    await appDb.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE corpus_passages, geo_alignments, citation_facts, project_engines, tracked_prompts, usage_ledger, usage_counters, projects, workspaces CASCADE");
    [workspaceId, otherWorkspaceId, projectId, clusterId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [ws, `w-${randomUUID().slice(0, 8)}`]);
    }
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, 'P', $3, 'https://brand.test', 'brand.test')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query("INSERT INTO project_engines (workspace_id, project_id, engine_key, weight) VALUES ($1,$2,'perplexity',1.0), ($1,$2,'chatgpt',3.0)", [workspaceId, projectId]);
    enqueued.length = 0;
    fetchCalls.length = 0;
    pages = new Map();
    fetchSawOpenTx = false;
    txOpen = false;
  });

  // ---- fixtures ---------------------------------------------------------------------------------------------------------

  async function addPrompt(text: string, cluster: string | null = clusterId, ws = workspaceId, project = projectId): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status, cluster_id)
       VALUES ($1,$2,$3,$4, sha256($5::bytea), 'recommendation','consideration','active',$6)`,
      [id, ws, project, text, Buffer.from(text, "utf8"), cluster],
    );
    return id;
  }

  async function cite(
    promptId: string,
    url: string,
    over: { engine?: string; weight?: number; owned?: boolean; daysAgo?: number; fragment?: string; ws?: string; project?: string } = {},
  ): Promise<void> {
    const normalized = over.fragment === undefined ? url : `${url}#:~:text=${over.fragment}`;
    await db.query(
      `INSERT INTO citation_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url, url_hash, domain,
          is_owned, position_weight, text_fragment)
       VALUES ($1,$2,$3,$4,$5, now() - ($6::int * interval '1 day'), 1, $7, $7, $8, $9, $10, $11, $12)`,
      [
        over.ws ?? workspaceId, over.project ?? projectId, randomUUID(), promptId, over.engine ?? "perplexity", over.daysAgo ?? 1, normalized,
        createHash("sha256").update(normalized).digest(), new URL(url).hostname.replace(/^www\./, ""), over.owned ?? false, over.weight ?? 1, over.fragment ?? null,
      ],
    );
  }

  const fetchPage: PageFetcher = async (url) => {
    fetchSawOpenTx ||= txOpen;
    fetchCalls.push(url);
    return pages.get(url) ?? { kind: "failed", reason: "not_found" };
  };

  function deps(model = STAND_IN_EMBEDDING_MODEL, over: Partial<CorpusBuildDeps> = {}): CorpusBuildDeps {
    return {
      workspaceId,
      runInTx: async (fn) => {
        txOpen = true;
        try {
          return await withTenantContext(appDb, { workspaceId, actorId: SYSTEM_ACTOR_ID }, fn);
        } finally {
          txOpen = false;
        }
      },
      fetchPage,
      tokenizer: words,
      embeddingModel: model,
      enqueueEmbed: async (_queue, ws, payload, key) => {
        // Enqueue must happen AFTER the commit, never inside the transaction.
        expect(txOpen).toBe(false);
        enqueued.push({ workspaceId: ws, payload, key });
      },
      now: () => new Date(),
      ...over,
    };
  }

  const build = (model = STAND_IN_EMBEDDING_MODEL, over: Partial<CorpusBuildDeps> = {}) => buildCorpus(deps(model, over), { projectId, clusterId });

  /** Runs every queued embed job through the REAL embed.batch handler with the given provider. */
  async function drainEmbedQueue(provider: EmbeddingProvider): Promise<void> {
    const context = { pool: undefined, env: { NODE_ENV: "test" } } as unknown as QueueHandlerContext;
    const process = createJobProcessor(EMBED_ENTRY, { keys: KEYS, getClient: () => appDb, process: createEmbedBatchHandler(context, { provider }) });
    while (enqueued.length > 0) {
      const job = enqueued.shift()!;
      const payload = embedBatchPayloadSchema.parse({ ...job.payload, workspaceId: job.workspaceId, kid: "k1" });
      await process({ data: signQueueJobPayload(payload, KEYS.current.key) } as unknown as Job);
    }
  }

  async function passageRows(extra = "TRUE"): Promise<{ url: string; text: string; from_text_fragment: boolean; embedding_model: string; has_vector: boolean; citation_frequency: number; avg_position_weight: number; centroid_weight: number; passage_index: number; expires_at: Date }[]> {
    return (await db.query(`SELECT url, text, from_text_fragment, embedding_model, embedding IS NOT NULL AS has_vector, citation_frequency, avg_position_weight, centroid_weight, passage_index, expires_at
                              FROM corpus_passages WHERE ${extra} ORDER BY url, passage_index`)).rows;
  }

  async function addSession(model = STAND_IN_EMBEDDING_MODEL): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO geo_alignments (id, workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model) VALUES ($1,$2,$3,'https://brand.test/p',$4,'{chatgpt}',$5)`,
      [id, workspaceId, projectId, clusterId, model],
    );
    return id;
  }

  const centroidOf = (sessionId: string) => withTenantContext(appDb, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => computeCentroid(tx, sessionId));

  /** `n` distinct competitor pages, each with one cited passage. */
  async function seedPages(n: number, prefix = "site"): Promise<string[]> {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    const urls: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const url = `https://${prefix}${String(i)}.example/page`;
      urls.push(url);
      await cite(prompt, url);
      pages.set(url, { kind: "html", html: articleHtml(`topic${prefix}${String(i)}`) });
    }
    return urls;
  }

  // ---- candidates -------------------------------------------------------------------------------------------------------

  it("scenario 1 - AC1 - cited URLs are ranked by position x engine weight and the top 25 are kept", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    for (let i = 0; i < 30; i += 1) await cite(prompt, `https://rank${String(i).padStart(2, "0")}.example/p`, { weight: 1 - i * 0.01 });
    // one low-position page cited by the heavy engine outranks a high-position page from the light one (3.0 x 0.5 > 1.0 x 0.9)
    await cite(prompt, "https://heavy.example/p", { engine: "chatgpt", weight: 0.5 });
    await cite(prompt, "https://light.example/p", { engine: "perplexity", weight: 0.99 });
    for (const row of (await db.query<{ normalized_url: string }>("SELECT DISTINCT normalized_url FROM citation_facts")).rows) pages.set(row.normalized_url, { kind: "html", html: articleHtml("reporting") });
    const result = await build();
    expect(result.candidates).toBe(25);
    expect(fetchCalls).toHaveLength(25);
    expect(fetchCalls).toContain("https://heavy.example/p");
    expect(fetchCalls).not.toContain("https://rank29.example/p");
    expect(fetchCalls.indexOf("https://heavy.example/p")).toBeLessThan(fetchCalls.indexOf("https://rank05.example/p"));
  }, 60_000);

  it("scenario 1 - AC1 - only the cluster's prompts, only the last 90 days, only this workspace", async () => {
    const inCluster = await addPrompt(PROMPT_TEXTS[0]!);
    const elsewhere = await addPrompt("a prompt in another cluster", randomUUID());
    await cite(inCluster, "https://in.example/p");
    await cite(inCluster, "https://old.example/p", { daysAgo: 91 });
    await cite(inCluster, "https://edge.example/p", { daysAgo: 89 });
    await cite(elsewhere, "https://other-cluster.example/p");
    for (const url of ["https://in.example/p", "https://old.example/p", "https://edge.example/p", "https://other-cluster.example/p"]) pages.set(url, { kind: "html", html: articleHtml("reporting") });
    await build();
    expect(fetchCalls.sort()).toEqual(["https://edge.example/p", "https://in.example/p"]);
  }, 60_000);

  it("scenario 2 - AC2 - owned URLs are excluded at selection: flagged, root-domain, or flagged by any one citation", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://theirs.example/p");
    await cite(prompt, "https://mine.example/flagged", { owned: true });
    await cite(prompt, "https://brand.test/root-domain-page");
    await cite(prompt, "https://mixed.example/p");
    await cite(prompt, "https://mixed.example/p", { owned: true, engine: "chatgpt" });
    for (const url of ["https://theirs.example/p", "https://mine.example/flagged", "https://brand.test/root-domain-page", "https://mixed.example/p"]) pages.set(url, { kind: "html", html: articleHtml("reporting") });
    const result = await build();
    expect(fetchCalls).toEqual(["https://theirs.example/p"]);
    expect(result.candidates).toBe(1);
    expect((await passageRows()).map((row) => row.url)).toEqual(["https://theirs.example/p"]);
  }, 60_000);

  it("scenario 2 - AC2 - a page on one of the project's owned_domains that the parser did not flag is still excluded", async () => {
    await db.query("UPDATE projects SET owned_domains = ARRAY['mybrand-docs.test'] WHERE id = $1", [projectId]);
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://theirs.example/p");
    await cite(prompt, "https://mybrand-docs.test/p", { owned: false });
    await cite(prompt, "https://www.docs.mybrand-docs.test/p", { owned: false });
    await cite(prompt, "https://notmybrand-docs.test/p", { owned: false });
    for (const url of ["https://theirs.example/p", "https://mybrand-docs.test/p", "https://www.docs.mybrand-docs.test/p", "https://notmybrand-docs.test/p"]) pages.set(url, { kind: "html", html: articleHtml("reporting") });
    await build();
    expect(fetchCalls.sort()).toEqual(["https://notmybrand-docs.test/p", "https://theirs.example/p"]);
  }, 60_000);

  // ---- sourcing ---------------------------------------------------------------------------------------------------------

  it("scenario 3 - AC3 - a text directive is the passage, with NO page fetch", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://blocked.example/guide", { fragment: "Teams%20compare%20reporting%20tools%20by%20export%20format" });
    const result = await build();
    expect(fetchCalls).toEqual([]);
    expect(result.fromFragment).toBe(1);
    const rows = await passageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: "Teams compare reporting tools by export format", from_text_fragment: true, url: "https://blocked.example/guide" });
  }, 60_000);

  it("scenario 4 - AC4 - a citation without a directive is fetched through the fetcher, fragment-free", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://open.example/guide");
    pages.set("https://open.example/guide", { kind: "html", html: articleHtml("export formats") });
    const result = await build();
    expect(fetchCalls).toEqual(["https://open.example/guide"]);
    expect(result.fetched).toBe(1);
    const rows = await passageRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.from_text_fragment === false)).toBe(true);
  }, 60_000);

  it("scenario 4 - ADR-0003 - the page fetch never happens inside a transaction, and the embed job is enqueued after commit", async () => {
    await seedPages(3);
    await build();
    expect(fetchCalls).toHaveLength(3);
    expect(fetchSawOpenTx).toBe(false);
    expect(enqueued.length).toBeGreaterThan(0);
  }, 60_000);

  it("scenario 5 - AC4 - a URL the guard refuses yields no passage, is counted, and the build is explicitly partial", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "http://internal.example/admin");
    await cite(prompt, "https://fine.example/p");
    pages.set("http://internal.example/admin", { kind: "refused", reason: "address_not_global" });
    pages.set("https://fine.example/p", { kind: "html", html: articleHtml("reporting") });
    const result = await build();
    expect(result.refused).toBe(1);
    expect(result.status).toBe("partial");
    expect((await passageRows()).map((row) => row.url)).toEqual(["https://fine.example/p"]);
  }, 60_000);

  it("scenario 5 - a page that fails to fetch is a failure of that URL, not of the build", async () => {
    const urls = await seedPages(2);
    pages.set(urls[0]!, { kind: "failed", reason: "http_503" });
    const result = await build();
    expect(result.failed).toBe(1);
    expect(result.status).toBe("partial");
    expect((await passageRows()).map((row) => row.url)).toEqual([urls[1]]);
  }, 60_000);

  it("a clean build is status complete", async () => {
    await seedPages(2);
    expect((await build()).status).toBe("complete");
  }, 60_000);

  // ---- selection and dedupe ---------------------------------------------------------------------------------------------

  it("scenario 6 - AC6 - boilerplate chunks in the body are not stored; at most 3 passages per URL", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://heavy-nav.example/p");
    const filler = Array.from({ length: 6 }, (_, i) => `<h2>Section ${String(i)}</h2><p>Reporting tools help teams compare options ${"detail ".repeat(10)}${String(i)}.</p>`).join("");
    const nav = `<h2>Menu</h2><p>${"Home About Pricing Contact Login Careers Press Legal Cookies ".repeat(8)}</p>`;
    pages.set("https://heavy-nav.example/p", { kind: "html", html: `<html><body><main>${nav}${filler}</main></body></html>` });
    await build();
    const rows = await passageRows();
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.text).not.toContain("Careers");
  }, 60_000);

  it("scenario 7 - AC13 - the same passage on two URLs is stored once and embedded once", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://one.example/p");
    await cite(prompt, "https://two.example/p");
    const same = { kind: "html", html: articleHtml("identical") } as const;
    pages.set("https://one.example/p", same);
    pages.set("https://two.example/p", same);
    const provider = new CountingProvider(STAND_IN_EMBEDDING_MODEL);
    const result = await build();
    await drainEmbedQueue(provider);
    const rows = await passageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.has_vector).toBe(true);
    expect(provider.sent).toHaveLength(1);
    expect(result.passagesWritten).toBe(1);
  }, 60_000);

  it("scenario 7 - AC13 - syndicated text on two URLs of ONE cluster is deduplicated, not a conflict: a rebuild is complete", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://one.example/p");
    await cite(prompt, "https://two.example/p");
    const same = { kind: "html", html: articleHtml("identical") } as const;
    pages.set("https://one.example/p", same);
    pages.set("https://two.example/p", same);
    const first = await build();
    expect(first.status).toBe("complete");
    const again = await build();
    expect(again).not.toHaveProperty("passagesConflictSkipped");
    expect(again.status).toBe("complete");
    // STORY-058 AC4 (decision 108g): the duplicate URL used to be RE-FETCHED on this rebuild and its copy deduplicated (1). It is now
    // remembered as `duplicate_only`, so it is not fetched at all and there is nothing to deduplicate (0). Changed deliberately with the behaviour.
    expect(again.passagesDeduplicated).toBe(0);
    expect(await passageRows()).toHaveLength(1);
  }, 60_000);

  const checkRows = async (): Promise<{ outcome: string; expires_at: Date; checked_at: Date }[]> =>
    (await db.query("SELECT outcome, expires_at, checked_at FROM corpus_url_checks ORDER BY outcome")).rows;
  const OFF_TOPIC = { kind: "html", html: "<html><body><main><p>Zebras graze on savanna grass at dawn.</p></main></body></html>" } as const;

  it("scenario 7 - AC4 - a URL whose text is a same-cluster duplicate is not re-fetched while the 30-day cache is live", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://one.example/p");
    await cite(prompt, "https://two.example/p");
    const same = { kind: "html", html: articleHtml("identical") } as const;
    pages.set("https://one.example/p", same);
    pages.set("https://two.example/p", same);
    await build();
    expect([...fetchCalls].sort()).toEqual(["https://one.example/p", "https://two.example/p"]);

    const rows = await checkRows();
    expect(rows.map((row) => row.outcome)).toEqual(["duplicate_only"]);
    // 30 days, the same cache period as a passage.
    const days = (rows[0]!.expires_at.getTime() - rows[0]!.checked_at.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    fetchCalls.length = 0;
    const again = await build();
    expect(fetchCalls).toEqual([]);
    expect(again.cached).toBe(2);
    expect(again.status).toBe("complete");
    expect(await passageRows()).toHaveLength(1);
  }, 60_000);

  it("scenario 7 - AC4 - a URL with NO relevant chunk is remembered too, and not fetched again", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://offtopic.example/p");
    pages.set("https://offtopic.example/p", OFF_TOPIC);
    const first = await build();
    expect(first.empty).toBe(1);
    expect((await checkRows()).map((row) => row.outcome)).toEqual(["no_relevant_chunk"]);

    fetchCalls.length = 0;
    await build();
    expect(fetchCalls).toEqual([]);
  }, 60_000);

  it("scenario 7 - AC4 - an EXPIRED check is ignored: the URL is fetched again and its record renewed", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://offtopic.example/p");
    pages.set("https://offtopic.example/p", OFF_TOPIC);
    await build();
    await db.query("UPDATE corpus_url_checks SET expires_at = now() - interval '1 minute'");
    fetchCalls.length = 0;
    await build();
    expect(fetchCalls).toEqual(["https://offtopic.example/p"]);
    const rows = await checkRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expires_at.getTime()).toBeGreaterThan(Date.now());
  }, 60_000);

  it("scenario 7 - AC4 - a refused or failed URL is NOT remembered: it is a transient condition and is tried again", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://down.example/p");
    pages.set("https://down.example/p", { kind: "failed", reason: "http_503" });
    await build();
    expect(await checkRows()).toHaveLength(0);
    fetchCalls.length = 0;
    await build();
    expect(fetchCalls).toEqual(["https://down.example/p"]);
  }, 60_000);

  it("scenario 7 - AC4 - when the URL that held the text leaves the corpus, the remembered duplicate is fetched in the SAME build and the text stays in the corpus", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://one.example/p", { weight: 5 });
    await cite(prompt, "https://two.example/p");
    const same = { kind: "html", html: articleHtml("identical") } as const;
    pages.set("https://one.example/p", same);
    pages.set("https://two.example/p", same);
    await build();
    expect((await passageRows()).map((row) => row.url)).toEqual(["https://one.example/p"]);

    // batch 18 fix (owner decision 108): one.example is no longer cited, so its passage departs in this build's write. two.example's
    // `duplicate_only` check was live when the build read, and it used to be trusted - leaving the text out of the corpus until the NEXT
    // build. A departure now voids duplicate_only checks BEFORE the cache decision: two.example is fetched now and owns the text at once.
    await db.query("DELETE FROM citation_facts WHERE normalized_url = 'https://one.example/p'");
    fetchCalls.length = 0;
    await build();
    expect(fetchCalls).toEqual(["https://two.example/p"]);
    expect((await passageRows()).map((row) => row.url)).toEqual(["https://two.example/p"]);
    expect(await checkRows()).toHaveLength(0);

    fetchCalls.length = 0;
    await build();
    expect(fetchCalls).toEqual([]);
    expect((await passageRows()).map((row) => row.url)).toEqual(["https://two.example/p"]);
  }, 60_000);

  it("scenario 7 - AC12 - a higher-scoring duplicate whose twin row has EXPIRED adopts that row: the passage survives the stale-row delete", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://one.example/p");
    pages.set("https://one.example/p", { kind: "html", html: articleHtml("identical") });
    await build();
    await db.query("UPDATE corpus_passages SET expires_at = now() - interval '1 minute'");
    // two.example now outranks one.example and carries the same text, so ITS draft is the one kept; one.example's row is expired.
    await cite(prompt, "https://two.example/p", { weight: 5 });
    pages.set("https://two.example/p", { kind: "html", html: articleHtml("identical") });
    const result = await build();
    expect(result.status).toBe("complete");
    const rows = await passageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe("https://two.example/p");
    expect(rows[0]!.expires_at.getTime()).toBeGreaterThan(Date.now());
  }, 60_000);

  it("AC12 - expired rows of a URL that is refused or fails on re-fetch are removed, not kept as clutter", async () => {
    const urls = await seedPages(2);
    await build();
    expect(await passageRows()).toHaveLength(2);
    await db.query("UPDATE corpus_passages SET expires_at = now() - interval '1 minute'");
    pages.set(urls[0]!, { kind: "refused", reason: "address_not_global" });
    pages.set(urls[1]!, { kind: "failed", reason: "http_503" });
    const result = await build();
    expect(result.status).toBe("partial");
    expect(await passageRows()).toEqual([]);
  }, 60_000);

  it("AC13 - concurrency - the upsert writes in content-hash order, so concurrent builds lock index entries in one order", async () => {
    await seedPages(6);
    const inserts: string[][] = [];
    await build(STAND_IN_EMBEDDING_MODEL, {
      runInTx: (fn) =>
        deps().runInTx((tx) =>
          fn(new Proxy(tx, {
            get: (target, prop) => {
              if (prop !== "query") return Reflect.get(target, prop) as unknown;
              return (text: string, values?: unknown[]) => {
                if (typeof text === "string" && text.includes("INSERT INTO corpus_passages") && values !== undefined) inserts.push(values[13] as string[]);
                return (target.query as (...a: unknown[]) => unknown)(text, values);
              };
            },
          })),
        ),
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.length).toBeGreaterThan(1);
    expect(inserts[0]).toEqual([...inserts[0]!].sort());
  }, 60_000);

  it("scenario 7 - AC13 - rebuilding unchanged content writes no new rows and sends nothing to the provider", async () => {
    await seedPages(3);
    const provider = new CountingProvider(STAND_IN_EMBEDDING_MODEL);
    await build();
    await drainEmbedQueue(provider);
    const first = provider.sent.length;
    expect(first).toBeGreaterThan(0);
    const before = (await passageRows()).length;
    const again = await build();
    await drainEmbedQueue(provider);
    expect((await passageRows()).length).toBe(before);
    expect(provider.sent).toHaveLength(first);
    expect(again.passagesWritten).toBe(0);
  }, 60_000);

  it("AC7 - embedding is requested through embed.batch for every new passage, and the model is pinned on the row", async () => {
    await seedPages(3);
    await build();
    const rows = await passageRows();
    expect(rows.every((row) => row.embedding_model === STAND_IN_EMBEDDING_MODEL)).toBe(true);
    expect(rows.every((row) => !row.has_vector)).toBe(true);
    const queued = enqueued.flatMap((job) => job.payload.ids as string[]);
    expect(queued).toHaveLength(rows.length);
    expect(enqueued.every((job) => job.payload.table === "corpus_passages")).toBe(true);
    await drainEmbedQueue(new CountingProvider(STAND_IN_EMBEDDING_MODEL));
    expect((await passageRows()).every((row) => row.has_vector)).toBe(true);
  }, 60_000);

  it("AC7 - a failed embed enqueue does not fail the build (fails open, decision 7); the rows wait at embedding IS NULL", async () => {
    await seedPages(2);
    const result = await build(STAND_IN_EMBEDDING_MODEL, { enqueueEmbed: () => Promise.reject(new Error("valkey down")) });
    expect(result.embedEnqueueFailures).toBeGreaterThan(0);
    expect((await passageRows()).length).toBeGreaterThan(0);
  }, 60_000);

  // ---- weights ----------------------------------------------------------------------------------------------------------

  it("scenario 8 - AC8 - citation_frequency, avg_position_weight and centroid_weight = log1p(freq) x avg weight", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    for (const weight of [1, 0.5, 0.75]) await cite(prompt, "https://popular.example/p", { weight });
    pages.set("https://popular.example/p", { kind: "html", html: articleHtml("reporting") });
    await build();
    const [row] = await passageRows();
    expect(row!.citation_frequency).toBe(3);
    expect(row!.avg_position_weight).toBeCloseTo(0.75, 5);
    expect(row!.centroid_weight).toBeCloseTo(Math.log1p(3) * 0.75, 5);
  }, 60_000);

  it("AC8 - a cached URL gets its weights refreshed from new citations without a re-fetch", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://grow.example/p", { weight: 1 });
    pages.set("https://grow.example/p", { kind: "html", html: articleHtml("reporting") });
    await build();
    await cite(prompt, "https://grow.example/p", { weight: 1 });
    await cite(prompt, "https://grow.example/p", { weight: 1 });
    const again = await build();
    expect(fetchCalls).toHaveLength(1);
    expect(again.cached).toBe(1);
    const [row] = await passageRows();
    expect(row!.citation_frequency).toBe(3);
    expect(row!.centroid_weight).toBeCloseTo(Math.log1p(3), 5);
  }, 60_000);

  // ---- centroid ---------------------------------------------------------------------------------------------------------

  it("scenario 8 - AC9 - the centroid is one SQL aggregate: it equals the weighted, normalised mean computed independently of it", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    for (const [i, weight] of [1, 0.6, 0.3].entries()) {
      const url = `https://c${String(i)}.example/p`;
      await cite(prompt, url, { weight });
      if (i === 0) await cite(prompt, url, { weight });
      pages.set(url, { kind: "html", html: articleHtml(`distinct${String(i)}`) });
    }
    await build();
    await drainEmbedQueue(new CountingProvider(STAND_IN_EMBEDDING_MODEL));
    const session = await addSession();
    const result = await centroidOf(session);
    expect(result.hasCentroid).toBe(true);

    const rows = (await db.query<{ v: string; w: number }>("SELECT embedding::text AS v, centroid_weight AS w FROM corpus_passages")).rows;
    const sum = new Array<number>(1536).fill(0);
    for (const row of rows) (JSON.parse(row.v) as number[]).forEach((x, d) => { sum[d]! += x * row.w; });
    const norm = Math.hypot(...sum);
    const expected = sum.map((x) => x / norm);
    const stored = JSON.parse((await db.query<{ c: string }>("SELECT centroid::text AS c FROM geo_alignments WHERE id = $1", [session])).rows[0]!.c) as number[];
    const cosine = stored.reduce((acc, x, d) => acc + x * expected[d]!, 0) / Math.hypot(...stored);
    expect(cosine).toBeGreaterThan(0.9999);
    expect(Math.hypot(...stored)).toBeCloseTo(1, 2);
  }, 120_000);

  it("scenario 9 - AC10 - the source count and the contributing domains are recorded on the session", async () => {
    await seedPages(3);
    await build();
    await drainEmbedQueue(new CountingProvider(STAND_IN_EMBEDDING_MODEL));
    const session = await addSession();
    const result = await centroidOf(session);
    const row = (await db.query("SELECT centroid_source_count, centroid_domains FROM geo_alignments WHERE id=$1", [session])).rows[0];
    expect(row.centroid_source_count).toBe(result.sourceCount);
    expect(row.centroid_source_count).toBe((await passageRows()).length);
    expect(row.centroid_domains).toEqual(["site0.example", "site1.example", "site2.example"]);
    expect(result.domains).toEqual(row.centroid_domains);
  }, 60_000);

  it("AC10 - a passage not yet embedded does not contribute (and is not counted)", async () => {
    await seedPages(2);
    await build();
    const session = await addSession();
    const result = await centroidOf(session);
    expect(result.sourceCount).toBe(0);
    expect(result.hasCentroid).toBe(false);
    expect((await db.query("SELECT centroid FROM geo_alignments WHERE id=$1", [session])).rows[0].centroid).toBeNull();
  }, 60_000);

  it("scenario 10 - AC11 - 7 contributing passages is low-confidence, 8 is not", async () => {
    await seedPages(7);
    await build();
    await drainEmbedQueue(new CountingProvider(STAND_IN_EMBEDDING_MODEL));
    expect((await passageRows()).length).toBe(7);
    const low = await centroidOf(await addSession());
    expect(low.sourceCount).toBe(7);
    expect(low.lowConfidence).toBe(true);

    await db.query("TRUNCATE corpus_passages, citation_facts, tracked_prompts CASCADE");
    await seedPages(8, "more");
    await build();
    await drainEmbedQueue(new CountingProvider(STAND_IN_EMBEDDING_MODEL));
    const ok = await centroidOf(await addSession());
    expect(ok.sourceCount).toBe(8);
    expect(ok.lowConfidence).toBe(false);
  }, 120_000);

  // ---- the corpus follows the CURRENT selection (round-1 review) --------------------------------------------------------

  it("review - AC1/AC10 - a URL that falls out of the top 25 on a later build no longer contributes to the centroid, its count or its domains", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    for (let i = 0; i < 25; i += 1) {
      const url = `https://top${String(i).padStart(2, "0")}.example/p`;
      await cite(prompt, url, { weight: i === 24 ? 0.4 : 0.5 });
      pages.set(url, { kind: "html", html: articleHtml(`topic${String(i)}`) });
    }
    await build();
    await drainEmbedQueue(new CountingProvider(STAND_IN_EMBEDDING_MODEL));
    expect((await centroidOf(await addSession())).sourceCount).toBe(25);

    await cite(prompt, "https://newcomer.example/p", { weight: 0.9 });
    pages.set("https://newcomer.example/p", { kind: "html", html: articleHtml("newcomer") });
    await build();
    await drainEmbedQueue(new CountingProvider(STAND_IN_EMBEDDING_MODEL));
    const result = await centroidOf(await addSession());
    expect(result.sourceCount).toBe(25);
    expect(result.domains).not.toContain("top24.example");
    expect(result.domains).toContain("newcomer.example");
    expect((await passageRows("url = 'https://top24.example/p'"))).toEqual([]);
  }, 120_000);

  it("review - AC2 - a URL flagged owned after the first build is gone from the corpus and the centroid on the next build", async () => {
    await seedPages(3);
    await build();
    await drainEmbedQueue(new CountingProvider(STAND_IN_EMBEDDING_MODEL));
    expect((await centroidOf(await addSession())).domains).toContain("site0.example");

    await db.query("UPDATE citation_facts SET is_owned = true WHERE domain = 'site0.example'");
    await build();
    await drainEmbedQueue(new CountingProvider(STAND_IN_EMBEDDING_MODEL));
    const result = await centroidOf(await addSession());
    expect(result.domains).toEqual(["site1.example", "site2.example"]);
    expect(result.sourceCount).toBe(2);
    expect(await passageRows("url = 'https://site0.example/page'")).toEqual([]);
  }, 120_000);

  it("review - a URL leaving the selection frees its text for another URL in the same build (no skipped upsert)", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://first.example/p", { weight: 1 });
    pages.set("https://first.example/p", { kind: "html", html: articleHtml("shared words") });
    await build();
    await db.query("DELETE FROM citation_facts WHERE domain = 'first.example'");
    await cite(prompt, "https://second.example/p", { weight: 1 });
    pages.set("https://second.example/p", { kind: "html", html: articleHtml("shared words") });
    const again = await build();
    expect((await passageRows()).map((r) => r.url)).toEqual(["https://second.example/p"]);
    expect(again).not.toHaveProperty("passagesConflictSkipped");
    expect(again.status).toBe("complete");
  }, 60_000);

  // ---- a passage held by another cluster / project (the schema key has neither) -----------------------------------------

  it("review - AC1/AC4 - one page cited for two clusters of one project: the second cluster is fetched too and holds EVERY passage it selected, including text the first also holds", async () => {
    const clusterB = randomUUID();
    const promptA = await addPrompt(PROMPT_TEXTS[0]!);
    const promptB = await addPrompt("pricing plans for agencies", clusterB);
    for (const prompt of [promptA, promptB]) await cite(prompt, "https://g2.example/compare");
    const section = (title: string, body: string): string => `<h2>${title}</h2><p>${body} ${"filler ".repeat(8)}</p>`;
    pages.set("https://g2.example/compare", {
      kind: "html",
      html: `<html><body><main>${section("A1", "teams compare reporting tools")}${section("A2", "reporting tools for teams compare")}${section("Both", "reporting tools pricing plans")}${section("B1", "pricing plans agencies")}${section("B2", "agencies pricing plans compared")}</main></body></html>`,
    });
    const first = await build();
    expect(first.status).toBe("complete");
    expect(fetchCalls).toHaveLength(1);

    const second = await buildCorpus(deps(), { projectId, clusterId: clusterB });
    expect(fetchCalls).toHaveLength(2); // not skipped because another cluster holds the page
    expect(second.passagesWritten).toBe(3); // B1, B2 AND the text both clusters selected ("Both"): each cluster holds its own copy
    expect(second.status).toBe("complete");
    expect(second).not.toHaveProperty("passagesConflictSkipped");
    const stored = await passageRows(`prompt_cluster_id = '${clusterB}'`);
    expect(stored).toHaveLength(3);
    expect(stored.some((r) => /\bBoth\b/.test(r.text))).toBe(true);
    // the first cluster still holds its own copy of the shared text
    expect((await passageRows(`prompt_cluster_id = '${clusterId}'`)).some((r) => /\bBoth\b/.test(r.text))).toBe(true);
    // B now has live rows for the page: it is cached for the next build
    await buildCorpus(deps(), { projectId, clusterId: clusterB });
    expect(fetchCalls).toHaveLength(2);
  }, 60_000);

  it("review - AC1 - an EXPIRED row of another cluster is that cluster's own: left alone, never adopted, and it does not block this cluster's copy", async () => {
    const clusterB = randomUUID();
    const promptA = await addPrompt(PROMPT_TEXTS[0]!);
    const promptB = await addPrompt(PROMPT_TEXTS[1]!, clusterB);
    await cite(promptB, "https://old.example/p");
    pages.set("https://old.example/p", { kind: "html", html: articleHtml("shared") });
    await buildCorpus(deps(), { projectId, clusterId: clusterB });
    await db.query("UPDATE corpus_passages SET expires_at = now() - interval '1 minute'");
    await cite(promptA, "https://new.example/p");
    pages.set("https://new.example/p", { kind: "html", html: articleHtml("shared") });
    const result = await build();
    expect(result.passagesWritten).toBe(1);
    expect(result.status).toBe("complete");
    expect(await passageRows(`prompt_cluster_id = '${clusterId}'`)).toHaveLength(1);
    const theirs = await passageRows(`prompt_cluster_id = '${clusterB}'`);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.url).toBe("https://old.example/p");
  }, 60_000);

  it("review - a URL's cached rows that cross expiry during the fetch phase are not deleted by the superseded-row cleanup", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://cached.example/p", { weight: 5 });
    pages.set("https://cached.example/p", { kind: "html", html: articleHtml("cached") });
    await build();
    await cite(prompt, "https://fresh.example/p");
    pages.set("https://fresh.example/p", { kind: "html", html: articleHtml("fresh") });
    const expiring: PageFetcher = async (url) => {
      await db.query("UPDATE corpus_passages SET expires_at = now() - interval '1 minute' WHERE url = 'https://cached.example/p'");
      return fetchPage(url);
    };
    await build(STAND_IN_EMBEDDING_MODEL, { fetchPage: expiring });
    expect(await passageRows("url = 'https://cached.example/p'")).toHaveLength(1);
  }, 60_000);

  it("review - a directive containing %00 yields a passage without the NUL, and the rest of the build still writes", async () => {
    const prompt = await addPrompt(PROMPT_TEXTS[0]!);
    await cite(prompt, "https://nul.example/p", { fragment: "quote%00here%20now" });
    await cite(prompt, "https://fine.example/p");
    pages.set("https://fine.example/p", { kind: "html", html: articleHtml("fine") });
    const result = await build();
    expect(result.fromFragment).toBe(1);
    const rows = await passageRows();
    expect(rows.find((r) => r.url === "https://nul.example/p")!.text).toBe("quotehere now");
    expect(rows.some((r) => r.url === "https://fine.example/p")).toBe(true);
    for (const row of rows) expect(row.text).not.toContain("\u0000");
    const again = await build();
    expect(again.status).toBe("complete");
  }, 60_000);

  it("review - AC1/AC4 - identical text cited by two clusters: each cluster holds it and gets its own embedding, and neither build is partial", async () => {
    const clusterB = randomUUID();
    const promptA = await addPrompt(PROMPT_TEXTS[0]!);
    const promptB = await addPrompt(PROMPT_TEXTS[1]!, clusterB);
    await cite(promptA, "https://x.example/p");
    await cite(promptB, "https://y.example/p");
    const same = { kind: "html", html: articleHtml("identical") } as const;
    pages.set("https://x.example/p", same);
    pages.set("https://y.example/p", same);
    expect((await build()).status).toBe("complete");
    const second = await buildCorpus(deps(), { projectId, clusterId: clusterB });
    expect(second.passagesWritten).toBe(1);
    expect(second.status).toBe("complete");
    expect(second).not.toHaveProperty("passagesConflictSkipped");
    const provider = new CountingProvider(STAND_IN_EMBEDDING_MODEL);
    await drainEmbedQueue(provider);
    const rows = await db.query("SELECT prompt_cluster_id, embedding IS NOT NULL AS has_vector FROM corpus_passages ORDER BY prompt_cluster_id");
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r: { has_vector: boolean }) => r.has_vector)).toBe(true);
    // each cluster's centroid is made of its own copy
    for (const [cluster, url] of [[clusterId, "https://x.example/p"], [clusterB, "https://y.example/p"]] as const) {
      const session = randomUUID();
      await db.query(`INSERT INTO geo_alignments (id, workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model) VALUES ($1,$2,$3,'https://brand.test/p',$4,'{chatgpt}',$5)`, [session, workspaceId, projectId, cluster, STAND_IN_EMBEDDING_MODEL]);
      const centroid = await centroidOf(session);
      expect(centroid.sourceCount).toBe(1);
      expect((await passageRows(`prompt_cluster_id = '${cluster}'`))[0]!.url).toBe(url);
    }
  }, 60_000);

  it("review - AC1 - identical text cited by two PROJECTS of one workspace: each project holds it, neither build is partial", async () => {
    const projectB = randomUUID();
    const clusterB = randomUUID();
    await db.query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, 'P2', $3, 'https://brand2.test', 'brand2.test')`, [projectB, workspaceId, `p-${randomUUID().slice(0, 8)}`]);
    await db.query("INSERT INTO project_engines (workspace_id, project_id, engine_key, weight) VALUES ($1,$2,'perplexity',1.0)", [workspaceId, projectB]);
    const promptA = await addPrompt(PROMPT_TEXTS[0]!);
    const promptB = await addPrompt(PROMPT_TEXTS[1]!, clusterB, workspaceId, projectB);
    await cite(promptA, "https://x.example/p");
    await cite(promptB, "https://x.example/p", { project: projectB });
    pages.set("https://x.example/p", { kind: "html", html: articleHtml("identical") });
    expect((await build()).status).toBe("complete");
    const second = await buildCorpus(deps(), { projectId: projectB, clusterId: clusterB });
    expect(second.passagesWritten).toBe(1);
    expect(second.status).toBe("complete");
    expect(await passageRows(`project_id = '${projectId}'`)).toHaveLength(1);
    expect(await passageRows(`project_id = '${projectB}'`)).toHaveLength(1);
  }, 60_000);

  it("review - AC9/AC10 - a session's centroid reads only its own cluster's passages, not a sibling cluster of the same project", async () => {
    const clusterB = randomUUID();
    const promptB = await addPrompt(PROMPT_TEXTS[1]!, clusterB);
    await seedPages(2);
    await cite(promptB, "https://sibling.example/p");
    pages.set("https://sibling.example/p", { kind: "html", html: articleHtml("sibling topic") });
    await build();
    await buildCorpus(deps(), { projectId, clusterId: clusterB });
    await drainEmbedQueue(new CountingProvider(STAND_IN_EMBEDDING_MODEL));
    const result = await centroidOf(await addSession());
    expect(result.sourceCount).toBe(2);
    expect(result.domains).toEqual(["site0.example", "site1.example"]);
  }, 120_000);

  // ---- a zero-weight passage is not a source -----------------------------------------------------------------------------

  it("review - AC10/AC11 - a passage with centroid_weight 0 is neither counted nor listed; all-zero is no centroid and low-confidence", async () => {
    await seedPages(2);
    await build();
    await drainEmbedQueue(new CountingProvider(STAND_IN_EMBEDDING_MODEL));
    await db.query("UPDATE corpus_passages SET centroid_weight = 0 WHERE domain = 'site0.example'");
    const one = await centroidOf(await addSession());
    expect(one.sourceCount).toBe(1);
    expect(one.domains).toEqual(["site1.example"]);
    expect(one.hasCentroid).toBe(true);

    await db.query("UPDATE corpus_passages SET centroid_weight = 0");
    const none = await centroidOf(await addSession());
    expect(none.sourceCount).toBe(0);
    expect(none.hasCentroid).toBe(false);
    expect(none.lowConfidence).toBe(true);
  }, 120_000);

  // ---- concurrent redelivery ---------------------------------------------------------------------------------------------

  it("review - two builds of one cluster racing converge: the same rows as one build, and one embed key", async () => {
    await seedPages(3);
    const second = new Client({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password: resolvePassword("nominara_app", {}) });
    await second.connect();
    try {
      const other = { ...deps(), runInTx: <T,>(fn: (tx: ClientBase) => Promise<T>) => withTenantContext(second, { workspaceId, actorId: SYSTEM_ACTOR_ID }, fn) };
      const results = await Promise.all([buildCorpus(deps(), { projectId, clusterId }), buildCorpus(other, { projectId, clusterId })]);
      expect(results.map((r) => r.status)).toEqual(["complete", "complete"]);
    } finally {
      await second.end();
    }
    const rows = await passageRows();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.text)).size).toBe(3);
    expect(new Set(enqueued.map((e) => e.key)).size).toBe(1);
  }, 60_000);

  // ---- expiry and model -------------------------------------------------------------------------------------------------

  it("scenario 11 - AC12 - passages carry a 30-day expiry, expired ones leave the centroid, and the URL is re-fetched", async () => {
    const urls = await seedPages(2);
    await build();
    await drainEmbedQueue(new CountingProvider(STAND_IN_EMBEDDING_MODEL));
    const [row] = await passageRows();
    const days = (row!.expires_at.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    await db.query("UPDATE corpus_passages SET expires_at = now() - interval '1 minute'");
    expect((await centroidOf(await addSession())).sourceCount).toBe(0);

    fetchCalls.length = 0;
    pages.set(urls[0]!, { kind: "html", html: articleHtml("fresher content entirely") });
    const result = await build();
    expect(fetchCalls.sort()).toEqual([...urls].sort());
    expect(result.cached).toBe(0);
    // stale rows that the new fetch superseded are gone, not left beside the fresh ones
    expect(await passageRows("expires_at <= now()")).toEqual([]);
    const live = await passageRows();
    expect([...new Set(live.map((r) => r.url))].sort()).toEqual([...urls].sort());
    expect(live.filter((r) => r.url === urls[0]).every((r) => r.text.includes("fresher content entirely"))).toBe(true);
    expect(live.every((r) => r.expires_at.getTime() > Date.now())).toBe(true);
  }, 120_000);

  it("scenario 12 - AC7 - a new model makes NEW rows, and a session pinned to one model never sees the other's vectors", async () => {
    await seedPages(3);
    await build(STAND_IN_EMBEDDING_MODEL);
    await drainEmbedQueue(new CountingProvider(STAND_IN_EMBEDDING_MODEL));
    const countA = (await passageRows()).length;
    await build(MODEL_B);
    await drainEmbedQueue(new CountingProvider(MODEL_B));
    expect((await passageRows()).length).toBe(countA * 2);
    expect((await passageRows(`embedding_model = '${MODEL_B}'`)).length).toBe(countA);

    const a = await centroidOf(await addSession(STAND_IN_EMBEDDING_MODEL));
    const b = await centroidOf(await addSession(MODEL_B));
    expect(a.sourceCount).toBe(countA);
    expect(b.sourceCount).toBe(countA);
    // a session pinned to a model nobody embedded under has no corpus at all
    const none = await centroidOf(await addSession("never-used-model"));
    expect(none.sourceCount).toBe(0);
  }, 120_000);

  // ---- tenancy ----------------------------------------------------------------------------------------------------------

  it("RLS - workspace B's citations never become workspace A's passages, and A's centroid never reads B's passages", async () => {
    const bProject = randomUUID();
    await db.query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://b.test','b.test')`, [bProject, otherWorkspaceId, `p-${randomUUID().slice(0, 8)}`]);
    const bPrompt = await addPrompt(PROMPT_TEXTS[0]!, clusterId, otherWorkspaceId, bProject);
    await cite(bPrompt, "https://b-only.example/p", { ws: otherWorkspaceId, project: bProject });
    pages.set("https://b-only.example/p", { kind: "html", html: articleHtml("reporting") });
    await seedPages(1);
    await build();
    expect(fetchCalls).not.toContain("https://b-only.example/p");
    // a corpus row of B that happens to share A's project/cluster ids is invisible to A's centroid
    await db.query(
      `INSERT INTO corpus_passages (workspace_id, project_id, citation_url_hash, url, domain, prompt_cluster_id, passage_index, text, token_count, content_hash, embedding, embedding_model, expires_at)
       VALUES ($1,$2,'\\x00','https://x','b.example',$3,0,'t',1,sha256('b'::bytea), $4::halfvec, $5, now() + interval '1 day')`,
      [otherWorkspaceId, projectId, clusterId, `[${["1", ...new Array<string>(1535).fill("0")].join(",")}]`, STAND_IN_EMBEDDING_MODEL],
    );
    await drainEmbedQueue(new CountingProvider(STAND_IN_EMBEDDING_MODEL));
    const result = await centroidOf(await addSession());
    expect(result.sourceCount).toBe((await passageRows(`workspace_id = '${workspaceId}'`)).length);
  }, 60_000);

  it("computeCentroid on a missing session changes nothing and says so", async () => {
    await expect(centroidOf(randomUUID())).resolves.toMatchObject({ found: false });
  }, 60_000);

  it("computeCentroid on workspace B's REAL session, under A's context, is found=false and B's row is untouched", async () => {
    const bProject = randomUUID();
    await db.query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://b.test','b.test')`, [bProject, otherWorkspaceId, `p-${randomUUID().slice(0, 8)}`]);
    const bSession = randomUUID();
    await db.query(
      `INSERT INTO geo_alignments (id, workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model, centroid_source_count, centroid_domains)
       VALUES ($1,$2,$3,'https://b.test/p',$4,'{chatgpt}',$5, 42, '{keep.example}')`,
      [bSession, otherWorkspaceId, bProject, clusterId, STAND_IN_EMBEDDING_MODEL],
    );
    await expect(centroidOf(bSession)).resolves.toMatchObject({ found: false });
    const row = (await db.query("SELECT centroid_source_count, centroid_domains, centroid IS NULL AS no_centroid FROM geo_alignments WHERE id = $1", [bSession])).rows[0];
    expect(row).toEqual({ centroid_source_count: 42, centroid_domains: ["keep.example"], no_centroid: true });
  }, 60_000);

  it("observability - a span per build, a metric per URL outcome, and ONE redacted log line (workspace ID; no URL, domain or passage text)", async () => {
    const log = vi.spyOn(Logger.prototype, "log");
    exporter.reset();
    const urls = await seedPages(2);
    await build();
    const entries = log.mock.calls.map((call) => call[0] as Record<string, unknown>).filter((entry) => typeof entry === "object" && entry !== null);
    log.mockRestore();
    expect(exporter.getFinishedSpans().map((span) => span.name)).toContain("geo.corpus.build");
    expect(entries.filter((entry) => entry.metric === "nominara_geo_corpus_urls_total" && entry.outcome === "fetched")).toHaveLength(2);
    expect(entries.some((entry) => entry.metric === "nominara_geo_corpus_passages_written")).toBe(true);
    const lines = entries.filter((entry) => entry.event === "geo.corpus.built");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.workspace_id).toBe(workspaceId);
    const everything = JSON.stringify(lines);
    for (const url of urls) expect(everything).not.toContain(new URL(url).hostname);
    expect(everything).not.toContain("reporting");
  }, 60_000);

  it("nothing in the pipeline needs a client transaction type beyond ClientBase (compile-time smoke)", () => {
    const f: (tx: ClientBase) => unknown = () => undefined;
    expect(typeof f).toBe("function");
  });
});
