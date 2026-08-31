import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Redis } from "ioredis";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import type { Cache } from "../../src/lib/cache/cache.port.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { buildQueue } from "../../src/lib/queue/queue-factory.js";
import { QUEUE_TOPOLOGY, type QueueTopologyEntry } from "../../src/lib/queue/topology.js";
import { captureL1Key } from "../../src/lib/capture/l1-cache-key.js";
import { adapterMajorOf } from "../../src/lib/capture/l1-exact-hash.js";
import { FAIR_USE_METRIC } from "../../src/lib/capture/fair-use.js";
import { dispatchPlannedRun, planRun, type PlanRunContext } from "../../src/lib/capture/plan-run.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-032 — the seam.
//
// Every module in src/lib/capture/ had its own test and none of them could
// see the others. The criteria that are ABOUT the meeting had nowhere to be
// asserted, and one of them — AC12's "before any job is enqueued" — was
// covered by a test that checked a count that was zero either way.
//
// These are the properties that exist only here: which layer gets first
// refusal on a cell, what is durable before a job exists, what a refusal
// leaves behind, and what the ceiling is charged for.

const ENTRY: QueueTopologyEntry = QUEUE_TOPOLOGY.find((entry) => entry.name === "capture.plan")!;
const PERIOD = "2026-08-01";
const TTL_SECONDS = 86_400;
const NOW_MS = Date.UTC(2026, 7, 20, 12, 0, 0);

describe("STORY-032 · planning a run end to end", () => {
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

  function newQueue() {
    const connection = createQueueWorkerConnection(valkey.connectionString);
    connections.push(connection);
    const queue = buildQueue(ENTRY, { connection, prefix: queueKeyPrefix(`plan-run-${randomUUID().slice(0, 8)}`) });
    cleanups.push(async () => {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    });
    return queue;
  }

  beforeEach(async () => {
    await db.query(
      "TRUNCATE answer_captures, tracked_prompts, project_engines, capture_runs, projects, usage_counters, workspaces, engines CASCADE",
    );
    cache = new InMemoryCacheAdapter();
    workspaceId = randomUUID();
    projectId = randomUUID();
    runId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, priority_prompt_limit)
       VALUES ($1, $2, 'P', $3, 'https://e.test', 'e.test', 10)`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys)
       VALUES ($1, $2, $3, 'scheduled', ARRAY['perplexity'])`,
      [runId, workspaceId, projectId],
    );
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version,
                            cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ('perplexity', 'perplexity', 'v', 'api', '1.0.0', $1, 'medium', 'free', 'active')`,
      [TTL_SECONDS],
    );
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count)
       VALUES ($1, $2, 'perplexity', true, 1)`,
      [workspaceId, projectId],
    );
    await setCeiling(1_000);
  });

  async function setCeiling(limit: number, used = 0, reserved = 0): Promise<void> {
    await db.query(
      `INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value, reserved_value)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, metric, period_start)
         DO UPDATE SET limit_value = EXCLUDED.limit_value, used_value = EXCLUDED.used_value,
                       reserved_value = EXCLUDED.reserved_value`,
      [workspaceId, FAIR_USE_METRIC, PERIOD, limit, used, reserved],
    );
  }

  async function addPrompt(text: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash,
                                    intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', false, 'active')`,
      [id, workspaceId, projectId, text, Buffer.from(text, "utf8")],
    );
    return id;
  }

  function context(overrides: Partial<PlanRunContext> = {}): PlanRunContext {
    return {
      workspaceId,
      projectId,
      runId,
      trigger: "scheduled",
      cadence: "weekly",
      planKey: "growth",
      scope: "all",
      periodStart: PERIOD,
      locale: "en-US",
      personaHint: null,
      normalizerVersion: "v1",
      captureMode: "api",
      aliasFingerprint: Buffer.alloc(32, 7),
      env: "test",
      sharedCacheEnabled: true,
      nowMs: NOW_MS,
      ...overrides,
    };
  }

  /** Seed the shared answer cache so the L1 probe finds `text`. */
  async function seedL1(text: string, contentHash: string): Promise<void> {
    await cache.set(
      captureL1Key({
        env: "test",
        engineKey: "perplexity",
        adapterMajor: adapterMajorOf("1.0.0"),
        promptText: text,
        locale: "en-US",
        personaHint: null,
        ttlSeconds: TTL_SECONDS,
        nowMs: NOW_MS,
      }),
      contentHash,
      { ttlMs: 600_000 },
    );
  }

  async function counts(): Promise<{ planned: number; skipped: number; captured: number }> {
    const row = await db.query<{ planned_cells: number; skipped_cells: number; captured_cells: number }>(
      "SELECT planned_cells, skipped_cells, captured_cells FROM capture_runs WHERE id = $1",
      [runId],
    );
    return {
      planned: row.rows[0]!.planned_cells,
      skipped: row.rows[0]!.skipped_cells,
      captured: row.rows[0]!.captured_cells,
    };
  }

  // The guard on everything below: if planning produced nothing, every
  // "must not" assertion would hold for the wrong reason.
  it("plans a run with nothing cached: every cell live, counters recorded", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");

    const plan = await planRun(db, cache, context());

    expect(plan.planned).toBe(2);
    expect(plan.skipped).toBe(0);
    expect(plan.live).toBe(2);
    expect(await counts()).toEqual({ planned: 2, skipped: 0, captured: 0 });
  }, 60_000);

  // AC12, AS AN ORDERING RATHER THAN A HOPE. The previous test for this
  // asserted a count that was zero either way. This one can only pass if the
  // counters are durable at a moment when no job exists — and the only way
  // to reach dispatch is to hold what planRun returned.
  it("makes the counters durable BEFORE any job can exist", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    const queue = newQueue();

    const plan = await planRun(db, cache, context());

    expect(await counts(), "the plan must be durable at this point").toMatchObject({ planned: 2, skipped: 0 });
    expect(await queue.getJobCountByTypes("waiting", "delayed", "prioritized", "active")).toBe(0);

    await dispatchPlannedRun(queue, ENTRY, plan);

    expect(await queue.getJobCountByTypes("waiting", "delayed", "prioritized", "active")).toBe(2);
  }, 60_000);

  it("enqueues only the LIVE cells, never the suppressed ones", async () => {
    const cached = "best crm";
    await addPrompt(cached);
    await addPrompt("best erp");
    await seedL1(cached, "a".repeat(64));
    const queue = newQueue();

    const plan = await planRun(db, cache, context());
    await dispatchPlannedRun(queue, ENTRY, plan);

    expect(plan.skipped).toBe(1);
    expect(plan.live).toBe(1);
    expect(await queue.getJobCountByTypes("waiting", "delayed", "prioritized", "active")).toBe(1);
  }, 60_000);

  // EXACTLY ONE LAYER PER CELL. A cell answered by L1 must not be offered to
  // L2: it would cost a vector query for an answer already in hand, and a
  // double hit would write TWO answer_captures rows for one cell and count
  // as two skips — inflating the suppression rate with duplicates.
  it("does not offer an L1-suppressed cell to the L2 probe", async () => {
    const cached = "best crm";
    await addPrompt(cached);
    await addPrompt("best erp");
    await seedL1(cached, "a".repeat(64));

    // Read the batch the L2 probe is actually given, from the SQL parameters.
    let l2Batch: { prompt_id: string }[] = [];
    const watching = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "query") {
          return (sql: string, values?: unknown[]) => {
            // Both this and recordSuppressedCells unnest a jsonb batch
            // whose column list starts identically; ttl_seconds is the L2
            // probe's alone.
            if (sql.includes("ttl_seconds int)") && Array.isArray(values)) {
              l2Batch = JSON.parse(String(values[1])) as { prompt_id: string }[];
            }
            return (target.query as (...args: unknown[]) => unknown)(sql, values);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const plan = await planRun(watching, cache, context());

    expect(l2Batch, "only the cells L1 could not answer").toHaveLength(1);
    expect(plan.suppressedByLayer).toEqual({ l1: 1, l2: 0 });

    const rows = await db.query<{ count: string }>(
      "SELECT count(*) AS count FROM answer_captures WHERE run_id = $1",
      [runId],
    );
    expect(Number(rows.rows[0]!.count), "one suppressed cell, one row").toBe(1);
  }, 60_000);

  // THE CEILING IS FOR VENDOR CALLS. A cell served from cache makes none, so
  // charging for it would let the cache save money on the invoice and
  // nothing on the quota.
  it("reserves capacity for the live cells only, not the planned ones", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    await addPrompt("best hrm");
    await seedL1("best crm", "a".repeat(64));
    await seedL1("best erp", "b".repeat(64));

    await planRun(db, cache, context());

    const row = await db.query<{ reserved_value: string }>(
      "SELECT reserved_value FROM usage_counters WHERE workspace_id = $1 AND metric = $2",
      [workspaceId, FAIR_USE_METRIC],
    );
    expect(Number(row.rows[0]!.reserved_value), "3 planned, 2 cached, 1 vendor call").toBe(1);
  }, 60_000);

  // A REFUSAL MUST LEAVE NOTHING BEHIND. Reserve is the first write for
  // exactly this reason: suppressed rows and counters for a run that will
  // not happen would make the matrix claim a plan that was refused.
  it("writes nothing at all when the fair-use ceiling refuses", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    await setCeiling(1);
    const queue = newQueue();

    await expect(planRun(db, cache, context())).rejects.toThrow(/fair-use|ceiling|quota/iu);

    expect(await counts(), "no plan may be recorded for a refused run").toMatchObject({ planned: 0, skipped: 0 });
    const rows = await db.query("SELECT 1 FROM answer_captures WHERE run_id = $1", [runId]);
    expect(rows.rowCount).toBe(0);
    expect(await queue.getJobCountByTypes("waiting", "delayed", "prioritized", "active")).toBe(0);
  }, 60_000);

  it("measures suppression per cohort, not blended", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    await seedL1("best crm", "a".repeat(64));

    const plan = await planRun(db, cache, context({ cadence: "daily", planKey: "free" }));

    // A free-plan daily project is in all three cohorts and is measured
    // against each one's own target — a blended number would report one.
    expect(plan.cohorts.map((c) => c.cohort)).toEqual(["overall", "daily_cadence", "free_plan"]);
    expect(new Set(plan.cohorts.map((c) => c.rate))).toEqual(new Set([0.5]));
    expect(plan.cohorts.find((c) => c.cohort === "free_plan")!.meetsTarget, "0.5 >= the 0.45 free target").toBe(true);
    expect(plan.cohorts.find((c) => c.cohort === "overall")!.meetsTarget, "0.5 >= the 0.30 overall target").toBe(true);
  }, 60_000);

  it("charges nothing for a scheduled run and hooks the charge for a manual one", async () => {
    await addPrompt("best crm");

    expect((await planRun(db, cache, context())).charge.charged).toBe(false);
    expect((await planRun(db, cache, context({ trigger: "manual" }))).charge.reason).toMatch(/wallet/iu);
  }, 60_000);

  // TWO CELLS, NOT ONE, and the count is asserted on both dispatches. With a
  // single cell this passes just as well when every cell shares one
  // deduplication key — and a colliding key does not double-enqueue, it
  // silently DROPS cells, which is the worse of the two failures and the
  // invisible one.
  it("assigns each cell its own dedup identity, so a replay adds nothing and loses nothing", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    const queue = newQueue();

    const plan = await planRun(db, cache, context());
    expect(new Set(plan.cells.map((cell) => cell.idempotencyKey)).size, "one identity per cell").toBe(2);

    await dispatchPlannedRun(queue, ENTRY, plan);
    expect(await queue.getJobCountByTypes("waiting", "delayed", "prioritized", "active")).toBe(2);

    await dispatchPlannedRun(queue, ENTRY, plan);
    expect(
      await queue.getJobCountByTypes("waiting", "delayed", "prioritized", "active"),
      "a replayed plan must produce at most one job per cell",
    ).toBe(2);
  }, 60_000);

  it("bypasses the shared cache entirely for a no_shared_cache workspace", async () => {
    await addPrompt("best crm");
    await seedL1("best crm", "a".repeat(64));

    const plan = await planRun(db, cache, context({ sharedCacheEnabled: false }));

    expect(plan.skipped, "a seeded answer must not be served to a bypassing workspace").toBe(0);
    expect(plan.live).toBe(1);
  }, 60_000);
});
