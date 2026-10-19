import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { BLACKOUT_THRESHOLD_MS } from "../../src/lib/engines/blackout.js";
import { DLQ_DEPTH_SUSTAINED_MS, buildDlqQueue, type Pager } from "../../src/lib/queue/dead-letter.js";
import {
  EMPTY_MONITOR_STATE,
  MonitorRuntime,
  ValkeyMonitorStateStore,
  dlqDepthReader,
  type MonitorState,
  type MonitorStateStore,
} from "../../src/lib/queue/monitor-runtime.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { EngineHealthService } from "../../src/modules/health/engine-health.service.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-179 AC3/AC5 — the real thing: Postgres advisory-lock election, the queue Valkey for state and for the
// {queue}.dlq depths, and engine_health for the last success. Two replicas are two MonitorRuntimes on separate
// pool connections sharing one store, ticking at the same moment.

const PREFIX = "nominara-queue-test";

describe("STORY-179 · MonitorRuntime — two replicas, real Postgres lock + Valkey", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let valkey: ValkeyFixture;
  let redis: Redis;
  let store: ValkeyMonitorStateStore;
  let engineHealth: EngineHealthService;
  const dlqs = new Map<string, Queue>();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client);
    await client.end();
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
    valkey = await startValkeyFixture();
    redis = new Redis(valkey.connectionString, { maxRetriesPerRequest: null });
    store = new ValkeyMonitorStateStore(redis, PREFIX);
    engineHealth = new EngineHealthService(pool);
    for (const entry of QUEUE_TOPOLOGY) dlqs.set(entry.name, buildDlqQueue(entry, { connection: redis, prefix: PREFIX }));
  }, 180_000);

  afterAll(async () => {
    await Promise.all([...dlqs.values()].map((q) => q.close().catch(() => undefined)));
    await redis.quit().catch(() => undefined);
    await pool.end();
    await valkey.stop();
    await container.stop();
  });

  beforeEach(async () => {
    await redis.flushall();
    await pool.query("DELETE FROM engine_health");
  });

  function replicas(storeForReplica: MonitorStateStore = store, engines: Array<"chatgpt"> = ["chatgpt"]) {
    const pages: Array<Record<string, unknown>> = [];
    const pager: Pager = { page: (_m, context) => void pages.push(context) };
    const make = () =>
      new MonitorRuntime({
        pool,
        store: storeForReplica,
        readDlqDepths: dlqDepthReader(dlqs),
        readLastSuccess: (keys) => engineHealth.lastSuccessAtMs(keys),
        engines,
        pager,
      });
    return { a: make(), b: make(), pages };
  }

  /** Yields between the read and the write so two unelected replicas would both see the old state. */
  function slowStore(inner: MonitorStateStore): MonitorStateStore {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
    return {
      load: async () => {
        const state = await inner.load();
        await pause();
        return state;
      },
      save: (state) => inner.save(state),
    };
  }

  async function fillDlq(queueName: string, count: number): Promise<void> {
    const dlq = dlqs.get(queueName)!;
    await dlq.addBulk(Array.from({ length: count }, (_, i) => ({ name: `${queueName}.dlq`, data: { n: i }, opts: { attempts: 1 } })));
  }

  it("STORY-179 AC3/AC5 · a sustained DLQ depth read from real queues pages once between two replicas ticking together", async () => {
    await fillDlq("capture.execute", 51);
    const sustained: MonitorState = {
      ...EMPTY_MONITOR_STATE,
      dlq: { aboveSince: { "capture.execute": Date.now() - DLQ_DEPTH_SUSTAINED_MS - 1_000 }, alreadyPaged: [] },
    };
    await store.save(sustained);

    const { a, b, pages } = replicas(slowStore(store));
    await Promise.all([a.tick(), b.tick()]);

    const dlqPages = pages.filter((p) => p.alertName === "dlq_depth_sustained");
    expect(dlqPages).toHaveLength(1);
    expect(dlqPages[0]).toMatchObject({ queue: "capture.execute", depth: 51 });
    // …and a later tick on either replica stays quiet: "already paged" travelled through Valkey.
    await b.tick();
    await a.tick();
    expect(pages.filter((p) => p.alertName === "dlq_depth_sustained")).toHaveLength(1);
  }, 60_000);

  it("STORY-179 AC1 · a depth of exactly 50 is at the threshold and never opens a window", async () => {
    await fillDlq("capture.parse", 50);
    const { a } = replicas();
    await a.tick();
    expect((await store.load())?.dlq.aboveSince).toEqual({});
  }, 60_000);

  it("STORY-179 AC2/AC5 · an engine dark for over 48h in engine_health pages once between two replicas, then respects the cooldown", async () => {
    await pool.query(
      `INSERT INTO engine_health (engine_key, bucket_start, attempts, successes, blocks) VALUES ('chatgpt', $1, 3, 3, 0)`,
      [new Date(Date.now() - BLACKOUT_THRESHOLD_MS - 3_600_000)],
    );
    // A later bucket with attempts but NO success must not count as one.
    await pool.query(
      `INSERT INTO engine_health (engine_key, bucket_start, attempts, successes, blocks) VALUES ('chatgpt', $1, 5, 0, 5)`,
      [new Date(Date.now() - 3_600_000)],
    );

    const { a, b, pages } = replicas(slowStore(store));
    await Promise.all([a.tick(), b.tick()]);
    await a.tick();
    await b.tick();

    const blackoutPages = pages.filter((p) => p.alertName === "engine_blackout");
    expect(blackoutPages).toHaveLength(1);
    expect(blackoutPages[0]).toMatchObject({ engineKey: "chatgpt" });
  }, 60_000);

  it("STORY-179 AC2 · an engine with a recent success does not page", async () => {
    await pool.query(
      `INSERT INTO engine_health (engine_key, bucket_start, attempts, successes) VALUES ('chatgpt', $1, 1, 1)`,
      [new Date(Date.now() - 60_000)],
    );
    const { a, pages } = replicas();
    await a.tick();
    expect(pages).toHaveLength(0);
  }, 60_000);

  it("STORY-179 · lastSuccessAtMs distinguishes 'never succeeded' (null) from 'succeeded long ago'", async () => {
    const old = new Date(Date.now() - 10 * 86_400_000);
    await pool.query(`INSERT INTO engine_health (engine_key, bucket_start, attempts, successes) VALUES ('claude', $1, 1, 1)`, [old]);
    await pool.query(`INSERT INTO engine_health (engine_key, bucket_start, attempts, successes, blocks) VALUES ('gemini', $1, 1, 0, 1)`, [old]);
    const result = await engineHealth.lastSuccessAtMs(["claude", "gemini", "grok"]);
    expect(result.get("claude")).toBe(old.getTime());
    expect(result.get("gemini")).toBeNull();
    expect(result.get("grok")).toBeNull();
  }, 60_000);

  it("STORY-179 · the Valkey store round-trips state, starts empty, and treats an unreadable value as empty rather than an outage", async () => {
    expect(await store.load()).toBeNull();
    const state: MonitorState = {
      dlq: { aboveSince: { "capture.execute": 5 }, alreadyPaged: ["capture.execute"] },
      blackout: { darkSinceMs: { chatgpt: 7 }, lastPagedAtMs: { chatgpt: 9 } },
    };
    await store.save(state);
    expect(await store.load()).toEqual(state);
    expect(await redis.ttl(`${PREFIX}:monitor-state`)).toBeGreaterThan(0);
    await redis.set(`${PREFIX}:monitor-state`, "{not json");
    expect(await store.load()).toBeNull();
    await redis.set(`${PREFIX}:monitor-state`, JSON.stringify({ dlq: {}, extra: 1 }));
    expect(await store.load()).toBeNull();
  }, 60_000);
});
