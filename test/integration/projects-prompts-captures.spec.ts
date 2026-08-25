import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// STORY-008 · DDL 2: projects, prompts, captures, partitioned facts. Same
// pattern as STORY-006/007: one shared container, hard schema reset per test.
//
// Isolated to a temp copy of just 0001+0002+0003 (not the real
// MIGRATIONS_DIR) — this file's tests assert exact table/migration-name
// results for STORY-008 alone, and must not break every time a later story
// adds another migration to the real directory. STORY-009 already hit this
// exact regression once (rollback test had to roll back 0004 before 0003 to
// keep passing); same treatment as identity-tenancy-billing.spec.ts's
// STORY-007 isolation and migrations.spec.ts's isolate0001() helper.
describe("STORY-008 · projects, prompts & captures DDL", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let seq = 0;
  let migrationsDir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    migrationsDir = await mkdtemp(path.join(tmpdir(), "nominara-story008-isolated-"));
    for (const name of [
      "0001_extensions_and_conventions",
      "0002_identity_tenancy_billing",
      "0003_projects_prompts_captures",
    ]) {
      for (const ext of ["up", "down"] as const) {
        const content = await readFile(path.join(MIGRATIONS_DIR, `${name}.${ext}.sql`), "utf8");
        await writeFile(path.join(migrationsDir, `${name}.${ext}.sql`), content);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await container.stop();
    await rm(migrationsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    // Pinned so the migration's CURRENT_DATE-based partition boundaries and
    // this suite's JS-side (UTC) computation of the same boundaries can never
    // silently diverge around a month edge because of an environment default —
    // QA coverage audit flagged this as an unstated assumption otherwise.
    // eslint-disable-next-line nominara/no-session-scoped-config -- test-fixture convenience on a direct (non-pgBouncer-pooled) testcontainers connection, not tenant-context traffic; NFR-SEC-02's leak risk doesn't apply outside transaction-mode pooling.
    await client.query("SET TIME ZONE 'UTC'");
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrateUp(client, migrationsDir);
    seq = 0;
  });

  afterEach(async () => {
    await client.end();
  });

  // ---- helpers -------------------------------------------------------

  async function createWorkspace(planKey = "free"): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, $3) RETURNING id",
      [`Workspace ${seq}`, `workspace-${seq}-${Math.random().toString(36).slice(2)}`, planKey],
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

  async function createEngine(
    key: string,
    overrides: Partial<{ captureMode: string; legalReviewRef: string | null }> = {},
  ) {
    const { captureMode = "api", legalReviewRef = null } = overrides;
    await client.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version, cache_ttl_seconds, volatility_band, min_plan_key, legal_review_ref)
       VALUES ($1, $1, 'vendor', $2, 'v1', 3600, 'medium', 'free', $3)`,
      [key, captureMode, legalReviewRef],
    );
  }

  async function createTrackedPrompt(
    workspaceId: string,
    projectId: string,
    overrides: Partial<{ text: string; deletedAt: string | null }> = {},
  ): Promise<string> {
    seq += 1;
    const { text = `prompt text ${seq}`, deletedAt = null } = overrides;
    const textHash = createHash("sha256").update(text).digest();
    const result = await client.query<{ id: string }>(
      `INSERT INTO tracked_prompts
         (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, deleted_at)
       VALUES ($1, $2, $3, $4, 'recommendation', 'awareness', $5)
       RETURNING id`,
      [workspaceId, projectId, text, textHash, deletedAt],
    );
    return result.rows[0]!.id;
  }

  async function createCaptureRun(workspaceId: string, projectId: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO capture_runs (workspace_id, project_id, trigger, engine_keys)
       VALUES ($1, $2, 'manual', ARRAY['chatgpt'])
       RETURNING id`,
      [workspaceId, projectId],
    );
    return result.rows[0]!.id;
  }

  function halfvecLiteral(seed: number): string {
    // A cheap, deterministic 1536-dim vector — exact values don't matter for
    // structural tests, only that it's valid input and roughly distinguishable.
    const values = Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) * 0.01);
    return `[${values.join(",")}]`;
  }

  async function insertAnswerCapture(
    workspaceId: string,
    projectId: string,
    runId: string,
    promptId: string,
    overrides: Partial<{ engineKey: string; sampleIndex: number; capturedAt: string }> = {},
  ): Promise<string> {
    // STORY-024 T12 — `seq` offsets the timestamp, and that is load-bearing.
    // ux_answer_capture is UNIQUE (run_id, prompt_id, engine_key,
    // sample_index, captured_at), and this default was millisecond-precision
    // `now()`: two fixture captures created for the same run/prompt/engine
    // inside one millisecond produced IDENTICAL key tuples and the second
    // insert died on the constraint. It surfaced as a duplicate-key error in
    // an unrelated displacement_events test further down the file, and only
    // on a fast enough run — the file passes in isolation and failed
    // reliably once the suite ahead of it grew.
    //
    // The constraint is correct and untouched; the FIXTURE was generating
    // colliding data by accident. `seq` already existed for contentHash and
    // is simply reused, so every capture now has a distinct captured_at.
    // Offset forward, never back, so the row cannot fall out of the current
    // month's partition at a month boundary.
    seq += 1;
    const { engineKey = "chatgpt", sampleIndex = 0, capturedAt = new Date(Date.now() + seq).toISOString() } = overrides;
    const contentHash = createHash("sha256").update(`content-${seq}`).digest();
    const result = await client.query<{ id: string }>(
      `INSERT INTO answer_captures
         (workspace_id, project_id, run_id, prompt_id, engine_key, sample_index, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'api', 'v1', 'v1', $8)
       RETURNING id`,
      [workspaceId, projectId, runId, promptId, engineKey, sampleIndex, capturedAt, contentHash],
    );
    return result.rows[0]!.id;
  }

  function currentAndNextMonthPartitions(table: string): { current: string; next: string } {
    const now = new Date();
    const fmt = (d: Date) => `${table}_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const nextMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { current: fmt(now), next: fmt(nextMonthDate) };
  }

  // ---- sanity: every table from both schema pages exists -------------

  it("every table from projects-and-prompts.md and captures-and-facts.md exists", async () => {
    const expected = [
      "engines",
      "engine_health",
      "projects",
      "project_engines",
      "competitors",
      "domain_verifications",
      "tracked_prompts",
      "prompt_stability",
      "topic_clusters",
      "capture_runs",
      "answer_captures",
      "mention_facts",
      "citation_facts",
      "displacement_events",
    ];
    const result = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    const actual = result.rows.map((r) => r.table_name);
    for (const table of expected) {
      expect(actual, `missing table: ${table}`).toContain(table);
    }
  });

  // ---- scenario 1 / Precondition 1 --------------------------------------

  it("scenario 1 / precondition 1 — an untracked mention with a null entity identifier is permitted", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const promptId = await createTrackedPrompt(workspaceId, projectId);
    const runId = await createCaptureRun(workspaceId, projectId);
    const resultId = await insertAnswerCapture(workspaceId, projectId, runId, promptId);

    await expect(
      client.query(
        `INSERT INTO mention_facts
           (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at,
            entity_type, entity_id, entity_label, matched_alias,
            occurrence_index, char_start, char_end, first_token_index, prominence,
            sentiment_label, sentiment_score, sentiment_confidence, sentiment_method)
         VALUES ($1, $2, $3, $4, 'chatgpt', now(),
                 'other', NULL, 'Some Untracked Brand', 'Some Untracked Brand',
                 0, 10, 30, 5, 0.5,
                 'neutral', 0, 0.9, 'lexicon')`,
        [workspaceId, projectId, resultId, promptId],
      ),
    ).resolves.toBeDefined();
  });

  // ---- Precondition 2 ----------------------------------------------------

  it("precondition 2 — citation_facts stores position weight, raw+normalized URL, url hash, and text fragment", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const promptId = await createTrackedPrompt(workspaceId, projectId);
    const runId = await createCaptureRun(workspaceId, projectId);
    const resultId = await insertAnswerCapture(workspaceId, projectId, runId, promptId);
    const urlHash = createHash("sha256").update("https://example.com/page").digest();

    await client.query(
      `INSERT INTO citation_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at,
          slot_index, raw_url, normalized_url, url_hash, domain, position_weight, text_fragment)
       VALUES ($1, $2, $3, $4, 'chatgpt', now(),
               1, 'https://example.com/page?utm=x', 'https://example.com/page', $5, 'example.com', 1.0,
               '#:~:text=exact%20passage')`,
      [workspaceId, projectId, resultId, promptId, urlHash],
    );

    const row = await client.query(
      "SELECT raw_url, normalized_url, url_hash, position_weight, text_fragment FROM citation_facts WHERE result_id = $1",
      [resultId],
    );
    expect(row.rows[0]).toMatchObject({
      raw_url: "https://example.com/page?utm=x",
      normalized_url: "https://example.com/page",
      position_weight: 1,
      text_fragment: "#:~:text=exact%20passage",
    });
    expect(Buffer.from(row.rows[0].url_hash)).toEqual(urlHash);
  });

  // ---- Precondition 3 ----------------------------------------------------

  it("precondition 3 — rendering columns (form, attributes, score) exist on mention_facts from this migration", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const promptId = await createTrackedPrompt(workspaceId, projectId);
    const runId = await createCaptureRun(workspaceId, projectId);
    const resultId = await insertAnswerCapture(workspaceId, projectId, runId, promptId);

    await client.query(
      `INSERT INTO mention_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at,
          entity_type, entity_label, matched_alias,
          occurrence_index, char_start, char_end, first_token_index, prominence,
          sentiment_label, sentiment_score, sentiment_confidence, sentiment_method,
          render_form, render_attrs, render_score)
       VALUES ($1, $2, $3, $4, 'chatgpt', now(),
               'brand', 'Our Brand', 'Our Brand',
               0, 0, 10, 0, 0.9,
               'positive', 0.8, 0.9, 'lexicon',
               'featured', ARRAY['bolded', 'linked'], 0.95)`,
      [workspaceId, projectId, resultId, promptId],
    );

    const row = await client.query(
      "SELECT render_form, render_attrs, render_score FROM mention_facts WHERE result_id = $1",
      [resultId],
    );
    expect(row.rows[0]).toMatchObject({ render_form: "featured", render_score: 0.95 });
    expect(row.rows[0].render_attrs).toEqual(["bolded", "linked"]);
  });

  // ---- scenario 2 ------------------------------------------------------

  it("scenario 2 — a second capture with identical run, prompt, engine, sample, and timestamp is rejected", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const promptId = await createTrackedPrompt(workspaceId, projectId);
    const runId = await createCaptureRun(workspaceId, projectId);
    const capturedAt = new Date().toISOString();

    await expect(
      insertAnswerCapture(workspaceId, projectId, runId, promptId, { capturedAt }),
    ).resolves.toBeDefined();
    await expect(
      insertAnswerCapture(workspaceId, projectId, runId, promptId, { capturedAt }),
    ).rejects.toThrow(/duplicate key/i);
  });

  // ---- scenario 3 --------------------------------------------------------

  it("scenario 3 — querying facts for one month prunes the plan to that partition", async () => {
    const { current, next } = currentAndNextMonthPartitions("answer_captures");
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

    const explain = await client.query(
      `EXPLAIN SELECT * FROM answer_captures WHERE captured_at >= $1 AND captured_at < $2`,
      [monthStart, nextMonthStart],
    );
    const plan = explain.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toContain(current);
    expect(plan).not.toContain(next);
    expect(plan).not.toContain("answer_captures_default");
  });

  // ---- scenario 4 --------------------------------------------------------

  it("scenario 4 — a fact whose timestamp falls in no partition lands in the default, detected by the alerting query", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const promptId = await createTrackedPrompt(workspaceId, projectId);
    const runId = await createCaptureRun(workspaceId, projectId);

    // Ten years out — well beyond the current+next month partitions this
    // migration creates.
    const farFuture = new Date(Date.UTC(new Date().getUTCFullYear() + 10, 0, 1)).toISOString();
    const resultId = await insertAnswerCapture(workspaceId, projectId, runId, promptId, {
      capturedAt: farFuture,
    });

    const location = await client.query("SELECT tableoid::regclass::text AS partition FROM answer_captures WHERE id = $1", [
      resultId,
    ]);
    expect(location.rows[0].partition).toBe("answer_captures_default");

    // The alerting query STORY-013 runs nightly — any non-zero count here
    // means partition maintenance fell behind.
    const alert = await client.query("SELECT count(*) FROM answer_captures_default");
    expect(Number(alert.rows[0].count)).toBeGreaterThan(0);
  });

  // ---- scenario 5 / 6 -----------------------------------------------------

  it("scenario 5 — an engine with a browser capture mode and no review reference is rejected", async () => {
    await expect(createEngine("grok", { captureMode: "headless", legalReviewRef: null })).rejects.toThrow(
      /ck_engines_headless_reviewed/i,
    );
  });

  it("scenario 6 — the same engine with a review reference is permitted", async () => {
    await expect(
      createEngine("grok", { captureMode: "headless", legalReviewRef: "LEGAL-REVIEW-123" }),
    ).resolves.toBeUndefined();
  });

  // ---- scenario 7 --------------------------------------------------------

  it("scenario 7 — a nearest-neighbour query over prompt vectors uses the HNSW index", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);

    // Enough rows that a real planner would consider the index; forcing
    // enable_seqscan off proves the index is well-formed and usable
    // regardless of what a planner picks for a tiny table.
    for (let i = 0; i < 30; i++) {
      const promptId = await createTrackedPrompt(workspaceId, projectId, { text: `prompt ${i}` });
      await client.query("UPDATE tracked_prompts SET embedding = $1 WHERE id = $2", [halfvecLiteral(i), promptId]);
    }

    // Session-scoped, not LOCAL: this client isn't in an explicit transaction,
    // so SET LOCAL would silently no-op past the end of its own implicit one.
    // Fine here — this is a dedicated test connection, not app runtime code.
    // eslint-disable-next-line nominara/no-session-scoped-config -- test-fixture convenience on a dedicated test connection to force an index scan for verification, not tenant-context traffic; SET LOCAL would silently no-op outside an explicit transaction here.
    await client.query("SET enable_seqscan = off");
    const explain = await client.query(
      `EXPLAIN SELECT id FROM tracked_prompts ORDER BY embedding <=> $1 LIMIT 5`,
      [halfvecLiteral(0)],
    );
    const plan = explain.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/Index Scan.*ix_prompts_embedding/is);
  });

  // ---- scenario 8 / 9 -----------------------------------------------------

  it("scenario 8 — two prompts with the same normalised text in one project: the second is rejected", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    await createTrackedPrompt(workspaceId, projectId, { text: "same prompt text" });

    await expect(createTrackedPrompt(workspaceId, projectId, { text: "same prompt text" })).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it("scenario 9 — soft-deleting a prompt then inserting the same text is permitted", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const promptId = await createTrackedPrompt(workspaceId, projectId, { text: "same prompt text" });

    await client.query("UPDATE tracked_prompts SET deleted_at = now() WHERE id = $1", [promptId]);

    await expect(createTrackedPrompt(workspaceId, projectId, { text: "same prompt text" })).resolves.toBeDefined();
  });

  // ---- ux_projects_ws_slug ------------------------------------------------
  // QA coverage audit: projects itself is exercised constantly via the
  // createProject helper, but its own uniqueness index (and soft-delete
  // exclusion, mirroring the prompt pattern above) had no test.

  it("ux_projects_ws_slug — one slug per workspace, but a soft-deleted project frees it", async () => {
    const workspaceId = await createWorkspace();
    const insertProject = (slug: string) =>
      client.query("INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1, 'P', $2, 'https://example.com', 'example.com')", [
        workspaceId,
        slug,
      ]);

    await expect(insertProject("acme")).resolves.toBeDefined();
    await expect(insertProject("acme")).rejects.toThrow(/duplicate key/i);

    await client.query("UPDATE projects SET deleted_at = now() WHERE workspace_id = $1 AND slug = 'acme'", [
      workspaceId,
    ]);
    await expect(insertProject("acme")).resolves.toBeDefined();
  });

  // ---- tables the QA coverage audit found with zero row-level coverage ----
  // Each of these seven tables previously appeared only in the table-existence
  // sanity check's name list — no test ever inserted a row into any of them,
  // leaving every one of their constraints and indexes completely unverified.

  it("project_engines — weight and sample_count bounds are enforced at both edges", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    await createEngine("chatgpt");
    const insert = (weight: number, sampleCount: number) =>
      client.query(
        "INSERT INTO project_engines (workspace_id, project_id, engine_key, weight, sample_count) VALUES ($1, $2, 'chatgpt', $3, $4)",
        [workspaceId, projectId, weight, sampleCount],
      );

    await expect(insert(0, 1)).rejects.toThrow(/violates check constraint/i);
    await expect(insert(5.1, 1)).rejects.toThrow(/violates check constraint/i);
    await expect(insert(1, 0)).rejects.toThrow(/violates check constraint/i);
    await expect(insert(1, 6)).rejects.toThrow(/violates check constraint/i);

    // Boundaries permitted.
    await expect(insert(5, 5)).resolves.toBeDefined();

    // PK (project_id, engine_key) — a second row for the same pair is rejected.
    await expect(insert(1, 1)).rejects.toThrow(/duplicate key/i);
  });

  it("competitors — ux_competitors_project_name is case-insensitive, excludes soft-deleted rows, and source is checked", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const insert = (name: string) =>
      client.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, $3)", [
        workspaceId,
        projectId,
        name,
      ]);

    await expect(insert("Acme Corp")).resolves.toBeDefined();
    await expect(insert("acme corp")).rejects.toThrow(/duplicate key/i);

    await client.query("UPDATE competitors SET deleted_at = now() WHERE project_id = $1", [projectId]);
    await expect(insert("acme corp")).resolves.toBeDefined();

    await expect(
      client.query("INSERT INTO competitors (workspace_id, project_id, name, source) VALUES ($1, $2, 'X', 'not_a_real_source')", [
        workspaceId,
        projectId,
      ]),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("domain_verifications — ux_domain_verif is unique per workspace+domain+method, and method is checked", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const insert = (method: string) =>
      client.query(
        "INSERT INTO domain_verifications (workspace_id, project_id, domain, method, nonce) VALUES ($1, $2, 'example.com', $3, 'nonce')",
        [workspaceId, projectId, method],
      );

    await expect(insert("dns_txt")).resolves.toBeDefined();
    await expect(insert("dns_txt")).rejects.toThrow(/duplicate key/i);
    // A different method for the same domain is a different row.
    await expect(insert("meta_tag")).resolves.toBeDefined();
    await expect(insert("not_a_real_method")).rejects.toThrow(/violates check constraint/i);
  });

  it("prompt_stability — PK (prompt_id, engine_key, window_start) rejects a duplicate", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const promptId = await createTrackedPrompt(workspaceId, projectId);
    await createEngine("chatgpt");
    const insert = () =>
      client.query(
        `INSERT INTO prompt_stability
           (workspace_id, prompt_id, engine_key, window_start, sample_count, presence_rate, sov_median, sov_iqr, entity_set_jsd)
         VALUES ($1, $2, 'chatgpt', CURRENT_DATE, 5, 0.8, 10, 2, 0.1)`,
        [workspaceId, promptId],
      );

    await expect(insert()).resolves.toBeDefined();
    await expect(insert()).rejects.toThrow(/duplicate key/i);
  });

  it("topic_clusters — ux_topic_clusters is case-insensitive per project, and the HNSW centroid index is used", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const insertCluster = (label: string) =>
      client.query("INSERT INTO topic_clusters (workspace_id, project_id, label) VALUES ($1, $2, $3)", [
        workspaceId,
        projectId,
        label,
      ]);

    await expect(insertCluster("Enterprise Scale")).resolves.toBeDefined();
    await expect(insertCluster("enterprise scale")).rejects.toThrow(/duplicate key/i);

    for (let i = 0; i < 30; i++) {
      await client.query(
        "INSERT INTO topic_clusters (workspace_id, project_id, label, centroid) VALUES ($1, $2, $3, $4)",
        [workspaceId, projectId, `cluster ${i}`, halfvecLiteral(i)],
      );
    }
    // eslint-disable-next-line nominara/no-session-scoped-config -- test-fixture convenience on a dedicated test connection to force an index scan for verification, not tenant-context traffic; SET LOCAL would silently no-op outside an explicit transaction here.
    await client.query("SET enable_seqscan = off");
    const explain = await client.query("EXPLAIN SELECT id FROM topic_clusters ORDER BY centroid <=> $1 LIMIT 5", [
      halfvecLiteral(0),
    ]);
    const plan = explain.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/Index Scan.*ix_topic_clusters_hnsw/is);
  });

  it("displacement_events — ux_displacement_cell rejects a re-detected duplicate, and kind is checked", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const promptId = await createTrackedPrompt(workspaceId, projectId);
    const runId = await createCaptureRun(workspaceId, projectId);
    const before = await insertAnswerCapture(workspaceId, projectId, runId, promptId);
    const after = await insertAnswerCapture(workspaceId, projectId, runId, promptId);
    const insert = (kind: string) =>
      client.query(
        `INSERT INTO displacement_events
           (workspace_id, project_id, prompt_id, engine_key, kind, before_result_id, after_result_id, displaced_by)
         VALUES ($1, $2, $3, 'chatgpt', $4, $5, $6, '[]'::jsonb)`,
        [workspaceId, projectId, promptId, kind, before, after],
      );

    await expect(insert("presence_lost")).resolves.toBeDefined();
    await expect(insert("presence_lost")).rejects.toThrow(/duplicate key/i);
    await expect(insert("not_a_real_kind")).rejects.toThrow(/violates check constraint/i);
  });

  it("engine_health — PK (engine_key, bucket_start) rejects a duplicate, and circuit_state is checked", async () => {
    await createEngine("chatgpt");
    const insert = (circuitState: string) =>
      client.query("INSERT INTO engine_health (engine_key, bucket_start, circuit_state) VALUES ('chatgpt', $1, $2)", [
        "2026-01-01T00:00:00Z",
        circuitState,
      ]);

    await expect(insert("closed")).resolves.toBeDefined();
    await expect(insert("open")).rejects.toThrow(/duplicate key/i);
    await expect(
      client.query("INSERT INTO engine_health (engine_key, bucket_start, circuit_state) VALUES ('chatgpt', '2026-02-01', 'not_a_real_state')"),
    ).rejects.toThrow(/violates check constraint/i);
  });

  // ---- ix_prompts_text_trgm ------------------------------------------------
  // Acceptance criteria names this index explicitly; scenario 7 already
  // proves the embedding HNSW index is used, this proves the trigram index
  // on prompt text actually exists (existence, per the AC's own wording,
  // rather than a forced-usage EXPLAIN like the vector indexes get).

  it("ix_prompts_text_trgm exists on tracked_prompts.text", async () => {
    const result = await client.query(
      "SELECT 1 FROM pg_indexes WHERE tablename = 'tracked_prompts' AND indexname = 'ix_prompts_text_trgm'",
    );
    expect(result.rowCount).toBe(1);
  });

  // ---- scenario 10 --------------------------------------------------------

  it("scenario 10 — rolling the migration back is clean, partitions dropped with their parents", async () => {
    const rolledBack = await rollbackLast(client, migrationsDir);
    expect(rolledBack).toBe("0003_projects_prompts_captures");

    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const gone of ["projects", "engines", "answer_captures", "answer_captures_default", "mention_facts", "citation_facts"]) {
      expect(names, gone).not.toContain(gone);
    }

    // STORY-007's tables survive this rollback untouched.
    expect(names).toContain("workspaces");
    expect(names).toContain("credit_ledger");
  });
});
