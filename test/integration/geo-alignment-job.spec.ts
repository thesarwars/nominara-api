import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { geoAnalysisWriteSchema } from "../../contracts/analytics/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { embedBatchPayloadSchema } from "../../src/lib/embedding/embed-batch.js";
import {
  advanceAlignmentDraft,
  advanceAlignmentSession,
  createAlignmentPatch,
  openAlignmentSession,
  readSessionPayload,
  saveAlignmentDraft,
  type AdvanceDeps,
} from "../../src/lib/geo/alignment/index.js";
import type { PageFetcher, PageFetchResult } from "../../src/lib/geo/corpus/page-fetcher.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createEmbedBatchHandler } from "../../src/lib/queue/handlers/embed-batch.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { StandInEmbeddingProvider, STAND_IN_EMBEDDING_MODEL } from "../../src/modules/prompts/adapters/stand-in-embedding-provider.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-192 - the alignment job (open -> corpus -> vectors -> centroid -> alignment -> nodes -> analysis) and the debounced draft recompute,
// against real Postgres + pgvector under the RUNTIME role, with the deterministic stand-in embedding provider run through the REAL embed.batch
// handler. No provider, no network: the page fetcher is a fake at the port boundary.

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));

const KEYS = { current: { kid: "k1", key: Buffer.from("embed-batch-test-signing-key-32by") } };
const EMBED_ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "embed.batch")!;
const MODEL = STAND_IN_EMBEDDING_MODEL;
const words = { count: (text: string): number => (text.trim() === "" ? 0 : text.trim().split(/\s+/).length) };
const PAGE_URL = "https://brand.test/p";

const sentencePage = (sections: readonly (readonly [string, string])[]): string =>
  `<html><body><main>${sections.map(([title, body]) => `<h2>${title}</h2><p>${body}</p>`).join("")}</main></body></html>`;
const sha256 = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

describe("STORY-192 - the alignment job and the debounced draft recompute", () => {
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
  let clock = new Date();

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
    await db.query("TRUNCATE geo_analyses, patches, semantic_nodes, content_chunks, corpus_passages, geo_alignments, projects, workspaces CASCADE");
    [workspaceId, otherWorkspaceId, projectId, clusterId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'Secret Workspace Name', $2, 'growth')", [ws, `w-${randomUUID().slice(0, 8)}`]);
    }
    await db.query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, 'P', $3, 'https://brand.test', 'brand.test')`, [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`]);
    enqueued.length = 0;
    fetchCalls.length = 0;
    pages = new Map();
    fetchSawOpenTx = false;
    txOpen = false;
    clock = new Date(); // the debounce and the deadlines meet the database's own clock, so the injected one starts at the real one
    exporter.reset();
  });

  // ---- fixtures ---------------------------------------------------------------------------------------------------------

  const fetchPage: PageFetcher = async (url) => {
    fetchSawOpenTx ||= txOpen;
    fetchCalls.push(url);
    return pages.get(url) ?? { kind: "failed", reason: "not_found" };
  };

  function deps(over: Partial<AdvanceDeps> = {}, ws: string = workspaceId): AdvanceDeps {
    return {
      workspaceId: ws,
      runInTx: async (fn) => {
        txOpen = true;
        try {
          return await withTenantContext(appDb, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, fn);
        } finally {
          txOpen = false;
        }
      },
      fetchPage,
      tokenizer: words,
      providerModel: MODEL,
      enqueueEmbed: async (_queue, w, payload, key) => {
        expect(txOpen).toBe(false); // an enqueue happens AFTER a commit, never inside a transaction
        enqueued.push({ workspaceId: w, payload, key });
      },
      now: () => clock,
      ...over,
    };
  }

  const inTx = <T,>(fn: (tx: ClientBase) => Promise<T>, ws: string = workspaceId): Promise<T> => withTenantContext(appDb, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, fn);

  async function drainEmbedQueue(): Promise<void> {
    const context = { pool: undefined, env: { NODE_ENV: "test" } } as unknown as QueueHandlerContext;
    const process = createJobProcessor(EMBED_ENTRY, { keys: KEYS, getClient: () => appDb, process: createEmbedBatchHandler(context, { provider: new StandInEmbeddingProvider() }) });
    while (enqueued.length > 0) {
      const job = enqueued.shift()!;
      const payload = embedBatchPayloadSchema.parse({ ...job.payload, workspaceId: job.workspaceId, kid: "k1" });
      await process({ data: signQueueJobPayload(payload, KEYS.current.key) } as unknown as Job);
    }
  }

  /** What the route inserts: a PENDING session with no live content yet. */
  async function pendingSession(over: { model?: string; createdAt?: Date } = {}): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO geo_alignments (id, workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model, created_at)
       VALUES ($1,$2,$3,$4,$5,'{chatgpt}',$6,$7)`,
      [id, workspaceId, projectId, PAGE_URL, clusterId, over.model ?? MODEL, over.createdAt ?? clock],
    );
    return id;
  }

  /**
   * `n` cited competitor pages for the cluster's one prompt, each carrying several shared concepts, so the corpus build (which keeps ONLY the
   * current top-K candidates) finds them and the scope yields more concepts than a low-confidence session may show.
   */
  async function seedCorpus(n = 5): Promise<string[]> {
    const promptId = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status, cluster_id)
       VALUES ($1,$2,$3,'best reporting tools for teams', sha256('best reporting tools for teams'::bytea),'recommendation','consideration','active',$4)`,
      [promptId, workspaceId, projectId, clusterId],
    );
    const urls: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const url = `https://doc${String(i)}.example/p`;
      urls.push(url);
      const normalized = url;
      await db.query(
        `INSERT INTO citation_facts (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url, url_hash, domain, is_owned, position_weight)
         VALUES ($1,$2,$3,$4,'perplexity', now() - interval '1 day', 1, $5, $5, $6, $7, false, 1)`,
        [workspaceId, projectId, randomUUID(), promptId, normalized, sha256(normalized), `doc${String(i)}.example`],
      );
      pages.set(url, {
        kind: "html",
        html: `<html><body><main><h1>Reporting tools guide ${String(i)}</h1><p>Marker${String(i)}x. Reporting tools for teams differ. We provide audit logging for every account. We hold a SOC 2 report. We offer role based access. We offer data residency options. We offer webhook delivery.</p></main></body></html>`,
      });
    }
    return urls;
  }

  const sessionRow = async (id: string) => (await db.query("SELECT * FROM geo_alignments WHERE id = $1", [id])).rows[0] as Record<string, unknown>;
  const livePage = sentencePage([["Reporting", "Teams compare reporting tools by export formats."], ["Pricing", "Plans start free for small teams."]]);

  /** Drives a session to its end the way the queue would: advance, let embed.batch run, advance again. */
  async function driveToEnd(id: string, over: Partial<AdvanceDeps> = {}): Promise<string[]> {
    const states: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const outcome = await advanceAlignmentSession(deps(over), id);
      states.push(outcome.state);
      if (outcome.state !== "waiting") break;
      await drainEmbedQueue();
    }
    return states;
  }

  // ---- AC: job processor ------------------------------------------------------------------------------------------------

  it("AC job-1 - a pending session is fetched OUTSIDE a transaction, waits while any chunk or passage lacks a vector, and is READY once they are in", async () => {
    pages.set(PAGE_URL, { kind: "html", html: livePage });
    const corpusUrls = await seedCorpus();
    const id = await pendingSession();

    const first = await advanceAlignmentSession(deps(), id);
    expect(first).toMatchObject({ state: "waiting" });
    expect(fetchCalls.filter((u) => u === PAGE_URL)).toHaveLength(1);
    expect(fetchSawOpenTx).toBe(false); // the page AND every cited page were fetched with no transaction open
    expect(String((await sessionRow(id)).live_content_md)).toContain("Reporting");
    expect((await sessionRow(id)).analysis_state).toBe("pending");
    // asks for the vectors it waits on: the page's chunks and the corpus passages
    expect(new Set(enqueued.map((e) => e.payload.table))).toEqual(new Set(["content_chunks", "corpus_passages"]));

    // while it waits, the payload says pending and shows NO partial figure as final
    const waiting = await inTx((tx) => readSessionPayload(tx, id));
    expect(waiting).toMatchObject({ status: "pending", coverage_ratio: null, recommendations: [], projection: null, draft_status: null });
    expect(waiting.baseline_alignment).toBeNull();

    const states = await driveToEnd(id);
    expect(states.at(-1)).toBe("ready");
    expect([...fetchCalls].sort()).toEqual([PAGE_URL, ...corpusUrls].sort()); // the page and each cited page were fetched ONCE across every advance
    const ready = await inTx((tx) => readSessionPayload(tx, id));
    expect(ready.status).toBe("ready");
    expect(ready.status_reason).toBeNull();
    expect(ready.centroid_source_count).toBe(5);
    expect(ready.baseline_alignment).not.toBeNull();
    expect(ready.coverage_ratio).not.toBeNull();
    expect(ready.target_band).not.toBeNull();
  }, 120_000);

  it("AC job-1b - a redelivered open writes the page ONCE: a second open of the same session id adds no chunk and does not rewrite the live page", async () => {
    pages.set(PAGE_URL, { kind: "html", html: livePage });
    const id = await pendingSession();
    const input = { projectId, clusterId, targetUrl: PAGE_URL, engineKeys: ["chatgpt"], createdBy: null, sessionId: id };
    const first = await openAlignmentSession({ ...deps(), embeddingModel: MODEL }, input);
    expect(first.chunks).toBeGreaterThan(0);
    const before = (await db.query("SELECT count(*)::int AS n FROM content_chunks WHERE session_id = $1", [id])).rows[0].n;
    pages.set(PAGE_URL, { kind: "html", html: sentencePage([["Changed", "A different page on the second delivery."]]) });
    const second = await openAlignmentSession({ ...deps(), embeddingModel: MODEL }, input);
    expect(second.sessionId).toBe(id);
    expect(second.embedJobs).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM content_chunks WHERE session_id = $1", [id])).rows[0].n).toBe(before);
    expect(String((await sessionRow(id)).live_content_md)).toContain("Reporting");
    expect(String((await sessionRow(id)).live_content_md)).not.toContain("Changed");
    expect((await db.query("SELECT count(*)::int AS n FROM geo_alignments")).rows[0].n).toBe(1);
  }, 60_000);

  it("AC job-2 - no fetch, embedding or enqueue happens inside a transaction, and every advance past `ready` is a no-op", async () => {
    pages.set(PAGE_URL, { kind: "html", html: livePage });
    await seedCorpus();
    const id = await pendingSession();
    await driveToEnd(id);
    fetchCalls.length = 0;
    enqueued.length = 0;
    const again = await advanceAlignmentSession(deps(), id);
    expect(again).toMatchObject({ state: "settled" });
    expect(fetchCalls).toEqual([]);
    expect(enqueued).toEqual([]);
    expect((await db.query("SELECT count(*)::int AS n FROM geo_analyses WHERE analysis = 'alignment'")).rows[0]).toEqual({ n: 1 });
  }, 120_000);

  it("AC model - a session opened under another embedding model is marked STALE with a stated reason, not left waiting; nothing is fetched or embedded for it", async () => {
    pages.set(PAGE_URL, { kind: "html", html: livePage });
    await seedCorpus();
    const id = await pendingSession({ model: "text-embedding-3-large@1536" });
    const outcome = await advanceAlignmentSession(deps(), id);
    expect(outcome).toEqual({ state: "stale", reason: "embedding_model_changed" });
    expect(fetchCalls).toEqual([]);
    expect(enqueued).toEqual([]);
    const row = await sessionRow(id);
    expect([row.analysis_state, row.analysis_reason]).toEqual(["stale", "embedding_model_changed"]);
    const payload = await inTx((tx) => readSessionPayload(tx, id));
    expect(payload).toMatchObject({ status: "stale", status_reason: "embedding_model_changed", coverage_ratio: null, recommendations: [] });
    // and a later advance leaves it alone
    expect(await advanceAlignmentSession(deps(), id)).toMatchObject({ state: "settled" });
  }, 60_000);

  it("AC model - the same model is NOT stale (boundary: an equal model string proceeds)", async () => {
    pages.set(PAGE_URL, { kind: "html", html: livePage });
    const id = await pendingSession({ model: MODEL });
    expect((await advanceAlignmentSession(deps(), id)).state).not.toBe("stale");
  }, 60_000);

  it("AC job-3 - a page the guard refuses or that fails FAILS the session with a short reason and no address", async () => {
    pages.set(PAGE_URL, { kind: "refused", reason: "address_not_global" });
    const id = await pendingSession();
    const outcome = await advanceAlignmentSession(deps(), id);
    expect(outcome.state).toBe("failed");
    expect(outcome.reason).toBe("page_refused:address_not_global");
    expect(String(outcome.reason)).not.toContain("brand.test");
    const payload = await inTx((tx) => readSessionPayload(tx, id));
    expect(payload).toMatchObject({ status: "failed", status_reason: "page_refused:address_not_global" });
    expect((await db.query("SELECT count(*)::int AS n FROM content_chunks WHERE session_id = $1", [id])).rows[0]).toEqual({ n: 0 });
  }, 60_000);

  it("AC job-4 - vectors that never arrive fail the session at the deadline (embedding_timeout), never `pending` for ever; just inside the deadline it still waits", async () => {
    pages.set(PAGE_URL, { kind: "html", html: livePage });
    await seedCorpus();
    const id = await pendingSession({ createdAt: clock });
    expect((await advanceAlignmentSession(deps(), id)).state).toBe("waiting");
    clock = new Date(clock.getTime() + 30 * 60_000 - 1);
    expect((await advanceAlignmentSession(deps(), id)).state).toBe("waiting");
    clock = new Date(clock.getTime() + 2);
    const late = await advanceAlignmentSession(deps(), id);
    expect(late).toEqual({ state: "failed", reason: "embedding_timeout" });
    expect((await sessionRow(id)).analysis_state).toBe("failed");
  }, 60_000);

  it("AC suppress - below 8 cited passages the session is low-confidence and only ranks 1-3 are kept, though more concepts were ranked", async () => {
    pages.set(PAGE_URL, { kind: "html", html: livePage });
    await seedCorpus(5);
    const id = await pendingSession();
    await driveToEnd(id);
    const payload = await inTx((tx) => readSessionPayload(tx, id));
    expect(payload.status).toBe("ready");
    expect(payload.low_confidence).toBe(true);
    const ranked = (await db.query("SELECT count(*)::int AS n FROM semantic_nodes WHERE priority_rank IS NOT NULL AND collapsed_into_id IS NULL")).rows[0].n as number;
    expect(ranked).toBeGreaterThan(3);
    expect(payload.recommendations.length).toBeGreaterThan(0);
    expect(payload.recommendations.length).toBeLessThanOrEqual(3);
    expect(payload.recommendations.every((r) => r.priority_rank !== null && r.priority_rank <= 3)).toBe(true);
  }, 120_000);

  it("AC analysis - the finished session is written through the geo_analyses layer: a valid finding per shown concept, evidenced, naming its task rule; a re-run replaces it", async () => {
    pages.set(PAGE_URL, { kind: "html", html: livePage });
    await seedCorpus();
    const id = await pendingSession();
    await driveToEnd(id);
    const rows = (await db.query("SELECT * FROM geo_analyses WHERE analysis = 'alignment'")).rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.project_id).toBe(projectId);
    expect(row.sufficient).toBe(true);
    expect(row.evidence_passages).toBe(5);
    const findings = row.findings as { id: string; evidence: { url: string; snippet: string }[]; task_rule_code?: string; no_action?: true }[];
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.length).toBeLessThanOrEqual(3);
    expect(findings.every((f) => f.evidence.length >= 1 && f.task_rule_code === "TG-ALIGNMENT-NODE")).toBe(true);
    // it satisfies the same write contract every analysis does
    expect(geoAnalysisWriteSchema.safeParse({
      analysis: "alignment", window_start: String(row.window_start instanceof Date ? row.window_start.toISOString().slice(0, 10) : row.window_start), window_days: row.window_days,
      score: row.score === null ? null : Number(row.score), score_label: row.score_label, evidence_cells: row.evidence_cells, evidence_passages: row.evidence_passages,
      sufficient: row.sufficient, suppression_reason: row.suppression_reason, findings, lever_rank: row.lever_rank,
    }).success).toBe(true);
  }, 120_000);

  it("AC analysis - a corpus that never embedded a passage is written as an INSUFFICIENT analysis with its reason, never a score", async () => {
    pages.set(PAGE_URL, { kind: "html", html: livePage });
    const id = await pendingSession(); // no cited corpus at all
    const states = await driveToEnd(id);
    expect(states.at(-1)).toBe("ready");
    const row = (await db.query("SELECT sufficient, score, suppression_reason, findings FROM geo_analyses WHERE analysis = 'alignment'")).rows[0];
    expect(row).toMatchObject({ sufficient: false, score: null, findings: [] });
    expect(String(row.suppression_reason).length).toBeGreaterThan(0);
    const payload = await inTx((tx) => readSessionPayload(tx, id));
    expect(payload).toMatchObject({ status: "ready", baseline_alignment: null, current_alignment: null, centroid_source_count: 0 });
  }, 120_000);

  it("tenancy - another workspace's job cannot advance a session it does not own: the session is `gone` and unchanged", async () => {
    pages.set(PAGE_URL, { kind: "html", html: livePage });
    const id = await pendingSession();
    const outcome = await advanceAlignmentSession(deps({}, otherWorkspaceId), id);
    expect(outcome.state).toBe("gone");
    expect(fetchCalls).toEqual([]);
    expect((await sessionRow(id)).analysis_state).toBe("pending");
  }, 60_000);

  it("observability - an advance emits a span and a counter, and its log line carries the workspace ID and no page text or workspace name", async () => {
    pages.set(PAGE_URL, { kind: "html", html: livePage });
    const log = vi.spyOn(Logger.prototype, "log");
    const id = await pendingSession();
    await advanceAlignmentSession(deps(), id);
    expect(exporter.getFinishedSpans().map((s) => s.name)).toContain("geo.alignment.advance");
    const lines = log.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(lines.some((l) => l.includes("nominara_geo_alignment_advance_total"))).toBe(true);
    const mine = lines.filter((l) => l.includes("geo.alignment.advanced"));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((l) => l.includes(workspaceId))).toBe(true);
    for (const l of lines) {
      expect(l).not.toContain("Secret Workspace Name");
      expect(l).not.toContain("Teams compare reporting tools");
      expect(l).not.toContain(PAGE_URL);
    }
    log.mockRestore();
  }, 60_000);

  // ---- AC: draft recompute ----------------------------------------------------------------------------------------------

  async function readySession(): Promise<string> {
    pages.set(PAGE_URL, { kind: "html", html: livePage });
    await seedCorpus();
    const id = await pendingSession();
    await driveToEnd(id);
    return id;
  }
  const liveChunkFigures = async (id: string) => (await db.query("SELECT chunk_index, alignment, text FROM content_chunks WHERE session_id = $1 AND NOT is_draft ORDER BY chunk_index", [id])).rows;

  it("AC draft-1 - saving a draft stores it, replaces its chunks, marks the recompute pending and pushes the due time forward; the LIVE page is untouched", async () => {
    const id = await readySession();
    const before = await sessionRow(id);
    const liveBefore = await liveChunkFigures(id);
    const saved = await inTx((tx) => saveAlignmentDraft(tx, words, id, "# Reporting\n\nWe provide audit logging and webhook delivery.", 2000));
    const row = await sessionRow(id);
    expect(row.draft_content_md).toBe("# Reporting\n\nWe provide audit logging and webhook delivery.");
    expect(row.draft_state).toBe("pending");
    expect(row.draft_recompute_due_at).not.toBeNull();
    expect(saved.chunkIds.length).toBeGreaterThan(0);
    expect((await db.query("SELECT count(*)::int AS n FROM content_chunks WHERE session_id = $1 AND is_draft", [id])).rows[0].n).toBe(saved.chunkIds.length);
    // live is untouched
    expect(row.live_content_md).toBe(before.live_content_md);
    expect(row.baseline_alignment).toBe(before.baseline_alignment);
    expect(await liveChunkFigures(id)).toEqual(liveBefore);
    // a SECOND save replaces the first draft's chunks (it does not accumulate) and moves the due time later, never earlier
    const firstDue = new Date(row.draft_recompute_due_at as Date).getTime();
    await new Promise((r) => setTimeout(r, 20));
    await inTx((tx) => saveAlignmentDraft(tx, words, id, "# Pricing\n\nPlans start free.", 2000));
    expect((await db.query("SELECT text FROM content_chunks WHERE session_id = $1 AND is_draft", [id])).rows.map((r: { text: string }) => r.text).join(" ")).not.toContain("audit logging");
    expect(new Date((await sessionRow(id)).draft_recompute_due_at as Date).getTime()).toBeGreaterThan(firstDue);
  }, 120_000);

  it("AC draft-2 - DEBOUNCED: a job that fires before the due time does nothing; once due it recomputes ONCE over the last text, and a repeat is idle", async () => {
    const id = await readySession();
    await inTx((tx) => saveAlignmentDraft(tx, words, id, "first edit about audit logging", 60_000));
    await inTx((tx) => saveAlignmentDraft(tx, words, id, "final edit about webhook delivery and audit logging", 60_000));
    const early = await advanceAlignmentDraft(deps(), id);
    expect(early.state).toBe("not_due");
    expect(early.dueInMs).toBeGreaterThan(0);
    expect((await sessionRow(id)).draft_state).toBe("pending");
    expect(enqueued).toEqual([]);

    await db.query("UPDATE geo_alignments SET draft_recompute_due_at = now() - interval '1 second' WHERE id = $1", [id]);
    const first = await advanceAlignmentDraft(deps(), id);
    expect(first.state).toBe("waiting"); // the draft's chunks still lack vectors
    expect(enqueued.some((e) => e.payload.table === "content_chunks")).toBe(true);
    await drainEmbedQueue();
    const done = await advanceAlignmentDraft(deps(), id);
    expect(done.state).toBe("ready");
    const row = await sessionRow(id);
    expect(row.draft_state).toBe("ready");
    expect(row.draft_recompute_due_at).toBeNull();
    expect(row.current_alignment).not.toBeNull();
    // a redelivered or superseded job finds nothing due
    expect((await advanceAlignmentDraft(deps(), id)).state).toBe("idle");
  }, 120_000);

  it("AC draft-3 - a draft recompute NEVER overwrites the live alignment: baseline, live chunk figures and live content are exactly as they were", async () => {
    const id = await readySession();
    const before = await sessionRow(id);
    const liveBefore = await liveChunkFigures(id);
    await inTx((tx) => saveAlignmentDraft(tx, words, id, "We provide audit logging, role based access, data residency options and webhook delivery for every account.", 0));
    await db.query("UPDATE geo_alignments SET draft_recompute_due_at = now() - interval '1 second' WHERE id = $1", [id]);
    for (let i = 0; i < 6; i += 1) {
      const outcome = await advanceAlignmentDraft(deps(), id);
      if (outcome.state !== "waiting") break;
      await drainEmbedQueue();
    }
    const after = await sessionRow(id);
    expect(after.draft_state).toBe("ready");
    expect(after.baseline_alignment).toBe(before.baseline_alignment);
    expect(after.live_content_md).toBe(before.live_content_md);
    expect(await liveChunkFigures(id)).toEqual(liveBefore);
    // the draft was measured: its figure is its own, and it is not the live one
    expect(after.current_alignment).not.toBeNull();
    expect(after.current_alignment).not.toBe(before.current_alignment);
    const payload = await inTx((tx) => readSessionPayload(tx, id));
    expect(payload).toMatchObject({ status: "ready", draft_status: "ready" });
  }, 120_000);

  it("AC draft-4 - a draft whose vectors never arrive is FAILED at its deadline, not pending for ever", async () => {
    const id = await readySession();
    await inTx((tx) => saveAlignmentDraft(tx, words, id, "We provide something entirely new here.", 0));
    await db.query("UPDATE geo_alignments SET draft_recompute_due_at = now() - interval '1 second' WHERE id = $1", [id]);
    expect((await advanceAlignmentDraft(deps(), id)).state).toBe("waiting");
    clock = new Date(Date.now() + 10 * 60_000 + 60_000);
    expect((await advanceAlignmentDraft(deps(), id)).state).toBe("failed");
    expect((await sessionRow(id)).draft_state).toBe("failed");
  }, 120_000);

  it("tenancy - another workspace cannot save a draft on, or advance the draft of, a session it does not own", async () => {
    const id = await readySession();
    await expect(inTx((tx) => saveAlignmentDraft(tx, words, id, "intrusion", 0), otherWorkspaceId)).rejects.toMatchObject({ code: "not_found" });
    expect((await advanceAlignmentDraft(deps({}, otherWorkspaceId), id)).state).toBe("gone");
    expect((await sessionRow(id)).draft_content_md).toBeNull();
  }, 120_000);

  // ---- AC: patch --------------------------------------------------------------------------------------------------------

  async function draftedSession(draft: string): Promise<string> {
    const id = await readySession();
    await inTx((tx) => saveAlignmentDraft(tx, words, id, draft, 0));
    await db.query("UPDATE geo_alignments SET draft_recompute_due_at = now() - interval '1 second' WHERE id = $1", [id]);
    for (let i = 0; i < 6; i += 1) {
      const outcome = await advanceAlignmentDraft(deps(), id);
      if (outcome.state !== "waiting") break;
      await drainEmbedQueue();
    }
    return id;
  }

  it("AC patch-1 - the patch is the customer's own draft with the precondition hash of the live page, a reversal, and the concepts the draft ADDS; nothing is generated", async () => {
    const draft = "Reporting. Teams compare reporting tools by export formats. We provide audit logging and we hold a SOC 2 report.";
    const id = await draftedSession(draft);
    const patchId = await inTx((tx) => createAlignmentPatch(tx, id, null));
    const patch = (await db.query("SELECT * FROM patches WHERE id = $1", [patchId])).rows[0] as Record<string, unknown>;
    const live = String((await sessionRow(id)).live_content_md);
    expect(patch).toMatchObject({ project_id: projectId, session_id: id, kind: "markdown", target_url: PAGE_URL, content_after: draft, rule_code: null, finding_id: null });
    expect(Buffer.from(patch.content_before_hash as Buffer).equals(sha256(live))).toBe(true);
    expect(patch.preconditions).toEqual([{ kind: "page_hash", value: `sha256:${sha256(live).toString("hex")}` }]);
    expect(patch.reversal).toEqual({ operation: "replace_file", content: live });
    expect(String(patch.derivation).length).toBeGreaterThan(0);
    const added = (await db.query("SELECT phrase_normalized FROM semantic_nodes WHERE id = ANY($1::uuid[])", [patch.applied_node_ids])).rows.map((r: { phrase_normalized: string }) => r.phrase_normalized);
    expect(added).toContain("audit logging");
    expect(added).toContain("soc 2 report");
    expect(patch.alignment_before).not.toBeNull();
    expect(patch.alignment_projected).not.toBeNull();
    // a compliance concept is a claim: flagged for review, with a reason
    expect(patch.risk_flags).toEqual(["claim_requires_review"]);
    expect(patch.requires_human_review).toBe(true);
    expect(String(patch.review_reason).length).toBeGreaterThan(0);
  }, 120_000);

  it("AC patch-2 - a patch adding no claim-bearing concept is not flagged; the patch is IMMUTABLE and a second request makes a NEW row", async () => {
    const id = await draftedSession("Reporting. Teams compare reporting tools by export formats. We provide webhook delivery.");
    const first = await inTx((tx) => createAlignmentPatch(tx, id, null));
    const row = (await db.query("SELECT requires_human_review, risk_flags FROM patches WHERE id = $1", [first])).rows[0];
    expect(row).toEqual({ requires_human_review: false, risk_flags: [] });
    await expect(db.query("UPDATE patches SET content_after = 'tampered' WHERE id = $1", [first])).rejects.toThrow();
    const second = await inTx((tx) => createAlignmentPatch(tx, id, null));
    expect(second).not.toBe(first);
    expect((await db.query("SELECT count(*)::int AS n FROM patches WHERE session_id = $1", [id])).rows[0]).toEqual({ n: 2 });
  }, 120_000);

  it("AC patch-3 - no draft, or a draft not yet measured, is 422 precondition_unmet naming why; nothing is written", async () => {
    const id = await readySession();
    await expect(inTx((tx) => createAlignmentPatch(tx, id, null))).rejects.toMatchObject({ code: "precondition_unmet", details: { reason: "no_draft" } });
    await inTx((tx) => saveAlignmentDraft(tx, words, id, "a draft not yet measured", 60_000));
    await expect(inTx((tx) => createAlignmentPatch(tx, id, null))).rejects.toMatchObject({ code: "precondition_unmet", details: { reason: "draft_not_ready" } });
    expect((await db.query("SELECT count(*)::int AS n FROM patches")).rows[0]).toEqual({ n: 0 });
  }, 120_000);

  it("tenancy - a patch cannot be cut from another workspace's session", async () => {
    const id = await draftedSession("Reporting. We provide webhook delivery.");
    await expect(inTx((tx) => createAlignmentPatch(tx, id, null), otherWorkspaceId)).rejects.toMatchObject({ code: "not_found" });
  }, 120_000);
});
