import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ConflictError, PreconditionUnmetError } from "../../src/api/errors/domain-errors.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { planFreeRetry } from "../../src/lib/capture/free-retry.js";
import { loadManualRunProject } from "../../src/lib/capture/manual-run.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-195 AC4 — the free retry of an all-degraded FIRST run. Real Postgres: the once-only limit is a partial unique index, so a
// mocked client could prove nothing about the race. Dangerous-area disclosure: this decides when a run may be started WITHOUT a charge.

const SEEDED_ENGINE_KEY = "perplexity";
const NOW = new Date(Date.UTC(2026, 10, 10, 12, 0, 0));

describe("STORY-195 · the free retry of an all-degraded first run", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;
  const cache = new InMemoryCacheAdapter();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE answer_captures, tracked_prompts, project_engines, capture_runs, credit_ledger, projects, usage_counters, workspaces, engines CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version, cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ($1, $1, 'v', 'api', '1.0.0', 86400, 'medium', 'free', 'active')`,
      [SEEDED_ENGINE_KEY],
    );
    await seedProject(projectId);
  });

  async function seedProject(id: string): Promise<void> {
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, priority_prompt_limit)
       VALUES ($1, $2, 'P', $3, 'https://e.test', 'e.test', 10)`,
      [id, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query("INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count) VALUES ($1, $2, $3, true, 1)", [workspaceId, id, SEEDED_ENGINE_KEY]);
    const text = `best crm ${id}`;
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', false, 'active')`,
      [randomUUID(), workspaceId, id, text, Buffer.from(text, "utf8")],
    );
  }

  /** A prior run, inserted directly with the given status and an explicit age (aged against the real clock: the retry row takes now()). */
  async function seedRun(status: string, minutesAgo: number, forProject = projectId, trigger = "manual"): Promise<string> {
    const id = uuidV7();
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells, failed_cells, status, created_at)
       VALUES ($1, $2, $3, $4, ARRAY[$5]::text[], 2, 2, $6, $7)`,
      [id, workspaceId, forProject, trigger, SEEDED_ENGINE_KEY, status, new Date(Date.now() - minutesAgo * 60_000)],
    );
    return id;
  }

  async function retry(client: Client | Pool = pool, forProject = projectId): Promise<{ runId: string; retryOf: string }> {
    const runId = uuidV7();
    const conn = await (client as Pool).connect();
    try {
      const out = await withTenantContext(conn, { workspaceId, actorId: randomUUID() }, async (tx) => {
        const project = await loadManualRunProject(tx, forProject);
        return planFreeRetry(tx, cache, project, { runId, triggeredBy: null, now: NOW, captureReadyEngineKeys: [SEEDED_ENGINE_KEY] });
      });
      return { runId, retryOf: out.retryOf };
    } finally {
      conn.release();
    }
  }

  async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConflictError);
    return (error as { details: { reason: string } }).details.reason;
  }

  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);

  it("STORY-195-AC4 a failed first run is retried: a linked, uncharged run with its cells planned", async () => {
    const first = await seedRun("failed", 30);
    const { runId, retryOf } = await retry();
    expect(retryOf).toBe(first);
    const row = (await db.query<{ retry_of: string; trigger: string; status: string; planned_cells: number; project_id: string }>("SELECT retry_of, trigger, status, planned_cells, project_id FROM capture_runs WHERE id = $1", [runId])).rows[0]!;
    expect(row).toMatchObject({ retry_of: first, trigger: "scheduled", status: "queued", project_id: projectId });
    expect(row.planned_cells).toBeGreaterThan(0);
  });

  it("STORY-195-AC4 a free retry charges nothing: no ledger row of any kind", async () => {
    await seedRun("failed", 30);
    await retry();
    expect(await count("SELECT count(*)::text AS n FROM credit_ledger WHERE workspace_id = $1", [workspaceId])).toBe(0);
  });

  it("STORY-195-AC4 the retry cannot be repeated: a second attempt is retry_already_used and adds no run", async () => {
    await seedRun("failed", 30);
    await retry();
    expect(await reasonOf(retry())).toBe("retry_already_used");
    expect(await count("SELECT count(*)::text AS n FROM capture_runs WHERE project_id = $1 AND retry_of IS NOT NULL", [projectId])).toBe(1);
  });

  it("STORY-195-AC4 even a retry that itself failed is not offered again", async () => {
    const first = await seedRun("failed", 30);
    const { runId } = await retry();
    await db.query("UPDATE capture_runs SET status = 'failed' WHERE id = $1", [runId]);
    expect(await reasonOf(retry())).toBe("retry_already_used");
    expect(first).toBeTruthy();
  });

  // Owner decision 96(b): the free retry covers a first run that "failed completely" - every engine degraded. `status = 'failed'` alone is
  // not that: the stale-run reaper and a failed dispatch also write it. The evidence is `error_summary.reason` (those two write one; the
  // cell path leaves it NULL) and the cell outcomes: failed or blocked `answer_captures` rows, or `failed_cells` (cells that died without a row).
  async function seedCell(runId: string, status: string, errorCode: string | null, sampleIndex: number): Promise<void> {
    const promptId = (await db.query<{ id: string }>("SELECT id FROM tracked_prompts WHERE project_id = $1 LIMIT 1", [projectId])).rows[0]!.id;
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version, content_hash, flags, cache_layer, status, sample_index, error_code)
       VALUES ($1,$2,$3,$4,$5,$6,now(),'api','1.0.0','n1',sha256($7::bytea),'{}','live',$8,$9,$10)`,
      [randomUUID(), workspaceId, projectId, runId, promptId, SEEDED_ENGINE_KEY, Buffer.from(randomUUID()), status, sampleIndex, errorCode],
    );
  }
  const noRetryRuns = async (): Promise<number> => count("SELECT count(*)::text AS n FROM capture_runs WHERE retry_of IS NOT NULL");

  it.each(["stale_queued", "dispatch_failed"])("STORY-195-AC4 a first run failed by %s (not by engines degrading) is refused failure_not_degradation and adds no run", async (why) => {
    const first = await seedRun("failed", 30, projectId, "scheduled");
    await db.query("UPDATE capture_runs SET failed_cells = 0, error_summary = $2::jsonb WHERE id = $1", [first, JSON.stringify({ reason: why })]);
    expect(await reasonOf(retry())).toBe("failure_not_degradation");
    expect(await noRetryRuns()).toBe(0);
  });

  it("STORY-195-AC4 a failed first run with no cell outcome at all is not shown to be all-degraded: failure_not_degradation", async () => {
    const first = await seedRun("failed", 30);
    await db.query("UPDATE capture_runs SET failed_cells = 0 WHERE id = $1", [first]);
    expect(await reasonOf(retry())).toBe("failure_not_degradation");
    expect(await noRetryRuns()).toBe(0);
  });

  it("STORY-195-AC4 a first run whose every cell was blocked engine_degraded or failed is retried", async () => {
    const first = await seedRun("failed", 30);
    await db.query("UPDATE capture_runs SET failed_cells = 0 WHERE id = $1", [first]);
    await seedCell(first, "blocked", "engine_degraded", 0);
    await seedCell(first, "failed", "upstream_5xx", 1);
    expect((await retry()).retryOf).toBe(first);
  });

  it("STORY-195-AC4 a failed run that nonetheless holds a delivered cell is not all-degraded: failure_not_degradation", async () => {
    const first = await seedRun("failed", 30);
    await seedCell(first, "failed", "timeout", 0);
    await seedCell(first, "captured", null, 1);
    expect(await reasonOf(retry())).toBe("failure_not_degradation");
    expect(await noRetryRuns()).toBe(0);
  });

  it("STORY-195-AC4 two concurrent retries start exactly one run", async () => {
    await seedRun("failed", 30);
    const settled = await Promise.allSettled([retry(), retry(), retry(), retry()]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    for (const s of settled) if (s.status === "rejected") expect((s.reason as { details: { reason: string } }).details.reason).toBe("retry_already_used");
    expect(await count("SELECT count(*)::text AS n FROM capture_runs WHERE project_id = $1 AND retry_of IS NOT NULL", [projectId])).toBe(1);
  });

  it.each(["completed", "partial", "canceled"])("STORY-195-AC4 a %s first run is not all-degraded: refused not_all_degraded", async (status) => {
    await seedRun(status, 30);
    expect(await reasonOf(retry())).toBe("not_all_degraded");
  });

  it.each(["queued", "running"])("STORY-195-AC4 a first run still %s is refused run_in_progress", async (status) => {
    await seedRun(status, 30);
    expect(await reasonOf(retry())).toBe("run_in_progress");
  });

  it("STORY-195-AC4 a project with no run has nothing to retry: no_first_run", async () => {
    expect(await reasonOf(retry())).toBe("no_first_run");
  });

  it("STORY-195-AC4 only the FIRST run is retried: a later run supersedes it: run_since_first_run", async () => {
    await seedRun("failed", 60);
    await seedRun("completed", 10);
    expect(await reasonOf(retry())).toBe("run_since_first_run");
  });

  it("STORY-195-AC4 a failed later run after a completed first run is not retryable", async () => {
    await seedRun("completed", 60);
    await seedRun("failed", 10);
    expect(await reasonOf(retry())).toBe("not_all_degraded");
  });

  it("STORY-195-AC4 another project's failed first run is not retried through this project", async () => {
    const other = randomUUID();
    await seedProject(other);
    await seedRun("failed", 30, other);
    expect(await reasonOf(retry(pool, projectId))).toBe("no_first_run");
    expect(await count("SELECT count(*)::text AS n FROM capture_runs WHERE retry_of IS NOT NULL")).toBe(0);
  });

  it("STORY-195-AC4 a retry with nothing capturable is refused precondition_unmet and leaves no run (nothing was charged either way)", async () => {
    await seedRun("failed", 30);
    const runId = uuidV7();
    const conn = await pool.connect();
    try {
      const failure = withTenantContext(conn, { workspaceId, actorId: randomUUID() }, async (tx) => {
        const project = await loadManualRunProject(tx, projectId);
        return planFreeRetry(tx, cache, project, { runId, triggeredBy: null, now: NOW, captureReadyEngineKeys: [] });
      });
      await expect(failure).rejects.toBeInstanceOf(PreconditionUnmetError);
    } finally {
      conn.release();
    }
    expect(await count("SELECT count(*)::text AS n FROM capture_runs WHERE retry_of IS NOT NULL")).toBe(0);
  });
});
