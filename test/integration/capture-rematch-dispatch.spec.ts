import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { Client, type ClientBase } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import type { Cache } from "../../src/lib/cache/cache.port.js";
import { captureL1Key } from "../../src/lib/capture/l1-cache-key.js";
import { adapterMajorOf } from "../../src/lib/capture/l1-exact-hash.js";
import { dispatchPlannedRun, planRun, type PlanRunContext } from "../../src/lib/capture/plan-run.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { buildQueue } from "../../src/lib/queue/queue-factory.js";
import { QUEUE_TOPOLOGY, type QueueTopologyEntry } from "../../src/lib/queue/topology.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-032 AC7 (owner decision 2026-10-13) — the re-match parse is ENQUEUED AT PLAN TIME, in `dispatchPlannedRun`.
//
// The planner leaves a reused cell `skipped` and nothing used to enqueue `capture.parse` for it, so the cell was never
// re-matched against the current alias set. `planRun` now reports the rows it wrote (`plan.rematch`) and dispatch
// enqueues one `capture.parse` per row, keyed `parse:{result}` so a replay is deduplicated.
//
// Invariants named in the test titles:
//   [I2 no-double-count]  planning the re-match changes no run count
//   [I4 idempotent]       a second dispatch, and a replan, add no job and no row
//   [fail-closed]         a plan that has reused rows cannot be dispatched with nowhere to send their parse

const EXECUTE = QUEUE_TOPOLOGY.find((entry) => entry.name === "capture.execute")!;
const PARSE = QUEUE_TOPOLOGY.find((entry) => entry.name === "capture.parse")!;
const PERIOD = "2026-08-01";
const TTL_SECONDS = 86_400;
const NOW_MS = Date.UTC(2026, 7, 20, 12, 0, 0);

describe("STORY-032 AC7 · the re-match parse is enqueued at plan time", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let valkey: ValkeyFixture;
  let cache: Cache;
  let workspaceId: string;
  let projectId: string;
  let runId: string;
  const connections: Redis[] = [];
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    valkey = await startValkeyFixture();
  }, 300_000);

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
    for (const connection of connections.splice(0)) await connection.quit().catch(() => undefined);
  });

  afterAll(async () => {
    await valkey.stop();
    await db.end();
    await container.stop();
  });

  function newQueue(entry: QueueTopologyEntry, prefix = `rematch-${randomUUID().slice(0, 8)}`): Queue {
    const connection = createQueueWorkerConnection(valkey.connectionString);
    connections.push(connection);
    const queue = buildQueue(entry, { connection, prefix: queueKeyPrefix(prefix) });
    cleanups.push(async () => {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    });
    return queue;
  }

  const jobsIn = async (queue: Queue) => queue.getJobs(["waiting", "delayed", "prioritized", "active"]);

  beforeEach(async () => {
    await db.query("TRUNCATE answer_captures, tracked_prompts, project_engines, capture_runs, projects, usage_counters, workspaces, engines CASCADE");
    cache = new InMemoryCacheAdapter();
    workspaceId = randomUUID();
    projectId = randomUUID();
    runId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, priority_prompt_limit)
       VALUES ($1, $2, 'P', $3, 'https://e.test', 'e.test', 10)`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys) VALUES ($1, $2, $3, 'scheduled', ARRAY['perplexity'])`,
      [runId, workspaceId, projectId],
    );
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version, cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ('perplexity', 'perplexity', 'v', 'api', '1.0.0', $1, 'medium', 'free', 'active')`,
      [TTL_SECONDS],
    );
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count) VALUES ($1, $2, 'perplexity', true, 1)`,
      [workspaceId, projectId],
    );
  });

  async function addPrompt(text: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', false, 'active')`,
      [id, workspaceId, projectId, text, Buffer.from(text, "utf8")],
    );
    return id;
  }

  function context(): PlanRunContext {
    return {
      workspaceId, projectId, runId, trigger: "scheduled", cadence: "weekly", planKey: "growth", scope: "all", periodStart: PERIOD,
      locale: "en-US", personaHint: null, normalizerVersion: "v1", captureMode: "api", captureReadyEngineKeys: ["perplexity"],
      env: "test", sharedCacheEnabled: true, nowMs: NOW_MS,
    };
  }

  async function seedL1(text: string): Promise<void> {
    await cache.set(
      captureL1Key({ env: "test", engineKey: "perplexity", adapterMajor: adapterMajorOf("1.0.0"), promptText: text, locale: "en-US", personaHint: null, ttlSeconds: TTL_SECONDS, nowMs: NOW_MS }),
      JSON.stringify({ v: 1, contentHash: "a".repeat(64), payload: { format: "markdown", text: "HubSpot is great" }, excerpt: "HubSpot is great" }),
      { ttlMs: 600_000 },
    );
  }

  async function plan(client: ClientBase = db) {
    await client.query("BEGIN");
    try {
      const planned = await planRun(client, cache, context());
      await client.query("COMMIT");
      return planned;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  const skippedRows = async () =>
    (await db.query<{ id: string; captured_at: Date; prompt_id: string; status: string }>(
      "SELECT id, captured_at, prompt_id, status FROM answer_captures WHERE run_id = $1 AND cache_layer <> 'live' ORDER BY id",
      [runId],
    )).rows;

  it("STORY-032 AC7 · planRun reports one re-match job per row it wrote, and none for the live cell", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    await seedL1("best crm");

    const planned = await plan();

    const rows = await skippedRows();
    expect(rows).toHaveLength(1);
    expect(planned.rematch).toEqual([
      { workspaceId, resultId: rows[0]!.id, projectId, promptId: rows[0]!.prompt_id, engineKey: "perplexity", capturedAt: rows[0]!.captured_at.toISOString() },
    ]);
  }, 60_000);

  /** A 1536-d unit vector leaning on axis `a`, mixed with axis `b` by `mix` (as capture-l2-semantic-reuse.spec.ts). */
  function embedding(a: number, b: number, mix: number): string {
    const v = new Array<number>(1536).fill(0);
    const norm = Math.sqrt(1 + mix * mix);
    v[a] = 1 / norm;
    v[b] = mix / norm;
    return `[${v.join(",")}]`;
  }

  it("STORY-032 AC7 · an L2 (semantic) hit is re-matched too: its row is in plan.rematch, layer l2, linked to its source", async () => {
    const insertPrompt = async (text: string, vector: string): Promise<string> => {
      const id = randomUUID();
      await db.query(
        `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status, embedding)
         VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', false, 'active', $6::halfvec)`,
        [id, workspaceId, projectId, text, Buffer.from(text, "utf8"), vector],
      );
      return id;
    };
    const sourcePrompt = await insertPrompt("best crm for small business", embedding(0, 1, 0));
    await insertPrompt("best crm for small businesses", embedding(0, 1, 0.1));
    const earlierRun = randomUUID();
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, status) VALUES ($1, $2, $3, 'scheduled', ARRAY['perplexity'], 'completed')`,
      [earlierRun, workspaceId, projectId],
    );
    const sourceId = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version,
          content_hash, payload, status, cache_layer)
       VALUES ($1, $2, $3, $4, $5, 'perplexity', now() - interval '1 minute', 'api', '1.0.0', 'v1', sha256('x'::bytea), $6::jsonb, 'parsed', 'live')`,
      [sourceId, workspaceId, projectId, earlierRun, sourcePrompt, JSON.stringify({ format: "markdown", text: "HubSpot is great" })],
    );

    const planned = await plan();

    const l2 = (await db.query<{ id: string; source_result_id: string | null }>(
      "SELECT id, source_result_id FROM answer_captures WHERE run_id = $1 AND cache_layer = 'l2' AND status = 'skipped' ORDER BY id",
      [runId],
    )).rows;
    expect(l2.length, "the semantic probe must have admitted at least one cell").toBeGreaterThanOrEqual(1);
    expect(l2.every((row) => row.source_result_id === sourceId)).toBe(true);
    expect(planned.rematch.map((job) => job.resultId)).toEqual(l2.map((row) => row.id));
  }, 60_000);

  it("[I2 no-double-count] STORY-032 AC7 · planning the re-match changes no count: planned 2, skipped 1, live 1", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    await seedL1("best crm");

    const planned = await plan();

    expect({ planned: planned.planned, skipped: planned.skipped, live: planned.live }).toEqual({ planned: 2, skipped: 1, live: 1 });
    const run = (await db.query("SELECT planned_cells, skipped_cells, captured_cells FROM capture_runs WHERE id = $1", [runId])).rows[0];
    expect(run).toEqual({ planned_cells: 2, skipped_cells: 1, captured_cells: 0 });
    expect((await skippedRows())[0]!.status, "the row is still skipped after planning").toBe("skipped");
  }, 60_000);

  it("STORY-032 AC7 · dispatchPlannedRun enqueues the live cell on capture.execute and the re-match on capture.parse", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    await seedL1("best crm");
    const executeQueue = newQueue(EXECUTE);
    const parseQueue = newQueue(PARSE);

    const planned = await plan();
    await dispatchPlannedRun(executeQueue, EXECUTE, planned, { priorityVariant: "scheduled", parse: { queue: parseQueue, entry: PARSE } });

    expect(await jobsIn(executeQueue)).toHaveLength(1);
    const parseJobs = await jobsIn(parseQueue);
    expect(parseJobs).toHaveLength(1);
    expect(parseJobs[0]!.name).toBe("capture.parse");
    expect(parseJobs[0]!.data).toMatchObject({ resultId: (await skippedRows())[0]!.id, workspaceId, projectId });
  }, 60_000);

  it("STORY-032 AC7 · a fully cached run has no live cell and STILL enqueues its re-match", async () => {
    await addPrompt("best crm");
    await seedL1("best crm");
    const executeQueue = newQueue(EXECUTE);
    const parseQueue = newQueue(PARSE);

    const planned = await plan();
    expect(planned.live).toBe(0);
    await dispatchPlannedRun(executeQueue, EXECUTE, planned, { priorityVariant: "scheduled", parse: { queue: parseQueue, entry: PARSE } });

    expect(await jobsIn(executeQueue)).toHaveLength(0);
    expect(await jobsIn(parseQueue)).toHaveLength(1);
  }, 60_000);

  it("[I4 idempotent] STORY-032 AC7 · dispatching the same plan twice leaves ONE parse job per reused row", async () => {
    await addPrompt("best crm");
    await seedL1("best crm");
    const executeQueue = newQueue(EXECUTE);
    const parseQueue = newQueue(PARSE);

    const planned = await plan();
    await dispatchPlannedRun(executeQueue, EXECUTE, planned, { priorityVariant: "scheduled", parse: { queue: parseQueue, entry: PARSE } });
    await dispatchPlannedRun(executeQueue, EXECUTE, planned, { priorityVariant: "scheduled", parse: { queue: parseQueue, entry: PARSE } });

    expect(await jobsIn(parseQueue)).toHaveLength(1);
  }, 60_000);

  it("[I4 idempotent] STORY-032 AC7 · a REPLAN (the documented crash recovery) writes no second row and reports the same re-match jobs", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    await seedL1("best crm");

    const first = await plan();
    const second = await plan();

    expect(await skippedRows()).toHaveLength(1);
    expect(second.rematch).toEqual(first.rematch);
    expect((await db.query("SELECT skipped_cells FROM capture_runs WHERE id = $1", [runId])).rows[0].skipped_cells).toBe(1);
  }, 60_000);

  it("[fail-closed] STORY-032 AC7 · a plan with reused rows is REFUSED when no parse target is given, and nothing is enqueued", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    await seedL1("best crm");
    const executeQueue = newQueue(EXECUTE);

    const planned = await plan();

    await expect(dispatchPlannedRun(executeQueue, EXECUTE, planned, { priorityVariant: "scheduled" })).rejects.toThrow(/re-match/);
    expect(await jobsIn(executeQueue), "not even the live cell goes out half-dispatched").toHaveLength(0);
  }, 60_000);

  it("STORY-032 AC7 · a plan with nothing reused needs no parse target and reports an empty re-match", async () => {
    await addPrompt("best crm");
    const executeQueue = newQueue(EXECUTE);

    const planned = await plan();
    expect(planned.rematch).toEqual([]);
    await dispatchPlannedRun(executeQueue, EXECUTE, planned, { priorityVariant: "scheduled" });

    expect(await jobsIn(executeQueue)).toHaveLength(1);
  }, 60_000);

  it("[I4 idempotent] STORY-032 AC7 · the PRODUCTION dispatch path (QueueProducer.dispatchPlannedCells) enqueues SIGNED re-match jobs, one per row even when dispatched twice", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    await seedL1("best crm");
    const connection = createQueueWorkerConnection(valkey.connectionString);
    connections.push(connection);
    const producer = new QueueProducer(connection, queueKeyPrefix(`rematch-${randomUUID().slice(0, 8)}`), {
      current: { kid: "test-kid", key: Buffer.alloc(32, 3) },
    });
    cleanups.push(() => producer.onModuleDestroy());

    const planned = await plan();
    await producer.dispatchPlannedCells("capture.execute", planned, { priorityVariant: "scheduled", cadence: "weekly" });
    await producer.dispatchPlannedCells("capture.execute", planned, { priorityVariant: "scheduled", cadence: "weekly" });

    const parseQueue = (producer as unknown as { queueFor(entry: QueueTopologyEntry): Queue }).queueFor(PARSE);
    const jobs = await jobsIn(parseQueue);
    expect(jobs).toHaveLength(1);
    // The envelope the worker verifies FIRST: an unsigned payload is rejected before the handler is reached.
    expect(jobs[0]!.data).toMatchObject({ signature: expect.any(String) });
    expect((jobs[0]!.data as { payload: Record<string, unknown> }).payload).toMatchObject({
      kid: "test-kid", workspaceId, projectId, resultId: (await skippedRows())[0]!.id,
    });
  }, 60_000);
});
