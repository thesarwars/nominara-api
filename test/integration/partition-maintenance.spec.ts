import { createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import {
  acquireAdvisoryLock,
  analyzeActivePartitions,
  catchUpDefaultPartition,
  checkAndRebuildVectorIndexes,
  computeRecallAtK,
  detachAndDropPartitions,
  detectDefaultPartitionRows,
  ensureAllPartitions,
  ensurePartitionsForTable,
  listPartitions,
  MAINTENANCE_LOCK_KEY,
  releaseAdvisoryLock,
  resolveDetachDropCutoffDays,
  runMonthlyMaintenance,
} from "../../src/workers/rollup/maintenance.js";
import { runCatchUp } from "../../src/workers/rollup/catch-up-default-partition.js";
import { VECTOR_RECALL_THRESHOLD } from "../../src/db/conventions.js";

// STORY-013 · partition & vacuum maintenance — Test Scenarios 1-7 + widen
// pass. One shared container, full migration chain applied ONCE (mirrors
// test/integration/rls-check.spec.ts's pattern), distinct/far month ranges
// per test so schema-level partition mutations never collide across tests.
//
// Runtime-role note (qa-reviewer blocking #4): every function this file
// tests (ensurePartitionsForTable,
// detachAndDropPartitions, checkAndRebuildVectorIndexes,
// analyzeActivePartitions, catchUpDefaultPartition, ...) issues DDL —
// CREATE TABLE ... PARTITION OF, ALTER TABLE ... SET TABLESPACE/storage
// parameters, DROP TABLE, ALTER INDEX, REINDEX CONCURRENTLY — which
// requires TABLE OWNERSHIP no runtime role (`nominara_app`/`nominara_worker`
// included) ever holds; this is a genuinely different, DDL-ownership-driven
// privilege requirement from the RLS-filtering one retention-cascade.spec.ts
// fixes for its own functions. Staying on the superuser/table-owner-class
// `client` here is correct, not the "vacuous superuser pass" this story's
// review flagged in test/integration/retention-cascade.spec.ts — none of
// these functions run under a tenant context or claim to be
// `nominara_worker`-safe in the first place.

describe("STORY-013 · partition & vacuum maintenance", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let seq = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client, MIGRATIONS_DIR);
  }, 180_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  async function createWorkspace(planKey = "free"): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, $3) RETURNING id",
      [`Workspace ${seq}`, `ws-${seq}-${Math.random().toString(36).slice(2)}`, planKey],
    );
    return result.rows[0]!.id;
  }

  async function createProject(workspaceId: string): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      "INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [workspaceId, `Project ${seq}`, `project-${seq}-${Math.random().toString(36).slice(2)}`, "https://example.com", "example.com"],
    );
    return result.rows[0]!.id;
  }

  async function insertCapture(workspaceId: string, projectId: string, capturedAt: Date): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      `INSERT INTO answer_captures
         (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash)
       VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), 'chatgpt', $3, 'api', 'v1', 'v1', decode('00', 'hex'))
       RETURNING id`,
      [workspaceId, projectId, capturedAt.toISOString()],
    );
    return result.rows[0]!.id;
  }

  function halfvecLiteral(seed: number): string {
    const values = Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) * 0.01);
    return `[${values.join(",")}]`;
  }

  // T7 fix (qa-reviewer blocking #5): a genuinely spread-out embedding, not
  // the tightly-clustered `halfvecLiteral` above — needed so a real HNSW ANN
  // search at a deliberately restrictive `hnsw.ef_search` can actually miss
  // true nearest neighbours (a tiny, near-identical cluster is too easy for
  // even a starved search to get right, which is why the OLD T7 test could
  // only prove the rebuild mechanism against an artificial threshold, never
  // real degradation at the production one).
  function spreadEmbeddingLiteral(seed: number): string {
    let state = (seed >>> 0) || 1;
    const values = Array.from({ length: 1536 }, () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return (state / 0xffffffff) * 2 - 1;
    });
    return `[${values.join(",")}]`;
  }

  async function insertTrackedPromptsBatch(workspaceId: string, projectId: string, count: number, batchSize = 50): Promise<void> {
    for (let offset = 0; offset < count; offset += batchSize) {
      const rows = Math.min(batchSize, count - offset);
      const valueGroups: string[] = [];
      const params: unknown[] = [];
      for (let i = 0; i < rows; i += 1) {
        seq += 1;
        const localSeq = seq;
        params.push(
          workspaceId,
          projectId,
          `prompt ${localSeq}`,
          createHash("sha256").update(`prompt-hash-${localSeq}`).digest(),
          spreadEmbeddingLiteral(localSeq),
        );
        const base = params.length - 5;
        valueGroups.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, 'recommendation', 'awareness', $${base + 5}::halfvec)`,
        );
      }
      await client.query(
        `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, embedding)
         VALUES ${valueGroups.join(", ")}`,
        params,
      );
    }
  }

  async function partitionsOf(table: string): Promise<string[]> {
    const rows = await listPartitions(client, table);
    return rows.map((r) => r.name).sort();
  }

  // -- Test Scenario 1 — idempotency ----------------------------------------

  it("T1 · running the job twice is idempotent — no duplicate partitions", async () => {
    const referenceDate = new Date("2031-03-10T00:00:00.000Z");
    const first = await runMonthlyMaintenance(client, { referenceDate });
    expect(first.partitionsCreated.length).toBeGreaterThan(0);

    const before = await partitionsOf("answer_captures");
    const second = await runMonthlyMaintenance(client, { referenceDate });
    expect(second.partitionsCreated).toEqual([]);
    const after = await partitionsOf("answer_captures");
    expect(after).toEqual(before);
    // No duplicate relnames anywhere.
    expect(new Set(after).size).toBe(after.length);
  });

  // -- Test Scenario 2 — concurrent lock -------------------------------------

  it("T2 · a second concurrent invocation waits on the advisory lock rather than racing", async () => {
    const clientA = new Client({ connectionString: container.getConnectionUri() });
    const clientB = new Client({ connectionString: container.getConnectionUri() });
    await clientA.connect();
    await clientB.connect();
    try {
      await acquireAdvisoryLock(clientA, MAINTENANCE_LOCK_KEY);

      const SENTINEL = Symbol("still-pending");
      const waiter = (async () => {
        await acquireAdvisoryLock(clientB, MAINTENANCE_LOCK_KEY);
        await releaseAdvisoryLock(clientB, MAINTENANCE_LOCK_KEY);
        return "acquired";
      })();

      const raced = await Promise.race([waiter, new Promise((resolve) => setTimeout(() => resolve(SENTINEL), 400))]);
      expect(raced).toBe(SENTINEL);

      await releaseAdvisoryLock(clientA, MAINTENANCE_LOCK_KEY);
      await expect(waiter).resolves.toBe("acquired");
    } finally {
      await clientA.end();
      await clientB.end();
    }
  });

  // -- Test Scenario 3 — three months ahead ----------------------------------

  it("T3 · three months ahead exist for all three fact tables after a run", async () => {
    const referenceDate = new Date("2032-05-01T00:00:00.000Z");
    await ensureAllPartitions(client, referenceDate);
    for (const table of ["answer_captures", "mention_facts", "citation_facts"] as const) {
      const names = await partitionsOf(table);
      for (const suffix of ["2032_05", "2032_06", "2032_07", "2032_08"]) {
        expect(names).toContain(`${table}_${suffix}`);
      }
    }
  });

  it("T3 · every newly created partition carries app.apply_tenant_rls (ENABLE + FORCE + ws_isolation policy)", async () => {
    const referenceDate = new Date("2033-01-01T00:00:00.000Z");
    await ensurePartitionsForTable(client, "answer_captures", referenceDate, 0);
    const flags = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'answer_captures_2033_01'",
    );
    expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policy = await client.query(
      "SELECT 1 FROM pg_policies WHERE tablename = 'answer_captures_2033_01' AND policyname = 'ws_isolation_answer_captures_2033_01'",
    );
    expect(policy.rowCount).toBe(1);
  });

  it("T3 · a newly created partition carries the same vacuum storage parameters as its parent (verified, not assumed)", async () => {
    const referenceDate = new Date("2033-02-01T00:00:00.000Z");
    await ensurePartitionsForTable(client, "answer_captures", referenceDate, 0);
    const result = await client.query<{ reloptions: string[] | null }>(
      "SELECT reloptions FROM pg_class WHERE relname = 'answer_captures_2033_02'",
    );
    const options = result.rows[0]!.reloptions ?? [];
    expect(options).toContain("autovacuum_vacuum_scale_factor=0.02");
    expect(options).toContain("autovacuum_analyze_scale_factor=0.01");
  });

  // -- Test Scenario 4 — default-partition alert -----------------------------

  it("T4 · a row landing in the default partition is detected by the alerting query", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    // 2034 has no partition yet anywhere in this run — lands in _default.
    await insertCapture(workspaceId, projectId, new Date("2034-06-15T00:00:00.000Z"));

    const alerts = await detectDefaultPartitionRows(client);
    const answerCapturesAlert = alerts.find((a) => a.table === "answer_captures");
    expect(answerCapturesAlert).toBeDefined();
    expect(answerCapturesAlert!.rowCount).toBeGreaterThan(0);
  });

  // -- Test Scenario 5 — catch-up path ---------------------------------------

  it("T5 · the catch-up path moves default-partition rows into the correct partition", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const capturedAt = new Date("2035-09-20T00:00:00.000Z");
    const captureId = await insertCapture(workspaceId, projectId, capturedAt);

    const beforeDefault = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM answer_captures_default WHERE id = $1",
      [captureId],
    );
    expect(Number(beforeDefault.rows[0]!.count)).toBe(1);

    await catchUpDefaultPartition(client, "answer_captures");

    const afterDefault = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM answer_captures_default WHERE id = $1",
      [captureId],
    );
    expect(Number(afterDefault.rows[0]!.count)).toBe(0);

    const inCorrectPartition = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM answer_captures_2035_09 WHERE id = $1",
      [captureId],
    );
    expect(Number(inCorrectPartition.rows[0]!.count)).toBe(1);
  });

  // -- STORY-142 — the operator-only catch-up script --------------------------

  it("STORY-142 AC9 · the ops entry point moves stranded rows out of default, for the named table only", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const capturedAt = new Date("2036-03-20T00:00:00.000Z");
    const captureId = await insertCapture(workspaceId, projectId, capturedAt);

    const results = await runCatchUp(client, ["answer_captures"]);

    expect(results).toEqual([{ table: "answer_captures", partitions: expect.arrayContaining(["answer_captures_2036_03"]) }]);
    const stillInDefault = await client.query("SELECT 1 FROM answer_captures_default WHERE id = $1", [captureId]);
    expect(stillInDefault.rowCount).toBe(0);
    const inPartition = await client.query("SELECT 1 FROM answer_captures_2036_03 WHERE id = $1", [captureId]);
    expect(inPartition.rowCount).toBe(1);
  });

  it("STORY-142 AC10 · a monthly run reports no cold-tier step and does not need a cold_tier tablespace", async () => {
    const tablespace = await client.query("SELECT 1 FROM pg_tablespace WHERE spcname = 'cold_tier'");
    expect(tablespace.rowCount).toBe(0);
    const result = await runMonthlyMaintenance(client, { referenceDate: new Date("2037-06-01T00:00:00.000Z") });
    expect(Object.keys(result)).not.toContain("coldTierMoved");
  });

  // -- Test Scenario 6 — synchronized detach + drop --------------------------

  it("T6 · aging past retention drops all three tables' partitions together, never one ahead of the others", async () => {
    // A month ten years in the past is older than the maximum possible
    // per-plan raw_captures_days entitlement (1095 days, enterprise) no
    // matter which other workspaces this shared container has accumulated.
    const oldMonth = new Date("2015-03-01T00:00:00.000Z");
    for (const table of ["answer_captures", "mention_facts", "citation_facts"] as const) {
      await ensurePartitionsForTable(client, table, oldMonth, 0);
    }
    await createWorkspace("free"); // ensures at least one numeric (non-unlimited) retention entitlement exists

    const cutoffDays = await resolveDetachDropCutoffDays(client);
    expect(cutoffDays).not.toBeNull();

    const dropped = await detachAndDropPartitions(client, new Date());
    const group = dropped.find((g) => g.monthSuffix === "2015_03");
    expect(group).toBeDefined();
    expect(group!.tables).toEqual(["answer_captures", "mention_facts", "citation_facts"]);

    for (const table of ["answer_captures", "mention_facts", "citation_facts"] as const) {
      const exists = await client.query("SELECT 1 FROM pg_class WHERE relname = $1", [`${table}_2015_03`]);
      expect(exists.rowCount).toBe(0);
    }
  });

  it("T6 · a month present on only SOME of the three tables is never dropped alone", async () => {
    const oldMonth = new Date("2016-04-01T00:00:00.000Z");
    // Only answer_captures gets this month's partition — mention_facts/citation_facts do not.
    await ensurePartitionsForTable(client, "answer_captures", oldMonth, 0);

    const dropped = await detachAndDropPartitions(client, new Date());
    expect(dropped.some((g) => g.monthSuffix === "2016_04")).toBe(false);
    const stillThere = await client.query("SELECT 1 FROM pg_class WHERE relname = 'answer_captures_2016_04'");
    expect(stillThere.rowCount).toBe(1);
  });

  // -- STORY-077 slice B (EC-41) — the monthly drop honours a retention deferral ---------------

  const DAY = 86_400_000;
  const monthPartitionExists = async (table: string, suffix: string): Promise<boolean> =>
    ((await client.query("SELECT 1 FROM pg_class WHERE relname = $1", [`${table}_${suffix}`])).rowCount ?? 0) > 0;

  it("STORY-077B EC-41 · a workspace deferring a retention shortening keeps its older partitions until the purge date, then they are dropped", async () => {
    // The only workspace in the platform on a long window just moved to a short plan: the plan max would fall at once.
    const reference = new Date("2041-09-15T00:00:00.000Z");
    const month = new Date("2041-01-01T00:00:00.000Z"); // ~225 days old at `reference`: past 30 days, inside 395
    for (const table of ["answer_captures", "mention_facts", "citation_facts"] as const) {
      await ensurePartitionsForTable(client, table, month, 0);
    }
    const workspaceId = await createWorkspace("free");
    await client.query(
      "UPDATE workspaces SET retention_purge_not_before = $2, retention_deferred_raw_days = 395, retention_deferred_rollups_days = 1095 WHERE id = $1",
      [workspaceId, new Date(reference.getTime() + 5 * DAY).toISOString()],
    );
    try {
      expect(await resolveDetachDropCutoffDays(client, reference)).toBe(395);
      const during = await detachAndDropPartitions(client, reference);
      expect(during.some((g) => g.monthSuffix === "2041_01")).toBe(false);
      expect(await monthPartitionExists("answer_captures", "2041_01")).toBe(true);

      const after = await detachAndDropPartitions(client, new Date(reference.getTime() + 6 * DAY));
      expect(after.some((g) => g.monthSuffix === "2041_01")).toBe(true);
      expect(await monthPartitionExists("answer_captures", "2041_01")).toBe(false);
    } finally {
      await client.query("UPDATE workspaces SET deleted_at = now() WHERE id = $1", [workspaceId]);
    }
  });

  it("STORY-077B EC-41 · a deferral that kept no finite window (NULL) means never drop while it runs", async () => {
    const reference = new Date("2042-09-15T00:00:00.000Z");
    const month = new Date("2042-01-01T00:00:00.000Z");
    for (const table of ["answer_captures", "mention_facts", "citation_facts"] as const) {
      await ensurePartitionsForTable(client, table, month, 0);
    }
    const workspaceId = await createWorkspace("free");
    await client.query("UPDATE workspaces SET retention_purge_not_before = $2 WHERE id = $1", [workspaceId, new Date(reference.getTime() + 5 * DAY).toISOString()]);
    try {
      expect(await resolveDetachDropCutoffDays(client, reference)).toBeNull();
      expect(await detachAndDropPartitions(client, reference)).toEqual([]);
      expect(await monthPartitionExists("answer_captures", "2042_01")).toBe(true);
      expect(await resolveDetachDropCutoffDays(client, new Date(reference.getTime() + 6 * DAY))).toBe(30);
    } finally {
      await client.query("UPDATE workspaces SET deleted_at = now() WHERE id = $1", [workspaceId]);
    }
  });

  // -- Test Scenario 7 — vector recall + concurrent rebuild ------------------

  it("T7 mechanism-only · the rebuild-triggering wiring fires when recall < threshold, using an artificially high threshold to isolate it from real recall degradation (see the REAL-threshold test below for the actual degradation condition)", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    for (let i = 0; i < 12; i += 1) {
      seq += 1;
      await client.query(
        `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, embedding)
         VALUES ($1, $2, $3, $4, 'recommendation', 'awareness', $5::halfvec)`,
        [workspaceId, projectId, `prompt ${seq}`, createHash("sha256").update(`prompt-hash-${seq}`).digest(), halfvecLiteral(seq)],
      );
    }

    const recall = await computeRecallAtK(client, "tracked_prompts", "embedding");
    expect(recall).not.toBeNull();
    expect(recall!).toBeGreaterThanOrEqual(0);
    expect(recall!).toBeLessThanOrEqual(1);

    const results = await checkAndRebuildVectorIndexes(client, { threshold: 1.1, efConstruction: 200 });
    const promptResult = results.find((r) => r.table === "tracked_prompts");
    expect(promptResult).toBeDefined();
    expect(promptResult!.rebuildTriggered).toBe(true);

    const indexOptions = await client.query<{ reloptions: string[] | null }>(
      "SELECT reloptions FROM pg_class WHERE relname = 'ix_prompts_embedding'",
    );
    expect(indexOptions.rows[0]!.reloptions ?? []).toContain("ef_construction=200");
  });

  it("T7 · degraded recall against the REAL production threshold (0.98) triggers a rebuild — forced via hnsw.ef_search against the real index, not an inflated stand-in threshold", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    await insertTrackedPromptsBatch(workspaceId, projectId, 400);

    // A dedicated connection so the deliberately-starved `hnsw.ef_search`
    // GUC never leaks into any other test sharing this file's `client`.
    const degradedClient = new Client({ connectionString: container.getConnectionUri() });
    await degradedClient.connect();
    try {
      // hnsw.ef_search=1 is a real, standard pgvector recall/speed trade-off
      // knob (minimum legal value) — this forces the ANN search to examine
      // only one candidate per layer against the REAL HNSW index built by
      // migration 0003 (m=16, ef_construction=64), genuinely degrading
      // recall rather than faking the measurement. Session-scoped by
      // necessity: computeRecallAtK issues its own internal BEGIN/COMMIT, so
      // SET LOCAL here (outside any transaction block) would no-op past this
      // one statement — this must persist for the whole dedicated connection.
      // eslint-disable-next-line nominara/no-session-scoped-config -- test-fixture convenience on a dedicated (non-pgBouncer-pooled) testcontainers connection, not tenant-context traffic; NFR-SEC-02's leak risk doesn't apply outside transaction-mode pooling.
      await degradedClient.query("SET hnsw.ef_search = 1");
      // At 412 rows the planner's own cost model prefers a plain sequential
      // scan over the HNSW index regardless of ef_search — same reason this
      // repo's OTHER vector-index tests (projects-prompts-captures.spec.ts,
      // rollups-aux-tasks-geo-tools.spec.ts) force index usage the same way.
      // Without this, ef_search=1 would never actually be exercised and
      // recall would trivially stay at 1.
      // eslint-disable-next-line nominara/no-session-scoped-config -- test-fixture convenience on a dedicated (non-pgBouncer-pooled) testcontainers connection to force an index scan for verification, not tenant-context traffic; SET LOCAL would silently no-op outside an explicit transaction here.
      await degradedClient.query("SET enable_seqscan = off");

      const degradedRecall = await computeRecallAtK(degradedClient, "tracked_prompts", "embedding");
      expect(degradedRecall).not.toBeNull();
      expect(degradedRecall!).toBeLessThan(VECTOR_RECALL_THRESHOLD);

      // No `threshold` override — this is the actual production constant.
      const results = await checkAndRebuildVectorIndexes(degradedClient, { efConstruction: 200 });
      const promptResult = results.find((r) => r.table === "tracked_prompts");
      expect(promptResult).toBeDefined();
      expect(promptResult!.recallAt10).toBeLessThan(VECTOR_RECALL_THRESHOLD);
      expect(promptResult!.rebuildTriggered).toBe(true);

      const indexOptions = await client.query<{ reloptions: string[] | null }>(
        "SELECT reloptions FROM pg_class WHERE relname = 'ix_prompts_embedding'",
      );
      expect(indexOptions.rows[0]!.reloptions ?? []).toContain("ef_construction=200");
    } finally {
      await degradedClient.end();
    }
  });

  it("T7 · recall at or above the threshold does not trigger a rebuild", async () => {
    const results = await checkAndRebuildVectorIndexes(client, { threshold: -1 });
    for (const result of results) {
      expect(result.rebuildTriggered).toBe(false);
    }
  });

  it("T7 explicitly excludes semantic_nodes (E-3 known defect — no HNSW index exists there)", async () => {
    const { HNSW_INDEXED_TABLES } = await import("../../src/db/conventions.js");
    expect(HNSW_INDEXED_TABLES.map((t) => t.table)).not.toContain("semantic_nodes");
  });

  // -- Statistics refresh -----------------------------------------------------

  it("ANALYZE runs on active (non-default, within-hot-window) partitions without error", async () => {
    const referenceDate = new Date("2038-01-01T00:00:00.000Z");
    await ensurePartitionsForTable(client, "answer_captures", referenceDate, 0);
    const analyzed = await analyzeActivePartitions(client, referenceDate);
    expect(analyzed).toContain("answer_captures_2038_01");
  });

  // -- Widen pass — zero-partitions-ever first run ---------------------------

  it("widen · a table starting with zero non-default partitions creates the full 3-months-ahead set from scratch", async () => {
    const now = new Date();
    const currentSuffix = `${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

    // Detach + drop whatever migration 0003 auto-created for the current
    // month, simulating a genuinely empty partition set for this one table.
    const existing = (await listPartitions(client, "answer_captures")).filter((p) => !p.isDefault);
    for (const partition of existing) {
      await client.query(`ALTER TABLE answer_captures DETACH PARTITION ${partition.name}`);
      await client.query(`DROP TABLE ${partition.name}`);
    }
    expect((await partitionsOf("answer_captures")).filter((n) => n !== "answer_captures_default")).toEqual([]);

    const created = await ensurePartitionsForTable(client, "answer_captures", now);
    expect(created).toHaveLength(4);
    expect(created).toContain(`answer_captures_${currentSuffix}`);
  });
});
