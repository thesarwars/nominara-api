import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import type { Cache } from "../../src/lib/cache/cache.port.js";
import { cacheKeyNamespace } from "../../src/lib/cache/key-namespace.js";
import { captureL1Key } from "../../src/lib/capture/l1-cache-key.js";
import { adapterMajorOf } from "../../src/lib/capture/l1-exact-hash.js";
import { loadManualRunProject, planManualRun } from "../../src/lib/capture/manual-run.js";
import { etaMsFrom, pctFrom, readRunProgress } from "../../src/lib/capture/run-progress.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";

// STORY-034 AC2–AC5 — the run row a manual trigger writes, and the projection
// read back off it.

const TTL_SECONDS = 86_400;
const NOW = new Date(Date.UTC(2026, 7, 20, 12, 0, 0));

describe("STORY-034 · the manual run lifecycle", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let cache: Cache;
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
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query(
      "TRUNCATE answer_captures, tracked_prompts, project_engines, capture_runs, projects, usage_counters, workspaces, engines CASCADE",
    );
    cache = new InMemoryCacheAdapter();
    workspaceId = randomUUID();
    projectId = randomUUID();
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
  });

  async function addPrompt(text: string, isPriority = false): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash,
                                    intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', $6, 'active')`,
      [id, workspaceId, projectId, text, Buffer.from(text, "utf8"), isPriority],
    );
    return id;
  }

  async function seedL1(text: string): Promise<void> {
    await cache.set(
      captureL1Key({
        env: cacheKeyNamespace(),
        engineKey: "perplexity",
        adapterMajor: adapterMajorOf("1.0.0"),
        promptText: text,
        locale: "en-US",
        personaHint: null,
        ttlSeconds: TTL_SECONDS,
        nowMs: NOW.getTime(),
      }),
      JSON.stringify({ v: 1, contentHash: "a".repeat(64), payload: { answer: "cached" }, excerpt: "cached" }),
      { ttlMs: 600_000 },
    );
  }

  /**
   * `planManualRun` REQUIRES a transaction and says so by taking a savepoint —
   * the contract `planRun` documents, and running against an autocommit client
   * is what once let a partial write go unnoticed.
   */
  async function trigger(): Promise<string> {
    const runId = uuidV7();
    const project = await loadManualRunProject(db, projectId);
    await db.query("BEGIN");
    try {
      await planManualRun(db, cache, project, { runId, triggeredBy: null, now: NOW });
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
    return runId;
  }

  it("records the run as manual over the FULL tracked set", async () => {
    // §3: "Runs the full tracked set on every enabled engine... The body
    // takes no scope or engine selection." A priority-only prompt and an
    // ordinary one are both in scope, which is what distinguishes this from
    // the scheduled priority subset.
    await addPrompt("best crm for a 50-rep sales team", true);
    await addPrompt("crm with the best hubspot migration path", false);

    const runId = await trigger();

    const row = await db.query<{ trigger: string; prompt_scope: string; planned_cells: number; engine_keys: string[] }>(
      "SELECT trigger, prompt_scope, planned_cells, engine_keys FROM capture_runs WHERE id = $1",
      [runId],
    );
    expect(row.rows[0]).toMatchObject({
      trigger: "manual",
      prompt_scope: "all",
      planned_cells: 2,
      engine_keys: ["perplexity"],
    });
  });

  it("reports the flat price with the plan, so the response need not resolve it twice", async () => {
    await addPrompt("best crm for a 50-rep sales team");
    const project = await loadManualRunProject(db, projectId);
    await db.query("BEGIN");
    const { credits, plan } = await planManualRun(db, cache, project, {
      runId: uuidV7(),
      triggeredBy: null,
      now: NOW,
    });
    await db.query("COMMIT");

    expect(credits).toBe(200);
    // The charge hook records its own inaction rather than pretending.
    expect(plan.charge).toMatchObject({ charged: false });
    expect(plan.charge.reason).toContain("wallet");
  });

  it("projects progress from the run row and the captures, not from a counter", async () => {
    await addPrompt("best crm for a 50-rep sales team");
    await addPrompt("crm with the best hubspot migration path");
    const runId = await trigger();

    const progress = await readRunProgress(db, runId, NOW);

    expect(progress).toMatchObject({
      trigger: "manual",
      status: "queued",
      planned: 2,
      captured: 0,
      skipped: 0,
      failed: 0,
      pct: 0,
    });
    // Nothing has finished, so there is no rate to extrapolate from and the
    // estimate is ABSENT rather than zero.
    expect(progress.etaMs).toBeNull();
  });

  it("counts a suppressed cell as DONE, so a fully cached run reaches 100%", async () => {
    // A cache-served cell has an `answer_captures` row at `status = 'skipped'`
    // and will never be enqueued. Leaving it out of the completion arithmetic
    // strands a run that has nothing left to do below 100% forever.
    const cached = "best crm for a 50-rep sales team";
    await addPrompt(cached);
    await seedL1(cached);

    const runId = await trigger();
    const progress = await readRunProgress(db, runId, NOW);

    expect(progress).toMatchObject({ planned: 1, skipped: 1, captured: 0, pct: 100 });
    expect(progress.cachedByLayer).toEqual({ l1: 1, l2: 0 });
  });

  it("separates a failed cell from an absent one", async () => {
    // The same honesty rule the aggregation layer applies, surfaced in the
    // projection: a cell that could not be captured is `failed`, not a
    // quietly smaller `captured`.
    const promptId = await addPrompt("best crm for a 50-rep sales team");
    const runId = await trigger();
    await db.query(
      `INSERT INTO answer_captures (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
                                    capture_mode, adapter_version, normalizer_version, content_hash,
                                    status, error_code)
       VALUES ($1, $2, $3, $4, 'perplexity', now(), 'api', '1.0.0', 'v1', sha256('x'::bytea), 'failed', 'engine_timeout')`,
      [workspaceId, projectId, runId, promptId],
    );

    const progress = await readRunProgress(db, runId, NOW);

    expect(progress).toMatchObject({ planned: 1, captured: 0, failed: 1, pct: 100 });
  });

  it("refuses to read a run that does not exist", async () => {
    await expect(readRunProgress(db, uuidV7(), NOW)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("STORY-034 · progress arithmetic", () => {
  it("reports 100 for a run with nothing planned", () => {
    // An empty project has no cells and is not 0% done — it is finished.
    expect(pctFrom(0, 0)).toBe(100);
  });

  it("never exceeds 100 or drops below 0", () => {
    expect(pctFrom(10, 20)).toBe(100);
    expect(pctFrom(10, -5)).toBe(0);
  });

  it("has NO estimate before the first cell finishes", () => {
    // §11: "an estimate is not always computable, and zero is a real estimate
    // rather than a missing one." Seeding from an average cell duration would
    // produce a confident number for a run about to sit behind a degraded
    // engine.
    expect(etaMsFrom(new Date(0), 0, 10, 60_000)).toBeNull();
  });

  it("has NO estimate once nothing is outstanding", () => {
    // A finished run's estimate to finish is absent, not zero.
    expect(etaMsFrom(new Date(0), 10, 0, 60_000)).toBeNull();
  });

  it("extrapolates from the rate cells have actually completed at", () => {
    // 4 of 10 in 60s → 6 left at 15s each → 90s.
    expect(etaMsFrom(new Date(0), 4, 6, 60_000)).toBe(90_000);
  });
});
