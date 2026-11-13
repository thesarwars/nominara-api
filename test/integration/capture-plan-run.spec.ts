import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Redis } from "ioredis";
import { Client, type ClientBase } from "pg";
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
const PARSE: QueueTopologyEntry = QUEUE_TOPOLOGY.find((entry) => entry.name === "capture.parse")!;
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
  /**
   * STORY-152 — the engines THIS spec seeds, and the reason it has to say so.
   *
   * `resolveEnabledEngines` returns ENTITLEMENT ∩ CAPTURE-READY, and in
   * production the capture-ready half is EMPTY: every engine in the registry is
   * fixture-backed and cannot answer a real prompt until STORY-001 opens the
   * vendor accounts. This spec is about the RUN LIFECYCLE — dispatch, progress,
   * suppression, refusal — none of which can be exercised with an empty set, so
   * it declares capture-ready exactly the keys `addEngine` seeded and nothing
   * more. The entitlement filter stays the only thing under test.
   */
  let seededEngineKeys: string[];
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

  function newQueue(entry: QueueTopologyEntry = ENTRY) {
    const connection = createQueueWorkerConnection(valkey.connectionString);
    connections.push(connection);
    const queue = buildQueue(entry, { connection, prefix: queueKeyPrefix(`plan-run-${randomUUID().slice(0, 8)}`) });
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
    seededEngineKeys = [];
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
    await addEngine("perplexity");
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count)
       VALUES ($1, $2, 'perplexity', true, 1)`,
      [workspaceId, projectId],
    );
    await setCeiling(1_000);
  });

  /**
   * Seed a catalog engine and record it as capture-ready for this spec.
   *
   * NO `cadence_by_plan`. `project_entitled_engines` gates on the plan FLOOR
   * alone — a cadence entry governs whether the SCHEDULER runs an engine, not
   * whether the project may capture on it (STORY-130 §57). The floor stays
   * the caller's to state, which is what the entitlement reconciliation test
   * below turns on.
   */
  async function addEngine(key: string, minPlan = "free"): Promise<void> {
    if (!seededEngineKeys.includes(key)) seededEngineKeys.push(key);
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version,
                            cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ($1, $1, 'v', 'api', '1.0.0', $2, 'medium', $3, 'active')`,
      [key, TTL_SECONDS, minPlan],
    );
  }

  /**
   * STORY-070 — the ceiling as the CONTRACT sets it, not as a hand-written row.
   *
   * planRun provisions the counter from resolved entitlements before it
   * reserves, so writing `limit_value` directly no longer holds: the next plan
   * derives it again and overwrites whatever a test wrote. Setting the
   * workspace override is the real mechanism and is what a negotiated ceiling
   * actually is.
   */
  async function setCeilingByEntitlement(limit: number): Promise<void> {
    await db.query(
      `UPDATE workspaces SET entitlement_overrides = jsonb_build_object('fair_use.captures_per_cycle', $2::int)
        WHERE id = $1`,
      [workspaceId, limit],
    );
  }

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
      // The seam. See `seededEngineKeys` above: production's capture-ready set
      // is empty because no adapter can capture yet, and this spec tests the
      // run lifecycle rather than the registry.
      captureReadyEngineKeys: [...seededEngineKeys],
      env: "test",
      sharedCacheEnabled: true,
      nowMs: NOW_MS,
      ...overrides,
    };
  }

  /** Seed the shared answer cache so the L1 probe finds `text`. */
  async function seedL1(text: string, contentHash: string, answer = "the shared answer"): Promise<void> {
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
      JSON.stringify({ v: 2, contentHash, payload: { answer }, excerpt: answer }),
      { ttlMs: 600_000 },
    );
  }

  /**
   * planRun REQUIRES a transaction and says so by taking a savepoint, so
   * every call here opens one. That is not test ceremony — it is the
   * contract, and running these against an autocommit client is what let a
   * partial write go unnoticed.
   */
  async function planInTransaction(client: ClientBase, ctx: PlanRunContext) {
    await client.query("BEGIN");
    try {
      const planned = await planRun(client, cache, ctx);
      await client.query("COMMIT");
      return planned;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
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

    const plan = await planInTransaction(db, context());

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

    const plan = await planInTransaction(db, context());

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
    // STORY-032 AC7: a plan with a reused row needs somewhere to send its re-match parse. That is a different queue
    // from the cells', so the count below is still the LIVE cells only.
    const parseQueue = newQueue(PARSE);

    const plan = await planInTransaction(db, context());
    await dispatchPlannedRun(queue, ENTRY, plan, { parse: { queue: parseQueue, entry: PARSE } });

    expect(plan.skipped).toBe(1);
    expect(plan.live).toBe(1);
    expect(await queue.getJobCountByTypes("waiting", "delayed", "prioritized", "active")).toBe(1);
  }, 60_000);

  // THE SUPPRESSED ROW MUST BE A ROW SOMEONE CAN READ.
  //
  // The cross-tenant hit is the whole point of L1, so the tenant reading it
  // has by definition never captured this answer. If the entry supplied only
  // a hash, the row would carry no answer anywhere in this workspace: NULL
  // raw_object_key, NULL excerpt, empty payload, nothing for EPIC-05 to
  // match — and `brand_present NOT NULL DEFAULT false` would present it to
  // any later aggregation as "the brand was absent". That row shipped, and
  // the test above asserted `skipped === 1` and called it correct.
  it("writes an L1 row carrying the answer, not an empty row nothing can score", async () => {
    await addPrompt("best crm");
    await seedL1("best crm", "a".repeat(64), "Acme is widely recommended.");

    await planInTransaction(db, context());

    const row = await db.query<{
      payload: { answer?: string };
      response_excerpt: string | null;
      content_hash: Buffer;
      source_result_id: string | null;
    }>(
      `SELECT payload, response_excerpt, content_hash, source_result_id
         FROM answer_captures WHERE run_id = $1 AND cache_layer = 'l1'`,
      [runId],
    );

    expect(row.rows[0]!.payload.answer, "the answer must be IN the row").toBe("Acme is widely recommended.");
    expect(row.rows[0]!.response_excerpt).toBe("Acme is widely recommended.");
    expect(row.rows[0]!.content_hash.toString("hex")).toBe("a".repeat(64));
    // And no cross-tenant reference: the capture it shares belongs to
    // someone else, so there is nothing in this workspace to point at.
    expect(row.rows[0]!.source_result_id, "an L1 row may never reference another tenant's capture").toBeNull();
  }, 60_000);

  // STORY-032 AC15 - scenario 15: the run's trigger sets the licensed-SERP mode on every live cell it will enqueue.
  it("STORY-032 AC15 - a manual run's cells carry requestMode live and a scheduled run's carry queued", async () => {
    await addEngine("google_aio");
    await addEngine("google_ai_mode");
    await addPrompt("best crm");
    const modes = async (trigger: PlanRunContext["trigger"]) => {
      await db.query("DELETE FROM answer_captures WHERE run_id = $1", [runId]);
      const plan = await planInTransaction(db, context({ trigger }));
      return plan.cells.map((cell) => `${cell.engineKey}:${(cell.payload as { requestMode?: string }).requestMode}`).sort();
    };
    expect(await modes("manual")).toEqual(["google_ai_mode:live", "google_aio:live", "perplexity:live"]);
    expect(await modes("scheduled")).toEqual(["google_ai_mode:queued", "google_aio:queued", "perplexity:queued"]);
  }, 60_000);

  // STORY-032 AC16 - scenario 16, L1 half: through the real probe -> cell -> row path.
  it("STORY-032 AC16 - an L1-suppressed cell's row carries the entry's async_generated and no_ai_overview_for_query", async () => {
    await addPrompt("best crm");
    await cache.set(
      captureL1Key({ env: "test", engineKey: "perplexity", adapterMajor: adapterMajorOf("1.0.0"), promptText: "best crm", locale: "en-US", personaHint: null, ttlSeconds: TTL_SECONDS, nowMs: NOW_MS }),
      JSON.stringify({ v: 2, contentHash: "a".repeat(64), payload: { answer: "" }, excerpt: null, asyncGenerated: true, flags: ["no_ai_overview_for_query"] }),
      { ttlMs: 600_000 },
    );
    await planInTransaction(db, context());
    const row = await db.query<{ flags: string[]; async_generated: boolean | null }>("SELECT flags, async_generated FROM answer_captures WHERE run_id = $1 AND cache_layer = 'l1'", [runId]);
    expect(row.rows[0]).toEqual({ flags: ["no_ai_overview_for_query"], async_generated: true });
  }, 60_000);

  // STORY-032 AC16 - scenario 16, L2 half: a near-duplicate prompt reuses a source whose answer was on-demand and a flagged absence.
  it("STORY-032 AC16 - an L2-suppressed cell's row carries its source's async_generated and no_ai_overview_for_query", async () => {
    const vector = (mix: number) => {
      const v = new Array<number>(1536).fill(0);
      const norm = Math.sqrt(1 + mix * mix);
      v[0] = 1 / norm;
      v[1] = mix / norm;
      return `[${v.join(",")}]`;
    };
    const sourcePrompt = await addPrompt("best crm for small business");
    const targetPrompt = await addPrompt("best crm for small businesses");
    await db.query("UPDATE tracked_prompts SET embedding = $2::halfvec WHERE id = $1", [sourcePrompt, vector(0)]);
    await db.query("UPDATE tracked_prompts SET embedding = $2::halfvec WHERE id = $1", [targetPrompt, vector(0.1)]);
    // The source is a PRIOR run's parsed capture of the source prompt, so only the target cell can be reused.
    const priorRun = randomUUID();
    await db.query(`INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys) VALUES ($1, $2, $3, 'scheduled', ARRAY['perplexity'])`, [priorRun, workspaceId, projectId]);
    await db.query(
      `INSERT INTO answer_captures (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version,
                                    content_hash, status, cache_layer, async_generated, flags)
       VALUES ($1, $2, $3, $4, 'perplexity', now(), 'api', '1.0.0', 'v1', sha256('x'::bytea), 'parsed', 'live', true, ARRAY['no_ai_overview_for_query'])`,
      [workspaceId, projectId, priorRun, sourcePrompt],
    );
    await db.query("UPDATE tracked_prompts SET status = 'paused' WHERE id = $1", [sourcePrompt]);
    const plan = await planInTransaction(db, context());
    expect(plan.suppressedByLayer.l2, "the probe must be capable of reusing, or the assertion below is vacuous").toBe(1);
    const row = await db.query<{ flags: string[]; async_generated: boolean | null }>("SELECT flags, async_generated FROM answer_captures WHERE run_id = $1 AND cache_layer = 'l2'", [runId]);
    expect(row.rows[0]).toEqual({ flags: ["no_ai_overview_for_query"], async_generated: true });
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

    const plan = await planInTransaction(watching, context());

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

    await planInTransaction(db, context());

    const row = await db.query<{ reserved_value: string }>(
      "SELECT reserved_value FROM usage_counters WHERE workspace_id = $1 AND metric = $2",
      [workspaceId, FAIR_USE_METRIC],
    );
    expect(Number(row.rows[0]!.reserved_value), "3 planned, 2 cached, 1 vendor call").toBe(1);
  }, 60_000);

  // THE BLOCK EPIC-04's RISK TABLE CALLED "REALIZED as of 2026-08-31".
  //
  // "Capture refuses every workspace because nothing provisions the fair-use
  // counter it reserves against." The reservation matches a row or it matches
  // nothing, and nothing created the row — so a workspace's very first run was
  // refused, every time, on every plan. This is the test that says it is over.
  it("plans successfully for a workspace that has never had a counter row", async () => {
    await db.query("DELETE FROM usage_counters WHERE workspace_id = $1", [workspaceId]);
    await addPrompt("best crm");

    const plan = await planInTransaction(db, context());

    expect(plan.planned).toBe(1);
    expect(plan.live).toBe(1);
    // Provisioned from the plan, not from anything a test wrote: growth's
    // fair_use.captures_per_cycle is 6000.
    const row = await db.query<{ limit_value: string; reserved_value: string }>(
      "SELECT limit_value, reserved_value FROM usage_counters WHERE workspace_id = $1 AND metric = $2",
      [workspaceId, FAIR_USE_METRIC],
    );
    expect(row.rows[0]).toMatchObject({ limit_value: "6000", reserved_value: "1" });
  }, 60_000);

  it("a negotiated ceiling in the workspace's overrides is what gets provisioned", async () => {
    await db.query("DELETE FROM usage_counters WHERE workspace_id = $1", [workspaceId]);
    await setCeilingByEntitlement(99);
    await addPrompt("best crm");

    await planInTransaction(db, context());

    const row = await db.query<{ limit_value: string }>(
      "SELECT limit_value FROM usage_counters WHERE workspace_id = $1 AND metric = $2",
      [workspaceId, FAIR_USE_METRIC],
    );
    expect(row.rows[0]!.limit_value).toBe("99");
  }, 60_000);

  // A REFUSAL MUST LEAVE NOTHING BEHIND. Reserve is the first write for
  // exactly this reason: suppressed rows and counters for a run that will
  // not happen would make the matrix claim a plan that was refused.
  it("writes nothing at all when the fair-use ceiling refuses", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    // Through the override, so the refusal happens for the reason it would in
    // production: the plan's ceiling, resolved and provisioned by planRun.
    await setCeilingByEntitlement(1);
    const queue = newQueue();

    await expect(planInTransaction(db, context())).rejects.toThrow(/fair-use|ceiling|quota/iu);

    expect(await counts(), "no plan may be recorded for a refused run").toMatchObject({ planned: 0, skipped: 0 });
    const rows = await db.query("SELECT 1 FROM answer_captures WHERE run_id = $1", [runId]);
    expect(rows.rowCount).toBe(0);
    expect(await queue.getJobCountByTypes("waiting", "delayed", "prioritized", "active")).toBe(0);
  }, 60_000);

  // REPLANNING IS THE RECOVERY PATH, so it has to be idempotent.
  //
  // dispatchPlannedRun's own docstring names it: a crash between the plan
  // committing and the jobs being enqueued is recovered by planning again.
  // Nothing enforced that. `ux_results_cell` could not — it carries
  // captured_at, which is now(), so ON CONFLICT never fired — and a second
  // plan wrote a SECOND suppressed row for the same cell while
  // `skipped_cells` still recorded one, and reserved the live cell a second
  // time. Reproduced by the review: 2 rows, reserved_value 2, skipped 1.
  it("replanning the same run writes no second row and reserves no second time", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    await seedL1("best crm", "a".repeat(64));

    const first = await planInTransaction(db, context());
    const second = await planInTransaction(db, context());

    expect(second.planned, "the plan itself is unchanged").toBe(first.planned);
    expect(second.skipped).toBe(first.skipped);

    const rows = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM answer_captures WHERE run_id = $1 AND cache_layer = 'l1'",
      [runId],
    );
    expect(Number(rows.rows[0]!.n), "one cached cell, one row — not two").toBe(1);

    const reserved = await db.query<{ reserved_value: string }>(
      "SELECT reserved_value FROM usage_counters WHERE workspace_id = $1 AND metric = $2",
      [workspaceId, FAIR_USE_METRIC],
    );
    expect(Number(reserved.rows[0]!.reserved_value), "one live cell, one reservation").toBe(1);

    expect(await counts(), "and the counters still describe one run").toMatchObject({ planned: 2, skipped: 1 });
  }, 60_000);

  // The other direction: a replan whose cache entry has since expired finds
  // one MORE live cell, and must reserve exactly that one more.
  it("reserves the difference when a replan finds more live cells than before", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    await seedL1("best crm", "a".repeat(64));

    await planInTransaction(db, context());
    await cache.delete(
      captureL1Key({
        env: "test",
        engineKey: "perplexity",
        adapterMajor: adapterMajorOf("1.0.0"),
        promptText: "best crm",
        locale: "en-US",
        personaHint: null,
        ttlSeconds: TTL_SECONDS,
        nowMs: NOW_MS,
      }),
    );
    const second = await planInTransaction(db, context());

    expect(second.live, "the expired entry means both cells are live now").toBe(2);
    const reserved = await db.query<{ reserved_value: string }>(
      "SELECT reserved_value FROM usage_counters WHERE workspace_id = $1 AND metric = $2",
      [workspaceId, FAIR_USE_METRIC],
    );
    expect(Number(reserved.rows[0]!.reserved_value), "1 held from the first plan, 1 more now").toBe(2);
  }, 60_000);

  // THE TRANSACTION IS A REQUIREMENT, NOT A CONVENTION.
  it("refuses to plan on an autocommit connection rather than writing half a plan", async () => {
    await addPrompt("best crm");

    await expect(planRun(db, cache, context())).rejects.toThrow(/transaction blocks/u);

    expect(await counts(), "and nothing was recorded").toMatchObject({ planned: 0, skipped: 0 });
  }, 60_000);

  // WHAT A FAILURE MID-WRITE LEAVES BEHIND: nothing.
  //
  // recordRunCounts throws when it matches no row, and it runs AFTER the
  // reservation and after the suppressed rows. A run row deleted
  // concurrently — a cancel racing a plan — used to leave the rows written
  // and the capacity reserved for a plan that threw. Reproduced by the
  // review: 1 orphan row, 1 reserved.
  it("leaves no rows and no reservation when the plan fails after writing", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    await seedL1("best crm", "a".repeat(64));

    await db.query("BEGIN");
    // Delete the run inside the same transaction, so recordRunCounts finds
    // nothing to update and throws at the very end of the write leg.
    await db.query("DELETE FROM capture_runs WHERE id = $1", [runId]);
    await expect(planRun(db, cache, context())).rejects.toThrow(/updated 0/u);

    const orphans = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM answer_captures WHERE run_id = $1", [runId]);
    const reserved = await db.query<{ reserved_value: string }>(
      "SELECT reserved_value FROM usage_counters WHERE workspace_id = $1 AND metric = $2",
      [workspaceId, FAIR_USE_METRIC]);

    expect(Number(orphans.rows[0]!.n), "suppressed rows for a plan that threw").toBe(0);
    expect(Number(reserved.rows[0]!.reserved_value), "capacity held for a run that will not happen").toBe(0);
    await db.query("ROLLBACK");
  }, 60_000);

  // §5: the run row must record exactly which engines the run COVERED.
  it("reconciles engine_keys with the engines entitlement actually allowed", async () => {
    // A second engine the project enables but the plan does not entitle.
    await addEngine("gemini", "business");
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count)
       VALUES ($1, $2, 'gemini', true, 1)`,
      [workspaceId, projectId],
    );
    await db.query("UPDATE capture_runs SET engine_keys = ARRAY['perplexity','gemini'] WHERE id = $1", [runId]);
    await addPrompt("best crm");

    await planInTransaction(db, context());

    const row = await db.query<{ engine_keys: string[] }>(
      "SELECT engine_keys FROM capture_runs WHERE id = $1", [runId]);
    expect(
      row.rows[0]!.engine_keys,
      "the row must not claim an engine the workspace is not entitled to and which never ran",
    ).toEqual(["perplexity"]);
  }, 60_000);

  // THE STAMP MUST BE THE SET AS IT IS NOW, read at write time.
  //
  // aliasSetFingerprint had no caller in src/ at all — the planner took a
  // Buffer from a context nobody built, so nothing connected the stamp to
  // the project's actual configuration. A competitor added between one plan
  // and the next has to change it, or a reuse short-circuits against an
  // alias set the matcher no longer has.
  it("stamps the alias set it reads from the database, not one it was handed", async () => {
    await addPrompt("best crm");
    await seedL1("best crm", "a".repeat(64));
    await planInTransaction(db, context());

    const before = await db.query<{ alias_fingerprint: Buffer }>(
      "SELECT alias_fingerprint FROM answer_captures WHERE run_id = $1", [runId]);

    await db.query(
      `INSERT INTO competitors (workspace_id, project_id, name, aliases, root_domain)
       VALUES ($1, $2, 'Initech', ARRAY['Initech Inc'], 'initech.test')`,
      [workspaceId, projectId],
    );
    await db.query("DELETE FROM answer_captures WHERE run_id = $1", [runId]);
    await db.query("UPDATE capture_runs SET planned_cells = 0, skipped_cells = 0 WHERE id = $1", [runId]);
    await planInTransaction(db, context());

    const after = await db.query<{ alias_fingerprint: Buffer }>(
      "SELECT alias_fingerprint FROM answer_captures WHERE run_id = $1", [runId]);

    expect(
      after.rows[0]!.alias_fingerprint.equals(before.rows[0]!.alias_fingerprint),
      "a competitor added between the two runs must change the stamp",
    ).toBe(false);
  }, 60_000);

  it("measures suppression per cohort, not blended", async () => {
    await addPrompt("best crm");
    await addPrompt("best erp");
    await seedL1("best crm", "a".repeat(64));

    const plan = await planInTransaction(db, context({ cadence: "daily", planKey: "free" }));

    // A free-plan daily project is in all three cohorts and is measured
    // against each one's own target — a blended number would report one.
    expect(plan.cohorts.map((c) => c.cohort)).toEqual(["overall", "daily_cadence", "free_plan"]);
    expect(new Set(plan.cohorts.map((c) => c.rate))).toEqual(new Set([0.5]));
    expect(plan.cohorts.find((c) => c.cohort === "free_plan")!.meetsTarget, "0.5 >= the 0.45 free target").toBe(true);
    expect(plan.cohorts.find((c) => c.cohort === "overall")!.meetsTarget, "0.5 >= the 0.30 overall target").toBe(true);
  }, 60_000);

  it("charges nothing for a scheduled run and hooks the charge for a manual one", async () => {
    await addPrompt("best crm");

    expect((await planInTransaction(db, context())).charge.charged).toBe(false);
    expect((await planInTransaction(db, context({ trigger: "manual" }))).charge.reason).toMatch(/wallet/iu);
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

    const plan = await planInTransaction(db, context());
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

    const plan = await planInTransaction(db, context({ sharedCacheEnabled: false }));

    expect(plan.skipped, "a seeded answer must not be served to a bypassing workspace").toBe(0);
    expect(plan.live).toBe(1);
  }, 60_000);
});
