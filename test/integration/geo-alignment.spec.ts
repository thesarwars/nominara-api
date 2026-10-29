import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { alignmentSessionPayloadSchema } from "../../contracts/analytics/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { embedBatchPayloadSchema } from "../../src/lib/embedding/embed-batch.js";
import { analyseNodes, computeAlignment, extractSemanticNodes, openAlignmentSession, readSessionPayload, type AlignmentDeps } from "../../src/lib/geo/alignment/index.js";
import { computeCentroid } from "../../src/lib/geo/corpus/centroid.js";
import type { PageFetcher, PageFetchResult } from "../../src/lib/geo/corpus/page-fetcher.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createEmbedBatchHandler } from "../../src/lib/queue/handlers/embed-batch.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { StandInEmbeddingProvider, STAND_IN_EMBEDDING_MODEL } from "../../src/modules/prompts/adapters/stand-in-embedding-provider.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-059 - alignment, coverage, semantic nodes and projected gain, against real Postgres + pgvector under the RUNTIME role.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. The embedding provider is the deterministic STAND-IN (owner decision 2026-10-28 #1), a hashed
// bag of words: it proves the pipeline (fetch, chunk, embed through embed.batch, SQL alignment, prevalence, dedupe, gain, rank,
// suppression, labelling) but not that a real model places a paraphrase near its source. So every GEOMETRIC assertion writes
// CRAFTED unit vectors straight into the columns and compares the database's answer with arithmetic done here, independently of it.
// The stand-in is used only to prove the embed path.

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));

const KEYS = { current: { kid: "k1", key: Buffer.from("embed-batch-test-signing-key-32by") } };
const EMBED_ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "embed.batch")!;
const MODEL = STAND_IN_EMBEDDING_MODEL;
const words = { count: (text: string): number => (text.trim() === "" ? 0 : text.trim().split(/\s+/).length) };
const TOL = 3e-3;

// ---- independent vector arithmetic (test side only) ----------------------------------------------------------------------
const DIM = 1536;
const vec = (components: Record<number, number>): number[] => {
  const v = new Array<number>(DIM).fill(0);
  for (const [i, x] of Object.entries(components)) v[Number(i)] = x;
  return v;
};
const dot = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i]!, 0);
const norm = (a: number[]): number => Math.sqrt(dot(a, a));
const unit = (a: number[]): number[] => a.map((x) => x / norm(a));
const cos = (a: number[], b: number[]): number => dot(a, b) / (norm(a) * norm(b));
const lit = (a: number[]): string => `[${a.join(",")}]`;
const add = (a: number[], b: number[], wa = 1, wb = 1): number[] => a.map((x, i) => wa * x + wb * b[i]!);
const percentileCont = (sorted: number[], p: number): number => {
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
};
/** The documented estimator, written out here as plain arithmetic: alpha, blend, normalise, cosine difference. */
const expectedGain = (chunk: number[], centroid: number[], phrase: number[], phraseTokens: number, chunkTokens: number): number => {
  const alpha = Math.min(0.25, (phraseTokens / (chunkTokens + phraseTokens)) * 3.5);
  const blended = unit(add(chunk, phrase, 1 - alpha, alpha));
  return cos(blended, centroid) - cos(chunk, centroid);
};

const sentencePage = (sections: readonly (readonly [string, string])[]): string =>
  `<html><body><main>${sections.map(([title, body]) => `<h2>${title}</h2><p>${body}</p>`).join("")}</main></body></html>`;

describe("STORY-059 - alignment, coverage, semantic nodes, projected gain", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let appDb: Client;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let clusterId: string;
  let txOpen = false;
  let fetchSawOpenTx = false;
  const fetchCalls: string[] = [];
  let pages = new Map<string, PageFetchResult>();
  const enqueued: { workspaceId: string; payload: Record<string, unknown>; key: string }[] = [];

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
    await db.query("TRUNCATE semantic_nodes, content_chunks, corpus_passages, geo_alignments, projects, workspaces CASCADE");
    [workspaceId, otherWorkspaceId, projectId, clusterId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [ws, `w-${randomUUID().slice(0, 8)}`]);
    }
    await db.query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, 'P', $3, 'https://brand.test', 'brand.test')`, [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`]);
    enqueued.length = 0;
    fetchCalls.length = 0;
    pages = new Map();
    fetchSawOpenTx = false;
    txOpen = false;
  });

  // ---- fixtures ---------------------------------------------------------------------------------------------------------

  const fetchPage: PageFetcher = async (url) => {
    fetchSawOpenTx ||= txOpen;
    fetchCalls.push(url);
    return pages.get(url) ?? { kind: "failed", reason: "not_found" };
  };

  function deps(over: Partial<AlignmentDeps> = {}): AlignmentDeps {
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
      embeddingModel: MODEL,
      enqueueEmbed: async (_queue, ws, payload, key) => {
        expect(txOpen).toBe(false); // enqueue happens AFTER the commit, never inside the transaction
        enqueued.push({ workspaceId: ws, payload, key });
      },
      ...over,
    };
  }

  const inTx = <T,>(fn: (tx: ClientBase) => Promise<T>): Promise<T> => withTenantContext(appDb, { workspaceId, actorId: SYSTEM_ACTOR_ID }, fn);

  async function drainEmbedQueue(): Promise<void> {
    const context = { pool: undefined, env: { NODE_ENV: "test" } } as unknown as QueueHandlerContext;
    const process = createJobProcessor(EMBED_ENTRY, { keys: KEYS, getClient: () => appDb, process: createEmbedBatchHandler(context, { provider: new StandInEmbeddingProvider() }) });
    while (enqueued.length > 0) {
      const job = enqueued.shift()!;
      const payload = embedBatchPayloadSchema.parse({ ...job.payload, workspaceId: job.workspaceId, kid: "k1" });
      await process({ data: signQueueJobPayload(payload, KEYS.current.key) } as unknown as Job);
    }
  }

  async function addSession(over: { cluster?: string | null; centroid?: number[] | null; sourceCount?: number; live?: string | null; draft?: string | null } = {}): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO geo_alignments (id, workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model, centroid, centroid_source_count, live_content_md, draft_content_md)
       VALUES ($1,$2,$3,'https://brand.test/p',$4,'{chatgpt}',$5,$6::halfvec,$7,$8,$9)`,
      [id, workspaceId, projectId, over.cluster === undefined ? clusterId : over.cluster, MODEL, over.centroid === undefined || over.centroid === null ? null : lit(over.centroid), over.sourceCount ?? 0, over.live ?? null, over.draft ?? null],
    );
    return id;
  }

  async function addPassage(i: number, over: { embedding?: number[] | null; tokens?: number; text?: string; url?: string; ws?: string } = {}): Promise<void> {
    const url = over.url ?? `https://doc${String(i)}.example/p`;
    const text = over.text ?? `passage ${String(i)} ${randomUUID()}`;
    await db.query(
      `INSERT INTO corpus_passages (workspace_id, project_id, citation_url_hash, url, domain, prompt_cluster_id, passage_index, text, token_count, content_hash, embedding, embedding_model, centroid_weight, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10::halfvec,$11,1, now() + interval '10 days')`,
      [over.ws ?? workspaceId, projectId, createHash("sha256").update(url).digest(), url, new URL(url).hostname, clusterId, text, over.tokens ?? 100, createHash("sha256").update(text).digest(), over.embedding === undefined || over.embedding === null ? null : lit(over.embedding), MODEL],
    );
  }

  async function addChunk(session: string, index: number, embedding: number[] | null, tokens: number, isDraft = false): Promise<string> {
    const id = randomUUID();
    const text = `chunk ${String(index)} ${randomUUID()}`;
    await db.query(
      `INSERT INTO content_chunks (id, workspace_id, project_id, session_id, url, chunk_index, text, token_count, content_hash, embedding, embedding_model, is_draft)
       VALUES ($1,$2,$3,$4,'https://brand.test/p',$5,$6,$7,$8,$9::halfvec,$10,$11)`,
      [id, workspaceId, projectId, session, index, text, tokens, createHash("sha256").update(text).digest(), embedding === null ? null : lit(embedding), embedding === null ? null : MODEL, isDraft],
    );
    return id;
  }

  async function addNode(phrase: string, over: { type?: string; ratio?: number; embedding?: number[] | null; cluster?: string | null; present?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO semantic_nodes (id, workspace_id, project_id, prompt_cluster_id, phrase, phrase_normalized, node_type, corpus_doc_ratio, embedding, embedding_model, present_in_content, evidence_url, evidence_snippet, requires_human_review)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::halfvec,$10,$11,'https://doc0.example/p',$12,false)`,
      [id, workspaceId, projectId, over.cluster === undefined ? clusterId : over.cluster, phrase, phrase.toLowerCase(), over.type ?? "capability", over.ratio ?? 0.5, over.embedding === undefined || over.embedding === null ? null : lit(over.embedding), over.embedding === null ? null : MODEL, over.present ?? false, `we offer ${phrase}`],
    );
    return id;
  }

  const sessionRow = async (id: string) => (await db.query("SELECT * FROM geo_alignments WHERE id = $1", [id])).rows[0] as Record<string, unknown>;
  const nodeRows = async () => (await db.query("SELECT * FROM semantic_nodes WHERE project_id = $1 ORDER BY phrase_normalized", [projectId])).rows as Record<string, unknown>[];
  const nodeByPhrase = async (phrase: string) => (await nodeRows()).find((n) => n.phrase_normalized === phrase.toLowerCase())!;

  // The corpus: five cited documents, each one passage, at increasing angles from e0. The centroid is computed by the REAL statement.
  const DOC_VECTORS = [0, 0.4, 0.8, 1.2, 1.6].map((t, i) => unit(vec({ 0: 1, [i + 1]: t })));
  async function seedCorpus(): Promise<void> {
    for (const [i, v] of DOC_VECTORS.entries()) await addPassage(i, { embedding: v });
  }
  const expectedCentroid = (): number[] => unit(DOC_VECTORS.reduce((sum, v) => add(sum, v), vec({})));

  // ---- scenario 1: open a session ---------------------------------------------------------------------------------------

  it("scenario 1 - AC2 - a session opens for one URL and cluster: the live page is fetched OUTSIDE a transaction, chunked, and its chunks embedded through embed.batch", async () => {
    pages.set("https://brand.test/p", { kind: "html", html: sentencePage([["Reporting", "Teams compare reporting tools by export formats."], ["Pricing", "Plans start free for small teams."]]) });
    const result = await openAlignmentSession(deps(), { projectId, clusterId, targetUrl: "https://brand.test/p", engineKeys: ["chatgpt"], createdBy: null });
    expect(fetchCalls).toEqual(["https://brand.test/p"]);
    expect(fetchSawOpenTx).toBe(false);
    expect(result.chunks).toBeGreaterThanOrEqual(2);
    const session = await sessionRow(result.sessionId);
    expect(session).toMatchObject({ target_url: "https://brand.test/p", prompt_cluster_id: clusterId, embedding_model: MODEL, status: "open" });
    expect(String(session.live_content_md)).toContain("Reporting");
    expect(enqueued.length).toBe(result.embedJobs);
    expect(enqueued[0]!.payload.table).toBe("content_chunks");
    await drainEmbedQueue();
    const chunks = (await db.query("SELECT embedding IS NOT NULL AS has, embedding_model, is_draft FROM content_chunks WHERE session_id = $1", [result.sessionId])).rows;
    expect(chunks).toHaveLength(result.chunks);
    expect(chunks.every((c: { has: boolean; embedding_model: string; is_draft: boolean }) => c.has && c.embedding_model === MODEL && !c.is_draft)).toBe(true);
  }, 60_000);

  it("scenario 1 - AC2 - a page the guard refuses or that fails opens NO session, and says why without the URL's address", async () => {
    pages.set("https://internal.test/p", { kind: "refused", reason: "address_not_global" });
    await expect(openAlignmentSession(deps(), { projectId, clusterId, targetUrl: "https://internal.test/p", engineKeys: ["chatgpt"], createdBy: null })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(openAlignmentSession(deps(), { projectId, clusterId, targetUrl: "https://gone.test/p", engineKeys: ["chatgpt"], createdBy: null })).rejects.toMatchObject({ code: "validation_failed" });
    expect((await db.query("SELECT count(*)::int AS n FROM geo_alignments")).rows[0]).toEqual({ n: 0 });
  }, 60_000);

  it("scenario 1 - AC2 - a failed embed enqueue does not fail the session (fails open); the chunks wait at embedding IS NULL", async () => {
    pages.set("https://brand.test/p", { kind: "html", html: sentencePage([["A", "alpha beta gamma delta"]]) });
    const result = await openAlignmentSession(deps({ enqueueEmbed: async () => { throw new Error("valkey down"); } }), { projectId, clusterId, targetUrl: "https://brand.test/p", engineKeys: ["chatgpt"], createdBy: null });
    expect(result.embedEnqueueFailures).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NULL AND session_id = $1", [result.sessionId])).rows[0]).toEqual({ n: result.chunks });
  }, 60_000);

  // ---- scenario 1 / 2: alignment and the empirical band, in SQL ---------------------------------------------------------

  it("scenario 1 - AC3 - alignment is 1 - (chunk <=> centroid) per chunk and token-weighted per page, computed in SQL", async () => {
    await seedCorpus();
    const session = await addSession();
    const c1 = unit(vec({ 0: 1, 1: 0.2 }));
    const c2 = vec({ 3: 1 });
    await addChunk(session, 0, c1, 300);
    await addChunk(session, 1, c2, 100);
    await addChunk(session, 2, null, 50); // not embedded yet: neither averaged nor counted
    const centroid = await inTx((tx) => computeCentroid(tx, session));
    expect(centroid.sourceCount).toBe(5);
    const figures = await inTx((tx) => computeAlignment(tx, session));
    const centroidVec = expectedCentroid();
    const a1 = cos(c1, centroidVec);
    const a2 = cos(c2, centroidVec);
    const chunkRows = (await db.query("SELECT chunk_index, alignment FROM content_chunks WHERE session_id = $1 ORDER BY chunk_index", [session])).rows as { chunk_index: number; alignment: number | null }[];
    expect(chunkRows[0]!.alignment).toBeCloseTo(a1, 2);
    expect(chunkRows[1]!.alignment).toBeCloseTo(a2, 2);
    expect(chunkRows[2]!.alignment).toBeNull();
    const page = (300 * a1 + 100 * a2) / 400;
    expect(figures.currentAlignment).toBeCloseTo(page, 2);
    const row = await sessionRow(session);
    expect(row.baseline_alignment as number).toBeCloseTo(page, 2);
    expect(row.current_alignment as number).toBeCloseTo(page, 2);
  }, 60_000);

  it("scenario 2 - AC4 - the target band is [p50, p85] of the CITED documents' own alignment, with the page's percentile among them", async () => {
    await seedCorpus();
    const session = await addSession();
    const chunk = unit(vec({ 0: 1, 2: 0.9 })); // sits among the documents
    await addChunk(session, 0, chunk, 200);
    await inTx(async (tx) => {
      await computeCentroid(tx, session);
      await computeAlignment(tx, session);
    });
    const c = expectedCentroid();
    const docs = DOC_VECTORS.map((v) => cos(v, c)).sort((a, b) => a - b);
    const row = await sessionRow(session);
    expect(row.target_band_low as number).toBeCloseTo(percentileCont(docs, 0.5), 2);
    expect(row.target_band_high as number).toBeCloseTo(percentileCont(docs, 0.85), 2);
    const page = cos(chunk, c);
    const expectedPercentile = Math.round((100 * docs.filter((d) => d <= page).length) / docs.length);
    expect(row.percentile_vs_corpus).toBe(expectedPercentile);
    expect((row.target_band_low as number) <= (row.target_band_high as number)).toBe(true);
  }, 60_000);

  it("scenario 2 - AC4 - a document's alignment is its passages' token-weighted mean, not one vote per passage", async () => {
    // one document with a long on-centroid passage and a short far one, against one plain document: weighting decides the band.
    await addPassage(0, { embedding: vec({ 0: 1 }), tokens: 900, url: "https://same.example/p", text: "long passage" });
    await addPassage(1, { embedding: vec({ 1: 1 }), tokens: 100, url: "https://same.example/p", text: "short passage" });
    await addPassage(2, { embedding: vec({ 0: 1 }), tokens: 100 });
    const session = await addSession();
    await addChunk(session, 0, vec({ 0: 1 }), 100);
    await inTx(async (tx) => {
      await computeCentroid(tx, session);
      await computeAlignment(tx, session);
    });
    const c = unit(add(add(vec({ 0: 1 }), vec({ 1: 1 })), vec({ 0: 1 })));
    const same = (900 * cos(vec({ 0: 1 }), c) + 100 * cos(vec({ 1: 1 }), c)) / 1000;
    const plain = cos(vec({ 0: 1 }), c);
    const docs = [same, plain].sort((a, b) => a - b);
    const row = await sessionRow(session);
    expect(row.target_band_low as number).toBeCloseTo(percentileCont(docs, 0.5), 2);
  }, 60_000);

  it("scenario 2 - the absent is null, not 0: no centroid means no alignment, band or percentile, and nothing is written", async () => {
    const session = await addSession({ centroid: null });
    await addChunk(session, 0, vec({ 0: 1 }), 100);
    const figures = await inTx((tx) => computeAlignment(tx, session));
    expect(figures.measured).toBe(false);
    const row = await sessionRow(session);
    expect([row.baseline_alignment, row.current_alignment, row.target_band_low, row.target_band_high, row.percentile_vs_corpus]).toEqual([null, null, null, null, null]);
  }, 60_000);

  it("scenario 2 - with a centroid but no embedded chunk the page has no alignment and no percentile, while the band still stands", async () => {
    await seedCorpus();
    const session = await addSession();
    await addChunk(session, 0, null, 100);
    await inTx(async (tx) => {
      await computeCentroid(tx, session);
      await computeAlignment(tx, session);
    });
    const row = await sessionRow(session);
    expect(row.current_alignment).toBeNull();
    expect(row.percentile_vs_corpus).toBeNull();
    expect(row.target_band_low).not.toBeNull();
  }, 60_000);

  it("scenario 2 - computeAlignment on another workspace's session changes nothing", async () => {
    const bProject = randomUUID();
    await db.query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://b.test','b.test')`, [bProject, otherWorkspaceId, `p-${randomUUID().slice(0, 8)}`]);
    const bSession = randomUUID();
    await db.query(`INSERT INTO geo_alignments (id, workspace_id, project_id, target_url, engine_keys, embedding_model, centroid) VALUES ($1,$2,$3,'https://b.test/p','{chatgpt}',$4,$5::halfvec)`, [bSession, otherWorkspaceId, bProject, MODEL, lit(vec({ 0: 1 }))]);
    await db.query(`INSERT INTO content_chunks (workspace_id, project_id, session_id, url, chunk_index, text, token_count, content_hash, embedding, embedding_model) VALUES ($1,$2,$3,'https://b.test/p',0,'t',10,sha256('t'::bytea),$4::halfvec,$5)`, [otherWorkspaceId, bProject, bSession, lit(vec({ 0: 1 })), MODEL]);
    const figures = await inTx((tx) => computeAlignment(tx, bSession));
    expect(figures.measured).toBe(false);
    expect((await db.query("SELECT alignment FROM content_chunks WHERE session_id = $1", [bSession])).rows[0]).toEqual({ alignment: null });
    await expect(inTx((tx) => readSessionPayload(tx, bSession))).rejects.toMatchObject({ code: "not_found" });
  }, 60_000);

  // ---- scenarios 3, 4: semantic node extraction --------------------------------------------------------------------------

  async function seedTexts(texts: readonly string[]): Promise<void> {
    for (const [i, text] of texts.entries()) await addPassage(i, { text, embedding: null });
  }
  const corpusTexts = (n: number, base: (i: number) => string): string[] => Array.from({ length: n }, (_, i) => base(i));

  it("scenario 3 - AC5 - a concept in most cited documents, absent from the page, becomes a node with its prevalence, its evidence and its URL", async () => {
    await seedTexts(corpusTexts(10, (i) => `Filler sentence number ${String(i)} here. ${i < 7 ? "We provide audit logging for every account." : "We provide dashboards."}`));
    const session = await addSession();
    const result = await extractSemanticNodes(deps(), session);
    expect(result.nodes).toBeGreaterThan(0);
    const node = await nodeByPhrase("audit logging");
    expect(node.corpus_doc_ratio as number).toBeCloseTo(0.7, 5);
    expect(node.corpus_frequency).toBe(7);
    expect(String(node.evidence_snippet)).toContain("audit logging");
    expect(String(node.evidence_url)).toMatch(/^https:\/\/doc\d\.example\/p$/);
    expect(node.prompt_cluster_id).toBe(clusterId);
    expect(node.embedding).toBeNull(); // waiting for its vector
    expect(node.embedding_model).toBeNull(); // the model is written WITH the vector, never before it
  }, 60_000);

  it("scenario 4 - AC5 - a concept below the prevalence threshold is NOT produced", async () => {
    await seedTexts(corpusTexts(10, (i) => `Filler sentence number ${String(i)} here. ${i < 2 ? "We provide zebra crossing analytics." : "We provide dashboards."}`));
    const session = await addSession();
    await extractSemanticNodes(deps(), session);
    expect((await nodeRows()).find((n) => String(n.phrase_normalized).includes("zebra crossing"))).toBeUndefined();
  }, 60_000);

  it("AC6 - nodes are typed by the deterministic map; compliance, metric and pricing set the review flag", async () => {
    await seedTexts(corpusTexts(10, () => "We hold a SOC 2 report. We guarantee 99.9% uptime. Pricing is per seat. We support audit logging."));
    const session = await addSession();
    await extractSemanticNodes(deps(), session);
    const types = new Map((await nodeRows()).map((n) => [n.phrase_normalized as string, { type: n.node_type as string, review: n.requires_human_review as boolean }]));
    expect(types.get("soc 2 report")).toEqual({ type: "compliance", review: true });
    expect(types.get("99.9% uptime")).toEqual({ type: "metric", review: true });
    expect(types.get("audit logging")).toEqual({ type: "capability", review: false });
    expect([...types.values()].filter((t) => ["compliance", "metric", "pricing_term"].includes(t.type)).every((t) => t.review)).toBe(true);
    expect([...types.values()].filter((t) => !["compliance", "metric", "pricing_term"].includes(t.type)).every((t) => !t.review)).toBe(true);
  }, 60_000);

  it("owner decision 4 - semantic_nodes.embedding_model is written with every vector, through embed.batch", async () => {
    await seedTexts(corpusTexts(10, () => "We provide audit logging."));
    const session = await addSession();
    const result = await extractSemanticNodes(deps(), session);
    expect(result.embedJobs).toBeGreaterThan(0);
    expect(enqueued.every((e) => e.payload.table === "semantic_nodes")).toBe(true);
    await drainEmbedQueue();
    const rows = await nodeRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((n) => n.embedding !== null && n.embedding_model === MODEL)).toBe(true);
  }, 60_000);

  it("AC5 - a re-extraction REPLACES the cluster's nodes, scoped to the project and cluster, and a sibling cluster's nodes are left alone", async () => {
    const sibling = randomUUID();
    await addNode("sibling concept", { cluster: sibling });
    await addNode("stale concept");
    await seedTexts(corpusTexts(10, () => "We provide audit logging."));
    const session = await addSession();
    await extractSemanticNodes(deps(), session);
    const phrases = (await nodeRows()).map((n) => n.phrase_normalized);
    expect(phrases).toContain("sibling concept");
    expect(phrases).not.toContain("stale concept");
    expect(phrases).toContain("audit logging");
    await extractSemanticNodes(deps(), session);
    expect((await nodeRows()).filter((n) => n.phrase_normalized === "audit logging")).toHaveLength(1);
  }, 60_000);

  it("AC5 - an empty corpus yields no nodes and no error (an empty list, not a failure)", async () => {
    const session = await addSession();
    await expect(extractSemanticNodes(deps(), session)).resolves.toMatchObject({ nodes: 0, embedJobs: 0 });
  }, 60_000);

  it("AC7 - scenario 7 - a node with no evidence cannot be stored (the columns are NOT NULL)", async () => {
    await expect(db.query(`INSERT INTO semantic_nodes (workspace_id, project_id, phrase, phrase_normalized, node_type) VALUES ($1,$2,'x y','x y','capability')`, [workspaceId, projectId])).rejects.toThrow(/evidence_(url|snippet)/);
  }, 60_000);

  // ---- scenario 5: dedupe ------------------------------------------------------------------------------------------------

  const angle = (degrees: number): number[] => vec({ 0: Math.cos((degrees * Math.PI) / 180), 1: Math.sin((degrees * Math.PI) / 180) });
  const ACOS_95 = (Math.acos(0.95) * 180) / Math.PI;

  it("scenario 5 - AC6 - two near-duplicate nodes (cosine >= 0.93) collapse, keeping the HIGHER prevalence", async () => {
    await addNode("audit trail", { ratio: 0.5, embedding: angle(0) });
    await addNode("audit logging", { ratio: 0.8, embedding: angle(10) }); // cos 10deg = 0.985
    await addNode("single sign on", { ratio: 0.6, embedding: vec({ 5: 1 }) });
    const session = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9 });
    const summary = await inTx((tx) => analyseNodes(tx, session, words));
    expect(summary.collapsed).toBe(1);
    expect((await nodeRows()).map((n) => n.phrase_normalized)).toEqual(["audit logging", "single sign on"]);
  }, 60_000);

  it("scenario 5 - boundary - cosine 0.93 collapses, just under does not", async () => {
    const at = (Math.acos(0.93) * 180) / Math.PI;
    await addNode("alpha one", { ratio: 0.8, embedding: angle(0) });
    await addNode("alpha two", { ratio: 0.5, embedding: angle(at - 0.3) }); // cos > 0.93
    await addNode("alpha three", { ratio: 0.4, embedding: angle(at + 0.5 + 40) }); // far
    const session = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9 });
    await inTx((tx) => analyseNodes(tx, session, words));
    expect((await nodeRows()).map((n) => n.phrase_normalized)).toEqual(["alpha one", "alpha three"]);
    await db.query("TRUNCATE semantic_nodes");
    await addNode("beta one", { ratio: 0.8, embedding: angle(0) });
    await addNode("beta two", { ratio: 0.5, embedding: angle(at + 0.5) }); // cos < 0.93
    const second = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9 });
    await inTx((tx) => analyseNodes(tx, second, words));
    expect(await nodeRows()).toHaveLength(2);
  }, 60_000);

  it("scenario 5 - a chain A~B~C where A and C are NOT near: B collapses into A, and C survives (B was removed, so it removes nothing)", async () => {
    await addNode("chain a", { ratio: 0.9, embedding: angle(0) });
    await addNode("chain b", { ratio: 0.8, embedding: angle(ACOS_95) });
    await addNode("chain c", { ratio: 0.7, embedding: angle(2 * ACOS_95) });
    const session = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9 });
    await inTx((tx) => analyseNodes(tx, session, words));
    expect((await nodeRows()).map((n) => n.phrase_normalized)).toEqual(["chain a", "chain c"]);
  }, 60_000);

  it("scenario 5 - equal prevalence is a tie: the shorter phrase is kept, and the result does not depend on row order", async () => {
    await addNode("role based access control", { ratio: 0.5, embedding: angle(0) });
    await addNode("access control", { ratio: 0.5, embedding: angle(5) });
    const session = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9 });
    await inTx((tx) => analyseNodes(tx, session, words));
    expect((await nodeRows()).map((n) => n.phrase_normalized)).toEqual(["access control"]);
  }, 60_000);

  it("scenario 5 - nodes of different clusters never collapse into each other, and an unembedded node is never collapsed", async () => {
    const sibling = randomUUID();
    await addNode("same concept", { ratio: 0.9, embedding: angle(0) });
    await addNode("same concept sibling", { ratio: 0.9, embedding: angle(1), cluster: sibling });
    await addNode("waiting for vector", { ratio: 0.1, embedding: null });
    const session = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9 });
    await inTx((tx) => analyseNodes(tx, session, words));
    expect(await nodeRows()).toHaveLength(3);
  }, 60_000);

  // ---- scenario 6: presence ----------------------------------------------------------------------------------------------

  it("scenario 6 - AC8 - a phrase present in the content, however it is cased or punctuated, is present; an absent one is not", async () => {
    await addNode("audit logging", { embedding: vec({ 0: 1 }) });
    await addNode("single sign-on", { embedding: vec({ 3: 1 }) });
    await addNode("data residency", { embedding: vec({ 4: 1 }) });
    const session = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9, live: "# Features\n\nOur platform ships Audit-Logging, plus Single Sign-On for every seat." });
    await inTx((tx) => analyseNodes(tx, session, words));
    const present = Object.fromEntries((await nodeRows()).map((n) => [n.phrase_normalized as string, n.present_in_content]));
    expect(present["audit logging"]).toBe(true);
    expect(present["single sign-on"]).toBe(true);
    expect(present["data residency"]).toBe(false);
  }, 60_000);

  it("scenario 6 - presence is judged on the DRAFT when there is one, else on the live page", async () => {
    await addNode("audit logging", { embedding: vec({ 0: 1 }) });
    const session = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9, live: "We offer audit logging.", draft: "We offer nothing." });
    await inTx((tx) => analyseNodes(tx, session, words));
    expect((await nodeByPhrase("audit logging")).present_in_content).toBe(false);
  }, 60_000);

  it("scenario 6 - presence is on word boundaries: 'audit logging' is not present in 'unaudit logging tools'", async () => {
    await addNode("audit logging", { embedding: vec({ 0: 1 }) });
    const session = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9, live: "We sell unaudit logging tools." });
    await inTx((tx) => analyseNodes(tx, session, words));
    expect((await nodeByPhrase("audit logging")).present_in_content).toBe(false);
  }, 60_000);

  // OPEN - AC8's other half. "present_in_content = the normalised phrase, OR A PHRASE WITH COSINE >= 0.90 TO IT, appears in the draft
  // content" needs a vector for every phrase of the CONTENT, and no table holds one (content_chunks are 512-token chunks, and a chunk
  // is never within 0.90 of a 4-word phrase). Storing them is a schema change the story did not name. See the report.
  it.todo("scenario 6 - AC8 - a close paraphrase (cosine >= 0.90 to the node's phrase) is treated as present");

  // ---- coverage ----------------------------------------------------------------------------------------------------------

  it("AC8 - coverage_ratio = nodes present / nodes required", async () => {
    await addNode("audit logging", { embedding: vec({ 0: 1 }) });
    await addNode("single sign on", { embedding: vec({ 3: 1 }) });
    await addNode("data residency", { embedding: vec({ 4: 1 }) });
    await addNode("role based access", { embedding: vec({ 5: 1 }) });
    const session = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9, live: "audit logging and single sign on" });
    const summary = await inTx((tx) => analyseNodes(tx, session, words));
    expect(summary.coverageRatio).toBe(0.5);
    expect((await sessionRow(session)).coverage_ratio).toBeCloseTo(0.5, 5);
  }, 60_000);

  it("AC8 - no required node is coverage NULL, not 0 and not 1; all present is 1; none present is 0", async () => {
    const empty = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9, live: "x" });
    const summary = await inTx((tx) => analyseNodes(tx, empty, words));
    expect(summary.coverageRatio).toBeNull();
    expect((await sessionRow(empty)).coverage_ratio).toBeNull();
    await addNode("audit logging", { embedding: vec({ 0: 1 }) });
    const none = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9, live: "nothing relevant" });
    expect((await inTx((tx) => analyseNodes(tx, none, words))).coverageRatio).toBe(0);
    const all = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9, live: "we have audit logging" });
    expect((await inTx((tx) => analyseNodes(tx, all, words))).coverageRatio).toBe(1);
  }, 60_000);

  // ---- scenario 8: projected gain ----------------------------------------------------------------------------------------

  it("scenario 8 - AC9 - projected gain for a known insertion matches the documented additive-blend approximation", async () => {
    const c = unit(vec({ 0: 1, 1: 1 }));
    const chunk = vec({ 0: 1 });
    const phrase = vec({ 1: 1 });
    const session = await addSession({ centroid: c, sourceCount: 9, live: "unrelated" });
    await addChunk(session, 0, chunk, 100);
    await addNode("alpha beta gamma delta", { embedding: phrase });
    await inTx((tx) => analyseNodes(tx, session, words));
    const expected = expectedGain(chunk, c, phrase, 4, 100);
    expect(expected).toBeGreaterThan(0.05);
    expect((await nodeByPhrase("alpha beta gamma delta")).projected_gain as number).toBeCloseTo(expected, 2);
  }, 60_000);

  it("scenario 8 - AC9 - alpha is capped at 0.25: a 5-token phrase in a 10-token chunk moves it by the cap, not by 5/15 x 3.5", async () => {
    const c = unit(vec({ 0: 1, 1: 1 }));
    const chunk = vec({ 0: 1 });
    const phrase = vec({ 1: 1 });
    const session = await addSession({ centroid: c, sourceCount: 9, live: "unrelated" });
    await addChunk(session, 0, chunk, 10);
    await addNode("one two three four five", { embedding: phrase });
    await inTx((tx) => analyseNodes(tx, session, words));
    const capped = expectedGain(chunk, c, phrase, 5, 10);
    const uncapped = cos(unit(add(chunk, phrase, 1 - (5 / 15) * 3.5 < 0 ? 0 : 1 - (5 / 15) * 3.5, (5 / 15) * 3.5)), c) - cos(chunk, c);
    const got = (await nodeByPhrase("one two three four five")).projected_gain as number;
    expect(got).toBeCloseTo(capped, 2);
    expect(Math.abs(got - uncapped)).toBeGreaterThan(0.01);
  }, 60_000);

  it("scenario 8 - the gain is the BEST chunk's: the chunk the phrase helps most decides it", async () => {
    const c = unit(vec({ 0: 1, 1: 1 }));
    const near = vec({ 0: 1 });
    const far = unit(vec({ 0: 1, 2: 1 }));
    const phrase = vec({ 1: 1 });
    const session = await addSession({ centroid: c, sourceCount: 9, live: "unrelated" });
    await addChunk(session, 0, near, 100);
    await addChunk(session, 1, far, 100);
    await addNode("alpha beta gamma delta", { embedding: phrase });
    await inTx((tx) => analyseNodes(tx, session, words));
    const best = Math.max(expectedGain(near, c, phrase, 4, 100), expectedGain(far, c, phrase, 4, 100));
    expect((await nodeByPhrase("alpha beta gamma delta")).projected_gain as number).toBeCloseTo(best, 2);
  }, 60_000);

  it("scenario 8 - a node with no vector, a present node, or a session with no embedded chunk has gain NULL, not 0", async () => {
    const c = unit(vec({ 0: 1, 1: 1 }));
    const session = await addSession({ centroid: c, sourceCount: 9, live: "we have audit logging" });
    await addChunk(session, 0, vec({ 0: 1 }), 100);
    await addNode("audit logging", { embedding: vec({ 1: 1 }) }); // present
    await addNode("waiting for vector", { embedding: null });
    await inTx((tx) => analyseNodes(tx, session, words));
    expect((await nodeByPhrase("audit logging")).projected_gain).toBeNull();
    expect((await nodeByPhrase("waiting for vector")).projected_gain).toBeNull();
    expect((await nodeByPhrase("waiting for vector")).priority_rank).toBeNull();
  }, 60_000);

  it("scenario 8 - a node embedded under ANOTHER model is not modeled against this session's vectors (EC-23)", async () => {
    const c = unit(vec({ 0: 1, 1: 1 }));
    const session = await addSession({ centroid: c, sourceCount: 9, live: "unrelated" });
    await addChunk(session, 0, vec({ 0: 1 }), 100);
    const id = await addNode("alpha beta gamma delta", { embedding: vec({ 1: 1 }) });
    await db.query("UPDATE semantic_nodes SET embedding_model = 'another-model' WHERE id = $1", [id]);
    await inTx((tx) => analyseNodes(tx, session, words));
    expect((await nodeByPhrase("alpha beta gamma delta")).projected_gain).toBeNull();
  }, 60_000);

  // ---- priority and the projection ---------------------------------------------------------------------------------------

  it("AC13 - priority_rank orders by projected_gain x corpus_doc_ratio x multiplier, and compliance/metric carry 1.15", async () => {
    const c = unit(vec({ 0: 1, 1: 1 }));
    const session = await addSession({ centroid: c, sourceCount: 9, live: "unrelated" });
    await addChunk(session, 0, vec({ 0: 1 }), 100);
    // identical vectors and token counts, so the gain is identical and ONLY ratio and multiplier decide.
    await addNode("plain concept one", { type: "capability", ratio: 0.52, embedding: vec({ 1: 1 }) });
    await addNode("soc 2 report", { type: "compliance", ratio: 0.47, embedding: vec({ 1: 1 }) }); // 0.47 x 1.15 = 0.5405 > 0.52
    await addNode("plain concept two", { type: "capability", ratio: 0.3, embedding: vec({ 1: 1 }) });
    await inTx((tx) => analyseNodes(tx, session, words));
    const ranks = Object.fromEntries((await nodeRows()).map((n) => [n.phrase_normalized as string, n.priority_rank]));
    expect(ranks).toEqual({ "soc 2 report": 1, "plain concept one": 2, "plain concept two": 3 });
  }, 60_000);

  it("scenario 9 - AC9 - the projection applies 0.85^(i-1) to the i-th ranked gain; it is not a naive sum", async () => {
    const c = unit(vec({ 0: 1, 1: 1, 2: 1 }));
    const session = await addSession({ centroid: c, sourceCount: 9, live: "unrelated" });
    await addChunk(session, 0, vec({ 0: 1 }), 100);
    await addNode("first concept here", { ratio: 0.9, embedding: vec({ 1: 1 }) });
    await addNode("second concept here", { ratio: 0.8, embedding: vec({ 2: 1 }) });
    await addNode("third concept here", { ratio: 0.7, embedding: vec({ 1: 1, 2: 1 }) });
    await inTx((tx) => analyseNodes(tx, session, words));
    const payload = await inTx((tx) => readSessionPayload(tx, session));
    const recs = payload.recommendations.filter((r) => r.projected_gain !== null).sort((a, b) => a.priority_rank! - b.priority_rank!);
    expect(recs).toHaveLength(3);
    const gains = recs.map((r) => r.projected_gain!);
    const naive = gains.reduce((s, g) => s + g, 0);
    expect(payload.projection!.naive_sum).toBeCloseTo(naive, 6);
    expect(payload.projection!.diminished_sum).toBeCloseTo(gains[0]! + 0.85 * gains[1]! + 0.85 ** 2 * gains[2]!, 6);
    expect(payload.projection!.diminished_sum).toBeLessThan(naive);
    expect(payload.projection!.diminishing_returns_factor).toBe(0.85);
    expect(payload.projection!.projected_alignment).toBeLessThanOrEqual(1);
  }, 60_000);

  it("scenario 9 - the projected alignment never exceeds 1, and is NULL when the page has no alignment", async () => {
    const session = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9, live: "unrelated" });
    await addNode("alpha beta gamma delta", { embedding: vec({ 1: 1 }) });
    await inTx((tx) => analyseNodes(tx, session, words));
    const payload = await inTx((tx) => readSessionPayload(tx, session));
    expect(payload.projection === null || payload.projection.projected_alignment === null).toBe(true);
  }, 60_000);

  // ---- scenario 10, 12: the payload ---------------------------------------------------------------------------------------

  it("scenario 10 - AC9/AC12 - the payload validates against the contract, carries the estimate labelling, and declares generation disabled", async () => {
    await seedCorpus();
    const session = await addSession();
    await addChunk(session, 0, vec({ 0: 1 }), 100);
    await addNode("alpha beta gamma delta", { ratio: 0.5, embedding: vec({ 1: 1 }) });
    await inTx(async (tx) => {
      await computeCentroid(tx, session);
      await computeAlignment(tx, session);
      await analyseNodes(tx, session, words);
    });
    const payload = await inTx((tx) => readSessionPayload(tx, session));
    expect(alignmentSessionPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.estimate).toMatchObject({ method: "additive_blend_estimate", confidence: "modeled" });
    expect(payload.generation).toBe("disabled");
    expect(payload.centroid_source_count).toBe(5);
    expect(payload.low_confidence).toBe(true); // 5 < 8
    expect(payload.target_band).not.toBeNull();
  }, 60_000);

  it("scenario 12 - AC13 - a compliance node carries the review flag and a warning and is never auto-inserted", async () => {
    const c = unit(vec({ 0: 1, 1: 1 }));
    const session = await addSession({ centroid: c, sourceCount: 9, live: "unrelated" });
    await addChunk(session, 0, vec({ 0: 1 }), 100);
    const id = await addNode("soc 2 report", { type: "compliance", embedding: vec({ 1: 1 }) });
    await db.query("UPDATE semantic_nodes SET requires_human_review = true WHERE id = $1", [id]);
    await addNode("audit logging tools", { type: "capability", embedding: vec({ 2: 1 }) });
    await inTx((tx) => analyseNodes(tx, session, words));
    const payload = await inTx((tx) => readSessionPayload(tx, session));
    const compliance = payload.recommendations.find((r) => r.phrase === "soc 2 report")!;
    expect(compliance.requires_human_review).toBe(true);
    expect(compliance.accuracy_warning).toMatch(/true of your/i);
    expect(payload.recommendations.every((r) => r.auto_insert === false)).toBe(true);
    const plain = payload.recommendations.find((r) => r.phrase === "audit logging tools")!;
    expect(plain.requires_human_review).toBe(false);
    expect(plain.accuracy_warning).toBeNull();
  }, 60_000);

  it("scenario 12 - the review flag follows the node's TYPE, not only the stored column: a claim-bearing node whose flag was never set is still flagged and warned", async () => {
    const session = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9, live: "unrelated" });
    await addNode("per seat pricing", { type: "pricing_term", embedding: vec({ 1: 1 }) }); // requires_human_review stored false
    await inTx((tx) => analyseNodes(tx, session, words));
    const payload = await inTx((tx) => readSessionPayload(tx, session));
    expect(payload.recommendations[0]!.requires_human_review).toBe(true);
    expect(payload.recommendations[0]!.accuracy_warning).not.toBeNull();
    expect((await nodeByPhrase("per seat pricing")).requires_human_review).toBe(true);
  }, 60_000);

  // ---- low confidence: suppression -----------------------------------------------------------------------------------------

  it("AC13 - a low-confidence session (fewer than 8 passages) keeps recommendations to ranks 1-3; 8 passages keeps them all", async () => {
    for (const [sourceCount, expected] of [[7, 3], [8, 5]] as const) {
      await db.query("TRUNCATE semantic_nodes");
      const session = await addSession({ centroid: unit(vec({ 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 })), sourceCount, live: "unrelated" });
      await addChunk(session, 0, vec({ 0: 1 }), 100);
      for (let i = 1; i <= 5; i += 1) await addNode(`concept number ${String(i)} here`, { ratio: 0.9 - i * 0.1, embedding: vec({ [i]: 1 }) });
      await inTx((tx) => analyseNodes(tx, session, words));
      const payload = await inTx((tx) => readSessionPayload(tx, session));
      expect(payload.low_confidence).toBe(sourceCount < 8);
      expect(payload.recommendations).toHaveLength(expected);
      if (sourceCount < 8) expect(payload.recommendations.every((r) => r.priority_rank !== null && r.priority_rank <= 3)).toBe(true);
    }
  }, 60_000);

  it("AC13 - fail closed: under low confidence a missing node with no modeled gain (no rank) is dropped, not shown", async () => {
    const session = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 3, live: "unrelated" });
    await addNode("waiting for vector", { embedding: null });
    await inTx((tx) => analyseNodes(tx, session, words));
    expect((await inTx((tx) => readSessionPayload(tx, session))).recommendations).toEqual([]);
    const enough = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9, live: "unrelated" });
    await inTx((tx) => analyseNodes(tx, enough, words));
    const shown = (await inTx((tx) => readSessionPayload(tx, enough))).recommendations;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ projected_gain: null, priority_rank: null });
  }, 60_000);

  // ---- tenancy and observability ------------------------------------------------------------------------------------------

  it("RLS - workspace B's passages never become workspace A's nodes, and A cannot read B's session or nodes", async () => {
    await addPassage(0, { text: "We provide hidden telemetry. We provide hidden telemetry.", ws: otherWorkspaceId, embedding: null });
    const session = await addSession();
    const result = await extractSemanticNodes(deps(), session);
    expect(result.nodes).toBe(0);
    await db.query(`INSERT INTO semantic_nodes (workspace_id, project_id, prompt_cluster_id, phrase, phrase_normalized, node_type, evidence_url, evidence_snippet) VALUES ($1,$2,$3,'b only','b only','capability','https://b.example','b only')`, [otherWorkspaceId, projectId, clusterId]);
    const seen = await inTx((tx) => tx.query("SELECT count(*)::int AS n FROM semantic_nodes"));
    expect(seen.rows[0]).toEqual({ n: 0 });
  }, 60_000);

  it("observability - a span, a metric and ONE redacted log line per step (the workspace ID; no URL, phrase, snippet or page text)", async () => {
    const log = vi.spyOn(Logger.prototype, "log");
    exporter.reset();
    await seedTexts(corpusTexts(10, () => "We provide confidential audit logging."));
    const session = await addSession({ centroid: vec({ 0: 1 }), sourceCount: 9, live: "page text secret-marker" });
    await addChunk(session, 0, vec({ 0: 1 }), 100);
    await extractSemanticNodes(deps(), session);
    await inTx(async (tx) => {
      await computeAlignment(tx, session);
      await analyseNodes(tx, session, words);
    });
    const spans = exporter.getFinishedSpans().map((s) => s.name);
    expect(spans).toEqual(expect.arrayContaining(["geo.alignment.extract_nodes", "geo.alignment.compute", "geo.alignment.analyse_nodes"]));
    const entries = log.mock.calls.map((call) => call[0] as Record<string, unknown>).filter((entry) => typeof entry === "object" && entry !== null);
    expect(entries.some((e) => typeof e.metric === "string" && /^nominara_geo_alignment_[a-z_]+$/.test(e.metric))).toBe(true);
    const events = entries.filter((e) => typeof e.event === "string" && e.event.startsWith("geo.alignment."));
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const event of events) expect(event.workspace_id).toBe(workspaceId);
    const text = JSON.stringify(events);
    expect(text).not.toMatch(/audit logging|doc\d\.example|secret-marker|confidential/i);
    log.mockRestore();
  }, 60_000);
});
