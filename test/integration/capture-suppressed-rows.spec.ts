import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import {
  recordRunCounts,
  recordSuppressedCells,
  type SuppressedCell,
  type SuppressedRowContext,
} from "../../src/lib/capture/record-suppressed.js";

// STORY-032 AC9 and AC12 — the rows a run writes for cells it did NOT
// capture, and the counters it records before dispatching the ones it did.
//
// §5: a suppressed cell "still produces an answer_captures row with
// cache_layer and source_result_id, so the prompt matrix is never sparse.
// They do NOT increment captured_cells."
//
// Both halves matter and they fail differently. WITHOUT the row, a cached
// cell is indistinguishable from a failed one — both absent — and the
// interface reads the gap as "this engine had nothing to say", which is a
// claim about the engine rather than about our own cost optimisation.
// WITHOUT the count discipline, suppressions inflate captured_cells, the
// suppression rate computes against a denominator that already contains
// them, and the cost lever appears to be working better than it is.
/** The project's alias set as it stands now, and as it stood when the source was parsed. */
const CURRENT_ALIASES = createHash("sha256").update("aliases-today").digest();
const STALE_ALIASES = createHash("sha256").update("aliases-yesterday").digest();

describe("STORY-032 · suppressed cells produce rows without advancing the live count", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let appDb: Client;
  let workspaceId: string;
  let projectId: string;
  let runId: string;
  let context: SuppressedRowContext;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);

    // A SECOND connection as the runtime role, which unlike the migration
    // superuser is subject to RLS. The silent-no-op defect this file now
    // guards is only reachable from a connection like this one, so testing
    // it from the superuser connection would prove nothing.
    const appPassword = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(appPassword)}`);
    appDb = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_app",
      password: appPassword,
    });
    await appDb.connect();
  }, 240_000);

  afterAll(async () => {
    await appDb.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE answer_captures, tracked_prompts, capture_runs, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    runId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, 'P', $3, 'https://e.test', 'e.test')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys)
       VALUES ($1, $2, $3, 'scheduled', ARRAY['perplexity'])`,
      [runId, workspaceId, projectId],
    );
    context = {
      workspaceId,
      projectId,
      runId,
      normalizerVersion: "v1",
      captureMode: "api",
      aliasFingerprint: CURRENT_ALIASES,
    };
  });

  async function addPrompt(text: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration')`,
      [id, workspaceId, projectId, text, Buffer.from(text, "utf8")],
    );
    return id;
  }

  /**
   * A fully SCORED source, parsed against yesterday's alias set — the exact
   * row a reuse is tempted to copy wholesale.
   */
  async function addSourceCapture(promptId: string, contentHash: Buffer): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash, status, cache_layer,
          alias_fingerprint, brand_present, sov, sentiment_label, sentiment_score,
          brand_rank_position, citation_count, owned_citation_count)
       VALUES ($1, $2, $3, $4, $5, 'perplexity', now(), 'api', '1.0.0', 'v1', $6, 'parsed', 'live',
               $7, true, 0.8, 'positive', 0.9, 2, 5, 3)`,
      [id, workspaceId, projectId, randomUUID(), promptId, contentHash, STALE_ALIASES],
    );
    return id;
  }

  it("writes one row per suppressed cell, so the matrix is never sparse", async () => {
    const promptA = await addPrompt("a");
    const promptB = await addPrompt("b");
    const cells: SuppressedCell[] = [
      {
        layer: "l1",
        promptId: promptA,
        engineKey: "perplexity",
        sampleIndex: 0,
        contentHash: Buffer.alloc(32, 7),
        adapterVersion: "1.0.0",
      },
      {
        layer: "l1",
        promptId: promptB,
        engineKey: "perplexity",
        sampleIndex: 0,
        contentHash: Buffer.alloc(32, 8),
        adapterVersion: "1.0.0",
      },
    ];

    expect(await recordSuppressedCells(db, context, cells)).toBe(2);

    const rows = await db.query<{ cache_layer: string; status: string; source_result_id: string | null }>(
      "SELECT cache_layer, status, source_result_id FROM answer_captures WHERE run_id = $1 ORDER BY prompt_id",
      [runId],
    );
    expect(rows.rowCount).toBe(2);
    for (const row of rows.rows) {
      expect(row.cache_layer, "the row must say WHY it was not captured live").toBe("l1");
      expect(row.status).toBe("skipped");
      expect(row.source_result_id, "an L1 hit reuses the shared cache, not one of our own rows").toBeNull();
    }
  }, 30_000);

  // An L2 row must point at the capture it reused, and carry that capture's
  // own content hash — copied in SQL so the two cannot disagree about what
  // was answered.
  it("an L2 row records its source and copies that source's content hash", async () => {
    const promptId = await addPrompt("reused");
    const sourceHash = Buffer.alloc(32, 3);
    const sourceId = await addSourceCapture(promptId, sourceHash);

    await recordSuppressedCells(db, context, [
      { layer: "l2", promptId, engineKey: "perplexity", sampleIndex: 0, sourceResultId: sourceId, adapterVersion: "1.0.0" },
    ]);

    const row = await db.query<{ cache_layer: string; source_result_id: string; content_hash: Buffer }>(
      "SELECT cache_layer, source_result_id, content_hash FROM answer_captures WHERE run_id = $1",
      [runId],
    );
    expect(row.rows[0]!.cache_layer).toBe("l2");
    expect(row.rows[0]!.source_result_id, "the reuse must name what it reused").toBe(sourceId);
    expect(row.rows[0]!.content_hash.equals(sourceHash), "copied from the source, never passed in").toBe(true);
  }, 30_000);

  // THE COUNT DISCIPLINE. captured_cells belongs to the workers, as real
  // captures land. Pre-seeding it with suppressions reports work that never
  // happened and makes the suppression rate compute against itself.
  it("records planned and skipped, and leaves captured_cells at zero", async () => {
    await recordRunCounts(db, runId, { planned: 10, skipped: 4 });

    const run = await db.query<{ planned_cells: number; skipped_cells: number; captured_cells: number }>(
      "SELECT planned_cells, skipped_cells, captured_cells FROM capture_runs WHERE id = $1",
      [runId],
    );
    expect(run.rows[0]).toMatchObject({ planned_cells: 10, skipped_cells: 4, captured_cells: 0 });
  }, 30_000);

  // WHAT THIS REPLACED, and why. The previous test here claimed to assert
  // AC12's ordering "as a property of the data": it recorded counts, then
  // asserted that no `cache_layer = 'live'` row existed for the run. But it
  // never created a live capture, so that count was zero no matter what —
  // the assertion held with the `recordRunCounts` call deleted outright, and
  // held equally if the counters were written AFTER dispatch. It was a check
  // that passed whether or not the thing worked.
  //
  // The ordering itself is not assertable here, and saying so is the honest
  // position: nothing in `src/` calls both `recordRunCounts` and
  // `dispatchCaptureCells`, so there is no place where the order is decided
  // and therefore nothing to get wrong yet. It becomes testable when the
  // planning orchestrator exists — see the story's "No orchestrator" note.
  //
  // What IS assertable, and what actually protects the ordering rule, is
  // that a run whose counters could not be recorded FAILS LOUDLY instead of
  // proceeding to dispatch. These are those tests.
  it("throws rather than silently recording nothing for a run that does not exist", async () => {
    const absent = randomUUID();

    // The failure this guards is not the missing run — it is the caller
    // going on to enqueue jobs against a plan that was never made durable.
    await expect(recordRunCounts(db, absent, { planned: 3, skipped: 1 })).rejects.toThrow(/updated 0/u);
  }, 30_000);

  it("throws for a run in ANOTHER workspace, which RLS makes invisible rather than forbidden", async () => {
    const otherWorkspace = randomUUID();
    const otherProject = randomUUID();
    const otherRun = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W2', $2, 'growth')", [
      otherWorkspace,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, 'P2', $3, 'https://o.test', 'o.test')`,
      [otherProject, otherWorkspace, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys)
       VALUES ($1, $2, $3, 'scheduled', ARRAY['perplexity'])`,
      [otherRun, otherWorkspace, otherProject],
    );

    // THIS IS THE SHAPE OF THE HAZARD. RLS does not reject the write — it
    // removes the row from view, so the UPDATE matches nothing and reports
    // success. A tenant-context bug would therefore present as runs that
    // quietly never record a plan, with no error anywhere to trace.
    await appDb.query("BEGIN");
    try {
      await appDb.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      await expect(recordRunCounts(appDb, otherRun, { planned: 99, skipped: 99 })).rejects.toThrow(/updated 0/u);
    } finally {
      await appDb.query("ROLLBACK");
    }

    const untouched = await db.query<{ planned_cells: number }>(
      "SELECT planned_cells FROM capture_runs WHERE id = $1",
      [otherRun],
    );
    expect(untouched.rows[0]!.planned_cells, "and the foreign run must be unchanged").toBe(0);
  }, 30_000);

  // THE POSITIVE CONTROL for the test above. Without it, a recordRunCounts
  // that threw unconditionally would satisfy both rejection tests.
  it("records normally under RLS when the context IS the run's workspace", async () => {
    await appDb.query("BEGIN");
    try {
      await appDb.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      await expect(recordRunCounts(appDb, runId, { planned: 7, skipped: 2 })).resolves.toBeUndefined();
      await appDb.query("COMMIT");
    } catch (error) {
      await appDb.query("ROLLBACK");
      throw error;
    }

    const run = await db.query<{ planned_cells: number; skipped_cells: number }>(
      "SELECT planned_cells, skipped_cells FROM capture_runs WHERE id = $1",
      [runId],
    );
    expect(run.rows[0]).toMatchObject({ planned_cells: 7, skipped_cells: 2 });
  }, 30_000);

  it("records the counts it was given, not the counts it already had", async () => {
    await recordRunCounts(db, runId, { planned: 3, skipped: 1 });
    await recordRunCounts(db, runId, { planned: 8, skipped: 5 });

    // Re-planning must overwrite. An UPDATE that only ever set a zero row
    // would pass the first-write tests above and leave a replanned run
    // reporting its first plan forever.
    const run = await db.query<{ planned_cells: number; skipped_cells: number }>(
      "SELECT planned_cells, skipped_cells FROM capture_runs WHERE id = $1",
      [runId],
    );
    expect(run.rows[0]).toMatchObject({ planned_cells: 8, skipped_cells: 5 });
  }, 30_000);

  // AC7 — "a reuse re-runs entity matching against the current alias set, so
  // an alias added yesterday is reflected in a reused cell."
  //
  // The matching itself is EPIC-05's parser. What THIS story owes is the
  // contract that makes it possible: a reused cell arrives UNSCORED and
  // stamped with the CURRENT alias set, so nothing downstream can mistake it
  // for already-matched.
  it("a reused cell arrives UNSCORED — the source's scores are never copied", async () => {
    const promptId = await addPrompt("reused");
    const sourceId = await addSourceCapture(promptId, Buffer.alloc(32, 3));

    // The source is fully scored, which is the whole temptation.
    const source = await db.query<{ brand_present: boolean; sov: number }>(
      "SELECT brand_present, sov FROM answer_captures WHERE id = $1",
      [sourceId],
    );
    expect(source.rows[0], "the fixture must actually be scored, or this test proves nothing").toMatchObject({
      brand_present: true,
    });

    await recordSuppressedCells(db, context, [
      { layer: "l2", promptId, engineKey: "perplexity", sampleIndex: 0, sourceResultId: sourceId, adapterVersion: "1.0.0" },
    ]);

    const reused = await db.query<{
      brand_present: boolean;
      sov: number | null;
      sentiment_label: string | null;
      sentiment_score: number | null;
      brand_rank_position: number | null;
      citation_count: number;
      owned_citation_count: number;
    }>(
      `SELECT brand_present, sov, sentiment_label, sentiment_score, brand_rank_position,
              citation_count, owned_citation_count
         FROM answer_captures WHERE run_id = $1`,
      [runId],
    );

    expect(
      reused.rows[0],
      "copying the source's scores would freeze yesterday's alias set into today's cell",
    ).toMatchObject({
      brand_present: false,
      sov: null,
      sentiment_label: null,
      sentiment_score: null,
      brand_rank_position: null,
      citation_count: 0,
      owned_citation_count: 0,
    });
  }, 30_000);

  // The other half: the row must carry TODAY's alias fingerprint, not the
  // one the source was matched against. A row stamped with the source's
  // would look already-matched against an alias set that has since moved,
  // and the competitor added yesterday would never appear.
  it("a reused cell carries the CURRENT alias fingerprint, not the source's", async () => {
    const promptId = await addPrompt("reused");
    const sourceId = await addSourceCapture(promptId, Buffer.alloc(32, 3));

    await recordSuppressedCells(db, context, [
      { layer: "l2", promptId, engineKey: "perplexity", sampleIndex: 0, sourceResultId: sourceId, adapterVersion: "1.0.0" },
    ]);

    const row = await db.query<{ alias_fingerprint: Buffer }>(
      "SELECT alias_fingerprint FROM answer_captures WHERE run_id = $1",
      [runId],
    );
    expect(row.rows[0]!.alias_fingerprint.equals(CURRENT_ALIASES), "today's aliases").toBe(true);
    expect(row.rows[0]!.alias_fingerprint.equals(STALE_ALIASES), "not the source's").toBe(false);
  }, 30_000);

  it("an L1 row is stamped with the current alias set too", async () => {
    const promptId = await addPrompt("cached");
    await recordSuppressedCells(db, context, [
      {
        layer: "l1",
        promptId,
        engineKey: "perplexity",
        sampleIndex: 0,
        contentHash: Buffer.alloc(32, 9),
        adapterVersion: "1.0.0",
      },
    ]);

    const row = await db.query<{ alias_fingerprint: Buffer }>(
      "SELECT alias_fingerprint FROM answer_captures WHERE run_id = $1",
      [runId],
    );
    expect(row.rows[0]!.alias_fingerprint.equals(CURRENT_ALIASES)).toBe(true);
  }, 30_000);

  it("writes nothing, and asks nothing, for an empty suppression set", async () => {
    expect(await recordSuppressedCells(db, context, [])).toBe(0);
    const rows = await db.query("SELECT 1 FROM answer_captures WHERE run_id = $1", [runId]);
    expect(rows.rowCount).toBe(0);
  }, 30_000);

  // A run with nothing cached is the normal case for a new project, and it
  // must record a real plan rather than an empty one.
  it("records a plan with zero suppressions when nothing was cached", async () => {
    await recordRunCounts(db, runId, { planned: 6, skipped: 0 });
    const run = await db.query<{ planned_cells: number; skipped_cells: number }>(
      "SELECT planned_cells, skipped_cells FROM capture_runs WHERE id = $1",
      [runId],
    );
    expect(run.rows[0]).toMatchObject({ planned_cells: 6, skipped_cells: 0 });
  }, 30_000);
});
