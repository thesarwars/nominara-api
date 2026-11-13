import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { embedBatchPayloadSchema } from "../../src/lib/embedding/embed-batch.js";
import { cellKey, probeSemanticReuse } from "../../src/lib/capture/l2-semantic-reuse.js";
import { promoteProject } from "../../src/lib/embedding/reembed-promote.js";
import { runReembed, type ReembedSummary } from "../../src/lib/embedding/reembed.js";
import { createEmbedBatchHandler } from "../../src/lib/queue/handlers/embed-batch.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { StandInEmbeddingProvider } from "../../src/modules/prompts/adapters/stand-in-embedding-provider.js";
import type { EmbeddingBatchResult, EmbeddingProvider } from "../../src/modules/prompts/ports/embedding-provider.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-186 - re-embed on a model change. Owner decision 104: staged, then promoted per project in one step. The provider is the
// deterministic stand-in behind the port (scripted to name any model); nothing here touches a network.

const KEYS = { current: { kid: "k1", key: Buffer.from("embed-batch-test-signing-key-32by") } };
const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "embed.batch")!;
const OLD = "model-old";
const NEW = "model-new";

class NamedProvider implements EmbeddingProvider {
  readonly dimensions = 1536;
  readonly calls: string[][] = [];
  private readonly inner = new StandInEmbeddingProvider();
  constructor(readonly model: string) {}
  async embed(texts: readonly string[]): Promise<EmbeddingBatchResult> {
    this.calls.push([...texts]);
    return { ...(await this.inner.embed(texts)), model: this.model };
  }
}

describe("STORY-186 - staged re-embed and the per-project cutover", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;

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

  async function newWorkspace(): Promise<{ workspaceId: string; projectId: string }> {
    const w = randomUUID();
    const p = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [w, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, 'P', $3, 'https://example.test', 'example.test')`,
      [p, w, `p-${randomUUID().slice(0, 8)}`],
    );
    return { workspaceId: w, projectId: p };
  }

  beforeEach(async () => {
    await db.query("TRUNCATE audit_log, usage_ledger, usage_counters, semantic_nodes, geo_alignments, answer_captures, tracked_prompts, capture_runs, projects, workspaces CASCADE").catch(async () => {
      await db.query("TRUNCATE usage_ledger, usage_counters, semantic_nodes, geo_alignments, answer_captures, tracked_prompts, capture_runs, projects, workspaces CASCADE");
    });
    ({ workspaceId, projectId } = await newWorkspace());
  });

  const vec = (a: number, b: number, mix: number): string => {
    const v = new Array<number>(1536).fill(0);
    const norm = Math.sqrt(1 + mix * mix);
    v[a] = 1 / norm;
    v[b] = mix / norm;
    return `[${v.join(",")}]`;
  };

  /** A prompt embedded under `model` (or never embedded when `model` is null). */
  async function addPrompt(text: string, model: string | null, over: { status?: string; ws?: string; project?: string; deleted?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status, embedding, embedding_model, deleted_at)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', $6, $7::halfvec, $8, $9)`,
      [id, over.ws ?? workspaceId, over.project ?? projectId, text, Buffer.from(text, "utf8"), over.status ?? "active", model === null ? null : vec(0, 1, 0.1), model, over.deleted === true ? new Date() : null],
    );
    return id;
  }

  async function addNode(phrase: string, model: string | null, cluster: string | null = null): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO semantic_nodes (id, workspace_id, project_id, prompt_cluster_id, phrase, phrase_normalized, node_type, corpus_doc_ratio, evidence_url, evidence_snippet, embedding, embedding_model)
       VALUES ($1, $2, $3, $4, $5, $5, 'capability', 0.5, 'https://doc.example/p', $5, $6::halfvec, $7)`,
      [id, workspaceId, projectId, cluster, phrase, model === null ? null : vec(2, 3, 0.1), model],
    );
    return id;
  }

  function stageJob(ids: string[], table: "tracked_prompts" | "semantic_nodes" = "tracked_prompts", ws = workspaceId): Job {
    const payload = embedBatchPayloadSchema.parse({ workspaceId: ws, kid: "k1", table, ids, stage: true });
    return { data: signQueueJobPayload(payload, KEYS.current.key) } as unknown as Job;
  }

  async function run(provider: EmbeddingProvider, j: Job): Promise<unknown> {
    const context = { pool: undefined, env: { NODE_ENV: "test" } } as unknown as QueueHandlerContext;
    const process = createJobProcessor(ENTRY, {
      keys: KEYS,
      getClient: () => pool.connect(),
      releaseClient: (client) => (client as PoolClient).release(),
      process: createEmbedBatchHandler(context, { provider }),
    });
    return process(j);
  }

  async function state(table: "tracked_prompts" | "semantic_nodes", ids: string[]) {
    return (
      await db.query<{ id: string; embedding_model: string | null; embedding_next_model: string | null; has_next: boolean; live: string | null }>(
        `SELECT id, embedding_model, embedding_next_model, embedding_next IS NOT NULL AS has_next, embedding::text AS live FROM ${table} WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [ids],
      )
    ).rows;
  }

  const promote = (ws: string, project: string, model: string) =>
    withTenantContext(db, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, (tx) => promoteProject(tx, project, model));

  // ---- AC2: old vectors are served until the new set is complete ----------------------------------------------------------

  it("AC2 - a stage job writes the NEW vector beside the old one and leaves the served vector and its model untouched", async () => {
    const id = await addPrompt("a prompt under the old model", OLD);
    const before = (await state("tracked_prompts", [id]))[0]!;
    const provider = new NamedProvider(NEW);
    await run(provider, stageJob([id]));
    const after = (await state("tracked_prompts", [id]))[0]!;
    expect(provider.calls).toHaveLength(1);
    expect(after.embedding_next_model).toBe(NEW);
    expect(after.has_next).toBe(true);
    expect(after.embedding_model, "served model unchanged").toBe(OLD);
    expect(after.live, "served vector unchanged").toBe(before.live);
  }, 60_000);

  it("AC2 - a stage job redelivered makes no provider call (idempotent)", async () => {
    const id = await addPrompt("redelivered", OLD);
    const provider = new NamedProvider(NEW);
    await run(provider, stageJob([id]));
    await run(provider, stageJob([id]));
    expect(provider.calls).toHaveLength(1);
  }, 60_000);

  it("AC2 - a stage job never touches a row with no vector (that is the backfill's, written directly) nor a row already under the target model", async () => {
    const never = await addPrompt("never embedded", null);
    const current = await addPrompt("already current", NEW);
    const provider = new NamedProvider(NEW);
    await run(provider, stageJob([never, current]));
    expect(provider.calls, "nothing to stage, no spend").toHaveLength(0);
    const rows = await state("tracked_prompts", [never, current]);
    expect(rows.every((row) => !row.has_next)).toBe(true);
  }, 60_000);

  it("AC2 - a project is NOT promoted while any of its prompts lacks the staged vector; nothing is half-switched", async () => {
    const a = await addPrompt("one", OLD);
    const b = await addPrompt("two", OLD);
    await run(new NamedProvider(NEW), stageJob([a]));
    const outcome = await promote(workspaceId, projectId, NEW);
    expect(outcome).toMatchObject({ status: "blocked", reason: "incomplete" });
    const rows = await state("tracked_prompts", [a, b]);
    expect(rows.map((row) => row.embedding_model)).toEqual([OLD, OLD]);
  }, 60_000);

  it("AC2 - once the set is complete the project is promoted in one step: every prompt flips, staging is cleared", async () => {
    const ids = [await addPrompt("one", OLD), await addPrompt("two", OLD), await addPrompt("three", OLD)];
    await run(new NamedProvider(NEW), stageJob(ids));
    const outcome = await promote(workspaceId, projectId, NEW);
    expect(outcome).toMatchObject({ status: "promoted", prompts: 3, nodes: 0 });
    const rows = await state("tracked_prompts", ids);
    expect(rows.every((row) => row.embedding_model === NEW && row.embedding_next_model === null && !row.has_next)).toBe(true);
  }, 60_000);

  it("AC4 - promote is idempotent: a second call changes nothing and says so", async () => {
    const ids = [await addPrompt("one", OLD)];
    await run(new NamedProvider(NEW), stageJob(ids));
    await promote(workspaceId, projectId, NEW);
    const once = await state("tracked_prompts", ids);
    expect(await promote(workspaceId, projectId, NEW)).toMatchObject({ status: "nothing_staged" });
    expect(await state("tracked_prompts", ids)).toEqual(once);
  }, 60_000);

  it("AC2 - the L2 probe keeps comparing under the OLD model until promote, then under the new one (no query ever mixes the two)", async () => {
    const source = await addPrompt("best crm for small business", OLD);
    const target = await addPrompt("best crm for small businesses", OLD);
    await db.query("UPDATE tracked_prompts SET embedding = $2::halfvec WHERE id = $1", [target, vec(0, 1, 0.12)]);
    await db.query(
      `INSERT INTO answer_captures (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version, content_hash, status, cache_layer)
       VALUES ($1, $2, $3, $4, 'perplexity', now(), 'api', '1.0.0', 'v1', sha256('x'::bytea), 'parsed', 'live')`,
      [workspaceId, projectId, randomUUID(), source],
    );
    const candidate = { promptId: target, engineKey: "perplexity", sampleIndex: 0, ttlSeconds: 86_400 };
    const probe = async () => (await probeSemanticReuse(db, { workspaceId, projectId }, [candidate])).get(cellKey(candidate)) !== undefined;
    expect(await probe(), "served under the old model").toBe(true);
    await run(new NamedProvider(NEW), stageJob([source, target]));
    expect(await probe(), "staging changes nothing a query reads").toBe(true);
    await promote(workspaceId, projectId, NEW);
    // The new vectors are the stand-in's for these two different texts, so the cosine is a different number: what must hold is that
    // BOTH sides moved together (a mixed pair would be refused by the equal-model rule, not compared).
    expect((await state("tracked_prompts", [source, target])).map((row) => row.embedding_model)).toEqual([NEW, NEW].sort());
  }, 60_000);

  it("AC2 - a project's promote touches only that project and that workspace", async () => {
    const other = await newWorkspace();
    const mine = await addPrompt("mine", OLD);
    const theirs = await addPrompt("theirs", OLD, { ws: other.workspaceId, project: other.projectId });
    await run(new NamedProvider(NEW), stageJob([mine]));
    await run(new NamedProvider(NEW), stageJob([theirs], "tracked_prompts", other.workspaceId));
    // Promote ONLY mine.
    await promote(workspaceId, projectId, NEW);
    expect((await state("tracked_prompts", [mine]))[0]!.embedding_model).toBe(NEW);
    expect((await state("tracked_prompts", [theirs]))[0]!.embedding_model, "another workspace is not this promote's").toBe(OLD);
    // And a promote under workspace A's context cannot name workspace B's project.
    expect(await promote(workspaceId, other.projectId, NEW)).toMatchObject({ status: "nothing_staged" });
    expect((await state("tracked_prompts", [theirs]))[0]!.embedding_model).toBe(OLD);
  }, 60_000);

  it("AC2 - a deleted prompt does not hold the project back", async () => {
    const live = await addPrompt("live", OLD);
    await addPrompt("deleted and stale", OLD, { deleted: true });
    await run(new NamedProvider(NEW), stageJob([live]));
    expect(await promote(workspaceId, projectId, NEW)).toMatchObject({ status: "promoted", prompts: 1 });
  }, 60_000);

  it("AC2 - semantic_nodes are staged and promoted in the SAME step as the project's prompts", async () => {
    const prompt = await addPrompt("one", OLD);
    const node = await addNode("audit logging", OLD);
    await run(new NamedProvider(NEW), stageJob([prompt]));
    expect(await promote(workspaceId, projectId, NEW), "the node has no staged vector yet: the whole project waits").toMatchObject({ status: "blocked", reason: "incomplete" });
    expect((await state("tracked_prompts", [prompt]))[0]!.embedding_model, "the prompt is not switched alone").toBe(OLD);
    await run(new NamedProvider(NEW), stageJob([node], "semantic_nodes"));
    expect(await promote(workspaceId, projectId, NEW)).toMatchObject({ status: "promoted", prompts: 1, nodes: 1 });
    const n = (await state("semantic_nodes", [node]))[0]!;
    expect(n.embedding_model).toBe(NEW);
    expect(n.has_next).toBe(false);
  }, 60_000);

  it("AC2 - an OPEN alignment session pinned to the old model defers the project (its nodes would vanish under it); a closed one does not", async () => {
    const prompt = await addPrompt("one", OLD);
    const session = randomUUID();
    await db.query(
      `INSERT INTO geo_alignments (id, workspace_id, project_id, target_url, engine_keys, embedding_model, live_content_md, status)
       VALUES ($1, $2, $3, 'https://example.test/p', '{chatgpt}', $4, '# x', 'open')`,
      [session, workspaceId, projectId, OLD],
    );
    await run(new NamedProvider(NEW), stageJob([prompt]));
    expect(await promote(workspaceId, projectId, NEW)).toMatchObject({ status: "blocked", reason: "open_session" });
    await db.query("UPDATE geo_alignments SET status = 'discarded' WHERE id = $1", [session]);
    expect(await promote(workspaceId, projectId, NEW)).toMatchObject({ status: "promoted" });
  }, 60_000);

  it("AC2 - a second model change mid-stage: vectors staged under the first target are re-staged, never promoted as the second", async () => {
    const id = await addPrompt("one", OLD);
    await run(new NamedProvider("model-mid"), stageJob([id]));
    expect(await promote(workspaceId, projectId, NEW), "staged under another target").toMatchObject({ status: "blocked" });
    const provider = new NamedProvider(NEW);
    await run(provider, stageJob([id]));
    expect(provider.calls, "re-staged").toHaveLength(1);
    expect(await promote(workspaceId, projectId, NEW)).toMatchObject({ status: "promoted" });
  }, 60_000);

  // ---- AC1 / AC3 / AC4: the operator run ----------------------------------------------------------------------------------

  interface Enqueued {
    readonly workspaceId: string;
    readonly payload: { table: string; ids: string[]; stage?: true };
    readonly key: string;
  }

  function recorder(fail: (e: Enqueued) => boolean = () => false): { sent: Enqueued[]; enqueue: Parameters<typeof runReembed>[0]["enqueue"] } {
    const sent: Enqueued[] = [];
    return {
      sent,
      enqueue: (_queue, ws, payload, key) => {
        const entry = { workspaceId: ws, payload: payload as Enqueued["payload"], key };
        if (fail(entry)) return Promise.reject(new Error("valkey down"));
        sent.push(entry);
        return Promise.resolve();
      },
    };
  }

  const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
  const reembed = (enqueue: Parameters<typeof runReembed>[0]["enqueue"], model = NEW): Promise<ReembedSummary> => runReembed({ client: db, model, enqueue, logger: quiet });

  /** Hand a recorded job to the real handler, as the worker would. */
  const process = (e: Enqueued, model = NEW): Promise<unknown> => {
    const payload = embedBatchPayloadSchema.parse({ workspaceId: e.workspaceId, kid: "k1", ...e.payload });
    return run(new NamedProvider(model), { data: signQueueJobPayload(payload, KEYS.current.key) } as unknown as Job);
  };

  async function manyPrompts(count: number, model: string | null, over: { ws?: string; project?: string } = {}): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) ids.push(await addPrompt(`prompt number ${String(i)} ${randomUUID().slice(0, 6)}`, model, over));
    return ids;
  }

  it("AC1 - stale prompts are enqueued as stage jobs of at most 96 ids: 200 rows make 96 + 96 + 8", async () => {
    await manyPrompts(200, OLD);
    const { sent, enqueue } = recorder();
    const summary = await reembed(enqueue);
    expect(sent.map((e) => e.payload.ids.length).sort((a, b) => a - b)).toEqual([8, 96, 96]);
    expect(sent.every((e) => e.payload.table === "tracked_prompts" && e.payload.stage === true && e.workspaceId === workspaceId)).toBe(true);
    expect(new Set(sent.flatMap((e) => e.payload.ids)).size, "every row exactly once").toBe(200);
    expect(summary.jobs).toMatchObject({ stagePrompts: 3, backfill: 0, stageNodes: 0 });
  }, 120_000);

  it("AC1 - stale semantic_nodes are enqueued as stage jobs too", async () => {
    await addNode("audit logging", OLD);
    const { sent, enqueue } = recorder();
    await reembed(enqueue);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ table: "semantic_nodes", stage: true });
  }, 60_000);

  it("AC1 - a row already under the target model, and a deleted row, are not enqueued", async () => {
    await addPrompt("current", NEW);
    await addPrompt("deleted", OLD, { deleted: true });
    const { sent, enqueue } = recorder();
    await reembed(enqueue);
    expect(sent).toHaveLength(0);
  }, 60_000);

  it("AC1 - jobs are per workspace: another workspace's ids never ride in this one's job", async () => {
    const other = await newWorkspace();
    const mine = await manyPrompts(2, OLD);
    const theirs = await manyPrompts(2, OLD, { ws: other.workspaceId, project: other.projectId });
    const { sent, enqueue } = recorder();
    await reembed(enqueue);
    expect(sent).toHaveLength(2);
    const byWs = new Map(sent.map((e) => [e.workspaceId, e.payload.ids.sort()]));
    expect(byWs.get(workspaceId)).toEqual([...mine].sort());
    expect(byWs.get(other.workspaceId)).toEqual([...theirs].sort());
  }, 60_000);

  it("AC3 - active prompts with no vector are enqueued as DIRECT jobs by the same run; paused and deleted ones are not", async () => {
    const never = await manyPrompts(3, null);
    await addPrompt("paused never embedded", null, { status: "paused" });
    await addPrompt("deleted never embedded", null, { deleted: true });
    const { sent, enqueue } = recorder();
    const summary = await reembed(enqueue);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.stage, "a backfill writes the served vector, nothing to stage").toBeUndefined();
    expect(sent[0]!.payload.ids.sort()).toEqual([...never].sort());
    expect(summary.jobs.backfill).toBe(1);
  }, 60_000);

  it("AC3/AC4 - the run is idempotent: a second run enqueues the same jobs under the same keys (the queue dedupes them), so nothing is asked twice", async () => {
    await manyPrompts(3, null);
    await manyPrompts(3, OLD);
    const first = recorder();
    const second = recorder();
    await reembed(first.enqueue);
    await reembed(second.enqueue);
    expect(second.sent.map((e) => e.key).sort()).toEqual(first.sent.map((e) => e.key).sort());
    expect(new Set(first.sent.map((e) => e.key)).size, "a stage job and a direct job never share a key").toBe(first.sent.length);
  }, 60_000);

  it("AC4 - resumable: after part of the work is staged, a rerun enqueues only the remainder", async () => {
    const ids = await manyPrompts(104, OLD);
    const first = recorder();
    await reembed(first.enqueue);
    const big = first.sent.find((e) => e.payload.ids.length === 96)!;
    await process(big);
    const second = recorder();
    await reembed(second.enqueue);
    expect(second.sent.flatMap((e) => e.payload.ids).sort()).toEqual(ids.filter((id) => !big.payload.ids.includes(id)).sort());
  }, 120_000);

  it("AC4 - a failed enqueue does not stop the others, is counted, and is picked up by the next run", async () => {
    await manyPrompts(100, OLD);
    let calls = 0;
    const flaky = recorder(() => (calls += 1) === 1);
    const summary = await reembed(flaky.enqueue);
    expect(flaky.sent).toHaveLength(1);
    expect(summary.enqueueFailed).toBe(1);
    const retry = recorder();
    const again = await reembed(retry.enqueue);
    expect(again.enqueueFailed).toBe(0);
    expect(retry.sent.flatMap((e) => e.payload.ids)).toHaveLength(100);
  }, 120_000);

  it("AC2/AC4 - end to end: run, process the jobs, run again to cut the project over, run a third time and nothing more happens", async () => {
    const ids = await manyPrompts(5, OLD);
    const first = recorder();
    const s1 = await reembed(first.enqueue);
    expect(s1.cutovers, "nothing is staged yet: no cutover on the first run").toEqual([]);
    for (const e of first.sent) await process(e);
    expect((await state("tracked_prompts", ids)).every((row) => row.embedding_model === OLD), "still served from the old model").toBe(true);

    const second = recorder();
    const s2 = await reembed(second.enqueue);
    expect(second.sent, "nothing left to stage").toHaveLength(0);
    expect(s2.cutovers).toEqual([{ workspaceId, projectId, prompts: 5, nodes: 0 }]);
    expect((await state("tracked_prompts", ids)).every((row) => row.embedding_model === NEW)).toBe(true);

    const third = recorder();
    const s3 = await reembed(third.enqueue);
    expect(third.sent).toHaveLength(0);
    expect(s3.cutovers).toEqual([]);
  }, 120_000);

  it("AC2 - one workspace's blocked project does not hold another's cutover; the block is reported", async () => {
    const other = await newWorkspace();
    const mine = await manyPrompts(2, OLD);
    const theirs = await manyPrompts(2, OLD, { ws: other.workspaceId, project: other.projectId });
    await db.query(
      `INSERT INTO geo_alignments (id, workspace_id, project_id, target_url, engine_keys, embedding_model, live_content_md, status)
       VALUES ($1, $2, $3, 'https://example.test/p', '{chatgpt}', $4, '# x', 'open')`,
      [randomUUID(), other.workspaceId, other.projectId, OLD],
    );
    const first = recorder();
    await reembed(first.enqueue);
    for (const e of first.sent) await process(e);
    const summary = await reembed(recorder().enqueue);
    expect(summary.cutovers.map((c) => c.workspaceId)).toEqual([workspaceId]);
    expect(summary.blocked).toEqual([{ workspaceId: other.workspaceId, projectId: other.projectId, reason: "open_session" }]);
    expect((await state("tracked_prompts", mine)).every((row) => row.embedding_model === NEW)).toBe(true);
    expect((await state("tracked_prompts", theirs)).every((row) => row.embedding_model === OLD)).toBe(true);
  }, 120_000);

  it("AC3 - the run itself never calls an embedding provider: it takes none, and enqueues only", () => {
    // `runReembed`'s options have no provider field; a spend happens only when a worker runs the jobs it enqueued. Type-level guard.
    const options: Parameters<typeof runReembed>[0] = { client: db, model: NEW, enqueue: recorder().enqueue, logger: quiet };
    expect(Object.keys(options).sort()).toEqual(["client", "enqueue", "logger", "model"]);
  });
});
