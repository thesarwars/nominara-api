import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  GLOBAL_TABLES,
  ORDER_COLUMN_PATTERN,
  TENANT_SCOPE_COLUMN,
  WIDE_ORDER_COLUMN_PATTERN,
} from "../../src/db/conventions.js";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// STORY-009 · DDL 3: rollups, AUX, tasks, GEO, tools, agency, audit — the
// third and final DDL migration for EPIC-01. Same container/beforeEach/
// UTC-pin/afterEach pattern as STORY-008's spec (test/integration/
// projects-prompts-captures.spec.ts).
//
// Isolated to a temp copy of just 0001+0002+0003+0004 (not the real
// MIGRATIONS_DIR) — same regression identity-tenancy-billing.spec.ts and
// projects-prompts-captures.spec.ts were already isolated against: this
// file's census/rollback assertions are about THIS migration's own chain,
// not about how many migrations happen to exist in the repo today.
describe("STORY-009 · rollups, AUX, tasks, GEO, tools & agency DDL", () => {
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

    migrationsDir = await mkdtemp(path.join(tmpdir(), "nominara-story009-isolated-"));
    for (const name of [
      "0001_extensions_and_conventions",
      "0002_identity_tenancy_billing",
      "0003_projects_prompts_captures",
      "0004_rollups_aux_tasks_geo_tools",
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

  async function createUser(): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [`user-${seq}-${Math.random().toString(36).slice(2)}@example.com`],
    );
    return result.rows[0]!.id;
  }

  async function createEngine(
    key: string,
    overrides: Partial<{ minPlanKey: string }> = {},
  ): Promise<void> {
    const { minPlanKey = "free" } = overrides;
    await client.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version, cache_ttl_seconds, volatility_band, min_plan_key)
       VALUES ($1, $1, 'vendor', 'api', 'v1', 3600, 'medium', $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, minPlanKey],
    );
  }

  function halfvecLiteral(seed: number): string {
    const values = Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) * 0.01);
    return `[${values.join(",")}]`;
  }

  async function createAuxRule(code: string): Promise<void> {
    await client.query(
      `INSERT INTO aux_rule_catalog
         (code, category, title, description, rationale, severity_default, weight, rule_version)
       VALUES ($1, 'structured_data', 'Title', 'Description', 'engines cannot show your price', 'high', 0.5, 'v1')
       ON CONFLICT (code) DO NOTHING`,
      [code],
    );
  }

  async function createTask(
    workspaceId: string,
    projectId: string,
    overrides: Partial<{ shortRef: string; dedupeFingerprint: Buffer; status: string }> = {},
  ): Promise<string> {
    seq += 1;
    const {
      shortRef = `HUB-${seq}`,
      dedupeFingerprint = createHash("sha256").update(`fp-${seq}`).digest(),
      status = "todo",
    } = overrides;
    const result = await client.query<{ id: string }>(
      `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status)
       VALUES ($1, $2, $3, 'content', $4, 'Title', 'Description', $5)
       RETURNING id`,
      [workspaceId, projectId, shortRef, dedupeFingerprint, status],
    );
    return result.rows[0]!.id;
  }

  async function createAuxAudit(workspaceId: string, projectId: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO aux_audits (workspace_id, project_id, trigger, target_urls, rule_version, tokenizer)
       VALUES ($1, $2, 'manual', ARRAY['https://example.com/'], 'v1', 'cl100k')
       RETURNING id`,
      [workspaceId, projectId],
    );
    return result.rows[0]!.id;
  }

  async function createAuxFinding(
    workspaceId: string,
    projectId: string,
    auditId: string,
    overrides: Partial<{ fingerprint: Buffer; status: string; ruleCode: string }> = {},
  ): Promise<string> {
    seq += 1;
    const { fingerprint = createHash("sha256").update(`finding-${seq}`).digest(), status = "open", ruleCode = "AUX-R-001" } =
      overrides;
    await createAuxRule(ruleCode);
    const result = await client.query<{ id: string }>(
      `INSERT INTO aux_findings
         (workspace_id, project_id, audit_id, rule_code, severity, status, fingerprint, title, evidence, rule_version)
       VALUES ($1, $2, $3, $4, 'medium', $5, $6, 'Title', '{}'::jsonb, 'v1')
       RETURNING id`,
      [workspaceId, projectId, auditId, ruleCode, status, fingerprint],
    );
    return result.rows[0]!.id;
  }

  async function createShareToken(
    workspaceId: string,
    createdBy: string,
    overrides: Partial<{ scopeProjectIds: string[] }> = {},
  ) {
    seq += 1;
    const { scopeProjectIds = [] } = overrides;
    return client.query(
      `INSERT INTO share_tokens (workspace_id, label, token_hash, token_prefix, scope_project_ids, created_by)
       VALUES ($1, 'Label', $2, 'abcdefgh', $3, $4)`,
      [workspaceId, createHash("sha256").update(`token-${seq}`).digest(), scopeProjectIds, createdBy],
    );
  }

  const DEFAULT_TOOL_RUN_COLUMNS = {
    input_hash: () => createHash("sha256").update(`input-${Math.random()}`).digest(),
    expires_at: () => new Date(Date.now() + 86_400_000).toISOString(),
  };

  async function insertToolRun(
    workspaceId: string,
    fields: Record<string, unknown>,
  ): Promise<string> {
    const columns = { input_hash: DEFAULT_TOOL_RUN_COLUMNS.input_hash(), expires_at: DEFAULT_TOOL_RUN_COLUMNS.expires_at(), ...fields };
    const keys = Object.keys(columns);
    const values = Object.values(columns);
    const placeholders = keys.map((_, i) => `$${i + 2}`).join(", ");
    const result = await client.query<{ id: string }>(
      `INSERT INTO tool_runs (workspace_id, ${keys.join(", ")}) VALUES ($1, ${placeholders}) RETURNING id`,
      [workspaceId, ...values],
    );
    return result.rows[0]!.id;
  }

  // ==== the 35 new tables from this migration, plus their FK-safe creation
  // order — used by the table-existence sanity check and the AC-5 scan.
  const NEW_TABLES = [
    "aux_rule_catalog",
    "task_generation_rules",
    "niche_reports",
    "platform_metrics",
    "source_domains",
    "project_source_index",
    "metric_daily",
    "milestones",
    "notifications",
    "aux_audits",
    "aux_findings",
    "tasks",
    "goals",
    "task_events",
    "ref_counters",
    "geo_analyses",
    "entity_nodes",
    "geo_alignments",
    "content_chunks",
    "corpus_passages",
    "semantic_nodes",
    "patches",
    "tool_runs",
    "attribution_configs",
    "attribution_daily",
    "attribution_url_rollup",
    "gsc_connections",
    "gsc_daily",
    "brand_themes",
    "custom_domains",
    "share_tokens",
    "share_token_views",
    "scheduled_reports",
    "report_artifacts",
    "audit_log",
  ];

  // ---- table-existence sanity check -----------------------------------

  it("every one of the 35 new tables exists", async () => {
    const result = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    const actual = result.rows.map((r) => r.table_name);
    for (const table of NEW_TABLES) {
      expect(actual, `missing table: ${table}`).toContain(table);
    }
  });

  // ---- scenario 1 — materialized-view lint rule fires at migrate time ----

  it("scenario 1 — a migration creating a materialized view is rejected at migrate time", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "nominara-story009-matview-"));
    try {
      await writeFile(
        path.join(tempDir, "0005_probe_matview.up.sql"),
        "CREATE MATERIALIZED VIEW probe_matview AS SELECT 1 AS one;\n",
      );
      await writeFile(path.join(tempDir, "0005_probe_matview.down.sql"), "DROP MATERIALIZED VIEW IF EXISTS probe_matview;\n");

      // migrateUp(client, tempDir) applies every migration NOT yet recorded
      // in this database in filename order — since 0001-0004 are already
      // applied (via the real MIGRATIONS_DIR in beforeEach), pointing it at
      // tempDir alone would see nothing new. Point it at a directory that
      // reuses the already-applied names plus the new probe by copying
      // nothing — instead, exercise the guard directly against a runner
      // rooted at tempDir on a FRESH schema so 0005 is the only candidate.
      await client.query("DROP SCHEMA IF EXISTS app CASCADE");
      await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
      await client.query("DROP SCHEMA public CASCADE");
      await client.query("CREATE SCHEMA public");

      await expect(migrateUp(client, tempDir)).rejects.toThrow(/materialized view/i);

      const tableExists = await client.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'probe_matview'",
      );
      expect(tableExists.rowCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      // Restore the full chain for tests that run after this one in the
      // same file (afterEach only closes the client; beforeEach re-runs
      // migrateUp against the real MIGRATIONS_DIR for the NEXT test).
    }
  });

  it("scenario 1b — the contract-phase annotation does NOT bypass the materialized-view guard", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "nominara-story009-matview-annotated-"));
    try {
      await writeFile(
        path.join(tempDir, "0005_probe_matview.up.sql"),
        "-- @contract-phase\nCREATE MATERIALIZED VIEW probe_matview AS SELECT 1 AS one;\n",
      );
      await writeFile(path.join(tempDir, "0005_probe_matview.down.sql"), "DROP MATERIALIZED VIEW IF EXISTS probe_matview;\n");

      await client.query("DROP SCHEMA IF EXISTS app CASCADE");
      await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
      await client.query("DROP SCHEMA public CASCADE");
      await client.query("CREATE SCHEMA public");

      await expect(migrateUp(client, tempDir)).rejects.toThrow(/materialized view/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // ---- AC-8 backstop — no materialized view exists in the applied database,
  // not just "the lint rule would reject one". The lint rule is regex-based
  // (assertNoMaterializedViews) and is itself thoroughly unit- and
  // integration-tested above and in test/unit/additive-guard.spec.ts, but
  // nothing until now queried the actual database state — a state check
  // closes the gap a regex could in principle miss (e.g. an interleaved SQL
  // comment between the three keywords), regardless of how the DDL that
  // produced the schema was written.

  it("AC-8 — no materialized view exists anywhere after the full migration chain is applied", async () => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'm'`,
    );
    expect(Number(result.rows[0]!.count)).toBe(0);
  });

  // ---- scenario 2 -------------------------------------------------------

  it("scenario 2 — two rollup rows for one day under different scoring versions are both permitted", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const insert = (scoringVersion: string) =>
      client.query(
        `INSERT INTO metric_daily
           (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date, scoring_version)
         VALUES ($1, $2, 'all', 'brand', $3, '2026-08-01', $4)`,
        [workspaceId, projectId, projectId, scoringVersion],
      );

    await expect(insert("v1")).resolves.toBeDefined();
    await expect(insert("v2")).resolves.toBeDefined();

    const rows = await client.query("SELECT scoring_version FROM metric_daily WHERE project_id = $1", [projectId]);
    expect(rows.rowCount).toBe(2);
  });

  // ---- scenario 3 -------------------------------------------------------

  it("scenario 3 — recomputing an analysis for the same window replaces rather than duplicates", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const insertOrReplace = (score: number) =>
      client.query(
        `INSERT INTO geo_analyses (workspace_id, project_id, analysis, window_start, window_days, score)
         VALUES ($1, $2, 'alignment', '2026-08-01', 30, $3)
         ON CONFLICT (project_id, analysis, window_start, window_days, scoring_version)
         DO UPDATE SET score = EXCLUDED.score`,
        [workspaceId, projectId, score],
      );

    await insertOrReplace(50);
    await insertOrReplace(75);

    const rows = await client.query("SELECT score FROM geo_analyses WHERE project_id = $1", [projectId]);
    expect(rows.rowCount).toBe(1);
    expect(Number(rows.rows[0].score)).toBe(75);
  });

  // ---- scenario 4 -------------------------------------------------------

  it("scenario 4 — pinning two milestones with the same source: the second is rejected", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const sourceId = randomUUID();
    const insert = () =>
      client.query(
        `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, source_type, source_id)
         VALUES ($1, $2, now(), 'task_completed', 'Title', 'task', $3)`,
        [workspaceId, projectId, sourceId],
      );

    await expect(insert()).resolves.toBeDefined();
    await expect(insert()).rejects.toThrow(/ux_milestones_source/);
  });

  // ---- scenario 5 -------------------------------------------------------

  it("scenario 5 — a second open task with the same fingerprint is rejected; permitted after the first completes", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const fingerprint = createHash("sha256").update("dedupe-fp").digest();

    const firstId = await createTask(workspaceId, projectId, { dedupeFingerprint: fingerprint });
    await expect(createTask(workspaceId, projectId, { dedupeFingerprint: fingerprint })).rejects.toThrow(
      /ux_tasks_dedupe/,
    );

    await client.query("UPDATE tasks SET status = 'done' WHERE id = $1", [firstId]);
    await expect(
      createTask(workspaceId, projectId, { dedupeFingerprint: fingerprint }),
    ).resolves.toBeDefined();
  });

  // ux_tasks_dedupe's predicate has two clauses (status <> 'done' AND
  // deleted_at IS NULL) — scenario 5 above only exercises the status clause.
  it("ux_tasks_dedupe — soft-deleting the first task also frees the fingerprint, and a different project_id is a distinct key", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const fingerprint = createHash("sha256").update("dedupe-fp-soft-delete").digest();

    const firstId = await createTask(workspaceId, projectId, { dedupeFingerprint: fingerprint });
    await expect(createTask(workspaceId, projectId, { dedupeFingerprint: fingerprint })).rejects.toThrow(
      /ux_tasks_dedupe/,
    );

    await client.query("UPDATE tasks SET deleted_at = now() WHERE id = $1", [firstId]);
    await expect(
      createTask(workspaceId, projectId, { dedupeFingerprint: fingerprint }),
    ).resolves.toBeDefined();

    // project_id is part of the unique key, so the same fingerprint in a
    // DIFFERENT project is permitted, not deduped across projects.
    const projectId2 = await createProject(workspaceId);
    await expect(
      createTask(workspaceId, projectId2, { dedupeFingerprint: fingerprint }),
    ).resolves.toBeDefined();
  });

  it("ux_tasks_short_ref — workspace-unique short_ref rejects a duplicate within the same workspace, permitted in a different workspace", async () => {
    const workspaceId = await createWorkspace();
    const projectA = await createProject(workspaceId);
    const projectB = await createProject(workspaceId);

    await createTask(workspaceId, projectA, { shortRef: "HUB-500" });
    await expect(createTask(workspaceId, projectB, { shortRef: "HUB-500" })).rejects.toThrow(
      /ux_tasks_short_ref/,
    );

    const otherWorkspaceId = await createWorkspace();
    const otherProjectId = await createProject(otherWorkspaceId);
    await expect(
      createTask(otherWorkspaceId, otherProjectId, { shortRef: "HUB-500" }),
    ).resolves.toBeDefined();
  });

  // ---- scenario 6 -------------------------------------------------------

  it("scenario 6 — a semantic node without evidence is rejected", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);

    await expect(
      client.query(
        `INSERT INTO semantic_nodes (workspace_id, project_id, phrase, phrase_normalized, node_type, evidence_snippet)
         VALUES ($1, $2, 'phrase', 'phrase', 'capability', 'snippet')`,
        [workspaceId, projectId],
      ),
    ).rejects.toThrow(/null value in column "evidence_url"/i);

    await expect(
      client.query(
        `INSERT INTO semantic_nodes (workspace_id, project_id, phrase, phrase_normalized, node_type, evidence_url)
         VALUES ($1, $2, 'phrase', 'phrase', 'capability', 'https://example.com')`,
        [workspaceId, projectId],
      ),
    ).rejects.toThrow(/null value in column "evidence_snippet"/i);

    await expect(
      client.query(
        `INSERT INTO semantic_nodes
           (workspace_id, project_id, phrase, phrase_normalized, node_type, evidence_url, evidence_snippet)
         VALUES ($1, $2, 'phrase', 'phrase', 'capability', 'https://example.com', 'snippet')`,
        [workspaceId, projectId],
      ),
    ).resolves.toBeDefined();
  });

  // ---- scenario 7 --------------------------------------------------------
  // ck_tr_shape, per tool. KNOWN GAP (E-1, mirrors this story's amended Test
  // Scenario 7 row): array_length() of a NULL or '{}' array returns SQL
  // NULL, not 0 — a CASE branch that evaluates to NULL makes the whole CHECK
  // pass (NULL is not FALSE). This affects BOTH branches that depend solely
  // on an array_length() test: prompt_research's
  //   array_length(prompt_texts, 1) BETWEEN 1 AND 10
  // AND visibility_scan's
  //   array_length(engine_keys, 1) BETWEEN 1 AND 4
  // — visibility_scan's other two conditions (brand_name/query_text IS NOT
  // NULL) are still enforced directly, so a visibility_scan row missing
  // brand_name or query_text IS still rejected (proven below); only the
  // engine_keys NULL/'{}' case slips through. So a prompt_research row with
  // no prompt texts, or a visibility_scan row with no engines, is NOT
  // rejected by ck_tr_shape. This is a real gap in
  // tools-attribution-agency.md's literal DDL, not something this migration
  // papers over with a COALESCE fix. (Corrected from this story's original,
  // now-false claim that this gap affected only prompt_research, "unlike the
  // other five tools" — QA confirmed by direct insert that visibility_scan
  // has the identical hole.)

  it("scenario 7 — visibility_scan missing its required input (brand_name) is rejected", async () => {
    const workspaceId = await createWorkspace();
    await expect(
      insertToolRun(workspaceId, { tool_key: "visibility_scan", query_text: "q", engine_keys: ["chatgpt"] }),
    ).rejects.toThrow(/ck_tr_shape/);
  });

  it("scenario 7 — competitor_finder missing its required input (brand_url) is rejected", async () => {
    const workspaceId = await createWorkspace();
    await expect(insertToolRun(workspaceId, { tool_key: "competitor_finder" })).rejects.toThrow(/ck_tr_shape/);
  });

  it("scenario 7 — aux_audit missing its required input (target_url) is rejected", async () => {
    const workspaceId = await createWorkspace();
    await expect(insertToolRun(workspaceId, { tool_key: "aux_audit" })).rejects.toThrow(/ck_tr_shape/);
  });

  it("scenario 7 — schema_builder missing its required input (result_json) is rejected", async () => {
    const workspaceId = await createWorkspace();
    await expect(insertToolRun(workspaceId, { tool_key: "schema_builder" })).rejects.toThrow(/ck_tr_shape/);
  });

  it("scenario 7 — compare_runs missing its required input (both diff run ids) is rejected", async () => {
    const workspaceId = await createWorkspace();
    await expect(insertToolRun(workspaceId, { tool_key: "compare_runs" })).rejects.toThrow(/ck_tr_shape/);
  });

  it("scenario 7 exception (E-1) — prompt_research with NULL prompt_texts is ACCEPTED, but 11 texts is still rejected", async () => {
    const workspaceId = await createWorkspace();

    // The known gap: neither NULL nor '{}' triggers ck_tr_shape.
    await expect(insertToolRun(workspaceId, { tool_key: "prompt_research" })).resolves.toBeDefined();
    await expect(
      insertToolRun(workspaceId, { tool_key: "prompt_research", prompt_texts: [] }),
    ).resolves.toBeDefined();

    // The upper bound still works: array_length() of a NON-empty array is a
    // real integer, so BETWEEN 1 AND 10 correctly rejects 11.
    const elevenTexts = Array.from({ length: 11 }, (_, i) => `prompt ${i}`);
    await expect(
      insertToolRun(workspaceId, { tool_key: "prompt_research", prompt_texts: elevenTexts }),
    ).rejects.toThrow(/ck_tr_shape/);

    // And a valid count (1..10) is accepted, including the upper boundary
    // itself (10 exactly), which was previously untested on either side.
    await expect(
      insertToolRun(workspaceId, { tool_key: "prompt_research", prompt_texts: ["prompt 1"] }),
    ).resolves.toBeDefined();
    const tenTexts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    await expect(
      insertToolRun(workspaceId, { tool_key: "prompt_research", prompt_texts: tenTexts }),
    ).resolves.toBeDefined();
  });

  it("scenario 7 exception (E-1) — visibility_scan with NULL/'{}' engine_keys is ACCEPTED (brand_name/query_text still enforced), but 5 engines is still rejected", async () => {
    const workspaceId = await createWorkspace();

    // The known gap: neither NULL nor '{}' engine_keys triggers ck_tr_shape,
    // as long as the two directly-checked conditions (brand_name, query_text)
    // are present.
    await expect(
      insertToolRun(workspaceId, { tool_key: "visibility_scan", brand_name: "Acme", query_text: "q" }),
    ).resolves.toBeDefined();
    await expect(
      insertToolRun(workspaceId, {
        tool_key: "visibility_scan",
        brand_name: "Acme",
        query_text: "q",
        engine_keys: [],
      }),
    ).resolves.toBeDefined();

    // brand_name/query_text are NOT part of the array_length() branch, so
    // they are still enforced directly even when engine_keys is empty.
    await expect(
      insertToolRun(workspaceId, { tool_key: "visibility_scan", query_text: "q", engine_keys: [] }),
    ).rejects.toThrow(/ck_tr_shape/);

    // The upper bound still works: array_length() of a non-empty array is a
    // real integer, so BETWEEN 1 AND 4 correctly rejects 5 — and 4 exactly is
    // accepted (both boundaries were previously untested).
    await expect(
      insertToolRun(workspaceId, {
        tool_key: "visibility_scan",
        brand_name: "Acme",
        query_text: "q",
        engine_keys: ["chatgpt", "perplexity", "copilot", "meta_ai", "grok"],
      }),
    ).rejects.toThrow(/ck_tr_shape/);
    await expect(
      insertToolRun(workspaceId, {
        tool_key: "visibility_scan",
        brand_name: "Acme",
        query_text: "q",
        engine_keys: ["chatgpt", "perplexity", "copilot", "meta_ai"],
      }),
    ).resolves.toBeDefined();
  });

  // ---- positive (successful-insert) cases for the 4 tools that otherwise
  // only had negative tests above. schema_builder and prompt_research
  // already have well-formed accepted rows exercised elsewhere in this file
  // (scenario 7's own exception test, and scenario 9 below) — a CASE branch
  // that accidentally rejected everything for these 4 tools would have
  // passed the suite undetected without this.

  it("visibility_scan — a well-formed row is accepted", async () => {
    const workspaceId = await createWorkspace();
    await expect(
      insertToolRun(workspaceId, {
        tool_key: "visibility_scan",
        brand_name: "Acme",
        query_text: "best crm software",
        engine_keys: ["chatgpt"],
      }),
    ).resolves.toBeDefined();
  });

  it("competitor_finder — a well-formed row is accepted", async () => {
    const workspaceId = await createWorkspace();
    await expect(
      insertToolRun(workspaceId, { tool_key: "competitor_finder", brand_url: "https://acme.example.com" }),
    ).resolves.toBeDefined();
  });

  it("aux_audit — a well-formed row is accepted", async () => {
    const workspaceId = await createWorkspace();
    await expect(
      insertToolRun(workspaceId, { tool_key: "aux_audit", target_url: "https://acme.example.com" }),
    ).resolves.toBeDefined();
  });

  it("compare_runs — a well-formed row is accepted", async () => {
    const workspaceId = await createWorkspace();
    const baseId = await insertToolRun(workspaceId, { tool_key: "schema_builder", result_json: {} });
    const compareId = await insertToolRun(workspaceId, { tool_key: "schema_builder", result_json: {} });
    await expect(
      insertToolRun(workspaceId, {
        tool_key: "compare_runs",
        diff_base_run_id: baseId,
        diff_compare_run_id: compareId,
      }),
    ).resolves.toBeDefined();
  });

  // ---- scenario 8 -------------------------------------------------------

  it("scenario 8 — a tool row including an excluded engine (gemini/claude) is rejected", async () => {
    const workspaceId = await createWorkspace();
    await expect(
      insertToolRun(workspaceId, {
        tool_key: "visibility_scan",
        brand_name: "Acme",
        query_text: "q",
        engine_keys: ["gemini"],
      }),
    ).rejects.toThrow(/ck_tr_engine_set/);
  });

  // ---- scenario 9 -------------------------------------------------------

  it("scenario 9 — a debit recorded on either free tool is rejected", async () => {
    const workspaceId = await createWorkspace();
    await expect(
      insertToolRun(workspaceId, { tool_key: "schema_builder", result_json: {}, credits_charged: 1 }),
    ).rejects.toThrow(/ck_tr_free_tools/);

    const baseId = await insertToolRun(workspaceId, { tool_key: "schema_builder", result_json: {} });
    const compareId = await insertToolRun(workspaceId, { tool_key: "schema_builder", result_json: {} });
    await expect(
      insertToolRun(workspaceId, {
        tool_key: "compare_runs",
        diff_base_run_id: baseId,
        diff_compare_run_id: compareId,
        credits_charged: 1,
      }),
    ).rejects.toThrow(/ck_tr_free_tools/);
  });

  it("ck_tr_free_tools — a PAID tool with credits_charged > 0 is permitted, and the two free tools with credits_charged = 0 succeed", async () => {
    const workspaceId = await createWorkspace();

    // visibility_scan is not one of the two free tools (schema_builder,
    // compare_runs), so a nonzero debit is permitted.
    await expect(
      insertToolRun(workspaceId, {
        tool_key: "visibility_scan",
        brand_name: "Acme",
        query_text: "q",
        engine_keys: ["chatgpt"],
        credits_charged: 1,
      }),
    ).resolves.toBeDefined();

    await expect(
      insertToolRun(workspaceId, { tool_key: "schema_builder", result_json: {}, credits_charged: 0 }),
    ).resolves.toBeDefined();

    const baseId = await insertToolRun(workspaceId, { tool_key: "schema_builder", result_json: {} });
    const compareId = await insertToolRun(workspaceId, { tool_key: "schema_builder", result_json: {} });
    await expect(
      insertToolRun(workspaceId, {
        tool_key: "compare_runs",
        diff_base_run_id: baseId,
        diff_compare_run_id: compareId,
        credits_charged: 0,
      }),
    ).resolves.toBeDefined();
  });

  // ---- scenario 10 --------------------------------------------------------

  it("scenario 10 — an oversized tool_runs.result_json payload is rejected by the size trigger", async () => {
    const workspaceId = await createWorkspace();
    const oversized = { blob: "x".repeat(25_000) };
    await expect(
      insertToolRun(workspaceId, { tool_key: "schema_builder", result_json: oversized }),
    ).rejects.toThrow(/result_json is \d+ bytes, exceeding the 24576 byte limit/i);
  });

  // The trigger's limit is a byte count of the jsonb value's canonical text
  // form (octet_length(val::text)), not of the JS-side JSON.stringify
  // output — Postgres re-serializes on ::text regardless of the input's own
  // formatting. A payload shaped `{"blob": "<N x's>"}` costs exactly 12
  // bytes of structural overhead in that canonical form, so blob length
  // 24564 lands exactly on the 24576-byte limit (accepted) and 24565 is one
  // byte over (rejected) — verified empirically against a live server
  // rather than assumed.
  it("scenario 10 boundary — result_json at exactly 24576 bytes is accepted, 24577 is rejected", async () => {
    const workspaceId = await createWorkspace();
    const atLimit = { blob: "x".repeat(24_564) };
    const overLimit = { blob: "x".repeat(24_565) };

    await expect(
      insertToolRun(workspaceId, { tool_key: "schema_builder", result_json: atLimit }),
    ).resolves.toBeDefined();
    await expect(
      insertToolRun(workspaceId, { tool_key: "schema_builder", result_json: overLimit }),
    ).rejects.toThrow(/result_json is 24577 bytes, exceeding the 24576 byte limit/i);
  });

  // The trigger fires on `AFTER INSERT OR UPDATE OF result_json` — only the
  // INSERT path was tested above.
  it("scenario 10 UPDATE path — an UPDATE that grows result_json past the limit is rejected by the same trigger", async () => {
    const workspaceId = await createWorkspace();
    const runId = await insertToolRun(workspaceId, { tool_key: "schema_builder", result_json: { blob: "small" } });

    const oversized = { blob: "x".repeat(25_000) };
    await expect(
      client.query("UPDATE tool_runs SET result_json = $1 WHERE id = $2", [oversized, runId]),
    ).rejects.toThrow(/result_json is \d+ bytes, exceeding the 24576 byte limit/i);

    // The row is untouched by the rejected UPDATE.
    const row = await client.query<{ result_json: { blob: string } }>(
      "SELECT result_json FROM tool_runs WHERE id = $1",
      [runId],
    );
    expect(row.rows[0]!.result_json).toEqual({ blob: "small" });
  });

  // ---- scenario 11 --------------------------------------------------------

  it("scenario 11 — updating or deleting an audit_log row is rejected by the append-only trigger, and the row persists unchanged", async () => {
    const workspaceId = await createWorkspace();
    const prevHash = Buffer.alloc(32, 0);
    const rowHash = Buffer.alloc(32, 1);
    const result = await client.query<{ seq: string }>(
      `INSERT INTO audit_log
         (workspace_id, actor_type, action, resource_type, request_id, prev_hash, row_hash)
       VALUES ($1, 'user', 'project.create', 'project', 'req-1', $2, $3)
       RETURNING seq`,
      [workspaceId, prevHash, rowHash],
    );
    const seqId = result.rows[0]!.seq;

    await expect(
      client.query("UPDATE audit_log SET action = 'project.update' WHERE seq = $1", [seqId]),
    ).rejects.toThrow(/append-only/i);

    await expect(client.query("DELETE FROM audit_log WHERE seq = $1", [seqId])).rejects.toThrow(/append-only/i);

    // The AC has three parts — append-only, both hash columns, the
    // support-grant reference — and the append-only assertion above never
    // re-confirmed the row itself actually still exists, unchanged, after
    // the rejected mutations. Prove it rather than assume it.
    const row = await client.query<{ action: string; prev_hash: Buffer; row_hash: Buffer }>(
      "SELECT action, prev_hash, row_hash FROM audit_log WHERE seq = $1",
      [seqId],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.action).toBe("project.create");
    expect(Buffer.compare(row.rows[0]!.prev_hash, prevHash)).toBe(0);
    expect(Buffer.compare(row.rows[0]!.row_hash, rowHash)).toBe(0);
  });

  it("audit_log — prev_hash and row_hash both carry the AC's non-null guarantee", async () => {
    const workspaceId = await createWorkspace();
    await expect(
      client.query(
        `INSERT INTO audit_log (workspace_id, actor_type, action, resource_type, request_id, prev_hash, row_hash)
         VALUES ($1, 'user', 'project.create', 'project', 'req-2', NULL, $2)`,
        [workspaceId, Buffer.alloc(32, 1)],
      ),
    ).rejects.toThrow(/null value in column "prev_hash"/i);

    await expect(
      client.query(
        `INSERT INTO audit_log (workspace_id, actor_type, action, resource_type, request_id, prev_hash, row_hash)
         VALUES ($1, 'user', 'project.create', 'project', 'req-3', $2, NULL)`,
        [workspaceId, Buffer.alloc(32, 0)],
      ),
    ).rejects.toThrow(/null value in column "row_hash"/i);
  });

  it("audit_log — support_grant_id records a support-initiated action", async () => {
    const workspaceId = await createWorkspace();
    const supportGrantId = randomUUID();
    const result = await client.query<{ support_grant_id: string }>(
      `INSERT INTO audit_log
         (workspace_id, actor_type, action, resource_type, request_id, support_grant_id, prev_hash, row_hash)
       VALUES ($1, 'support', 'workspace.impersonate', 'workspace', 'req-4', $2, $3, $4)
       RETURNING support_grant_id`,
      [workspaceId, supportGrantId, Buffer.alloc(32, 0), Buffer.alloc(32, 1)],
    );
    expect(result.rows[0]!.support_grant_id).toBe(supportGrantId);
  });

  // ---- scenario 12 --------------------------------------------------------

  it("scenario 12 — a platform_metrics benchmark row below the minimum sample is rejected", async () => {
    await createEngine("chatgpt");
    const insert = (sampleSize: number) =>
      client.query(
        `INSERT INTO platform_metrics
           (metric_date, category_slug, engine_key, sample_size, median_visibility, p25_visibility, p75_visibility,
            median_aux_score, top_source_domains)
         VALUES ('2026-08-01', 'crm', 'chatgpt', $1, 50, 40, 60, 70, '[]'::jsonb)`,
        [sampleSize],
      );

    await expect(insert(19)).rejects.toThrow(/platform_metrics_sample_size_check/);
    await expect(insert(20)).resolves.toBeDefined();
  });

  // ---- scenario 13 --------------------------------------------------------

  it("scenario 13 — the census counts 59 tenant-scoped tables and 10 global tables (69 total), and every non-global table is verifiably tenant-scoped", async () => {
    const result = await client.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND NOT c.relispartition`,
    );
    const tableNames = result.rows.map((r) => r.relname);

    expect(tableNames.length).toBe(69);

    const globalCount = tableNames.filter((name) => (GLOBAL_TABLES as readonly string[]).includes(name)).length;
    expect(globalCount).toBe(10);

    const nonGlobalTables = tableNames.filter((name) => !(GLOBAL_TABLES as readonly string[]).includes(name));
    expect(nonGlobalTables.length).toBe(59);

    // Fail-closed: every non-global table must carry a `workspace_id` column,
    // OR be an explicit, reviewed exception in TENANT_SCOPE_COLUMN (today
    // only `workspaces`, scoped by its own `id`). A table satisfying NEITHER
    // condition would be a tenant-scoped-looking table silently missing its
    // scope column — the whole reason the census AC exists. This replaces
    // the previous `expect(tableNames.length - globalCount).toBe(59)`
    // arithmetic tautology (69 - 10 = 59 can never fail independently of the
    // other two counts, and it never actually inspected any of the 59
    // tables) with a real per-table assertion, and makes TENANT_SCOPE_COLUMN
    // an actually-consumed export.
    const columnsResult = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [nonGlobalTables],
    );
    const columnsByTable = new Map<string, Set<string>>();
    for (const { table_name, column_name } of columnsResult.rows) {
      if (!columnsByTable.has(table_name)) {
        columnsByTable.set(table_name, new Set());
      }
      columnsByTable.get(table_name)!.add(column_name);
    }

    const unscoped = nonGlobalTables.filter((table) => {
      const explicitScopeColumn = TENANT_SCOPE_COLUMN[table];
      const requiredColumn = explicitScopeColumn ?? "workspace_id";
      return !columnsByTable.get(table)?.has(requiredColumn);
    });

    expect(unscoped).toEqual([]);
  });

  // ---- scenario 14 --------------------------------------------------------

  it("scenario 14 — rolling the migration back is clean", async () => {
    const rolledBack = await rollbackLast(client, migrationsDir);
    expect(rolledBack).toBe("0004_rollups_aux_tasks_geo_tools");

    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const gone of NEW_TABLES) {
      expect(names, gone).not.toContain(gone);
    }

    // STORY-008's tables survive this rollback untouched.
    expect(names).toContain("projects");
    expect(names).toContain("answer_captures");
    // ...and displacement_events survives with its FK constraint dropped
    // (the down migration drops the constraint before dropping tasks).
    expect(names).toContain("displacement_events");
  });

  // ==== widened coverage beyond the 14 named scenarios ====================

  // ---- AC 5 — no ordering/lane-order column, scoped to this migration's
  // own tables. Two regexes imported from src/db/conventions.ts (the single
  // source of truth — no retyped duplicate regex in this file that could
  // drift from the one actually used elsewhere): ORDER_COLUMN_PATTERN
  // (order/ordering only) for the 33 tables where an ordering column would
  // just be an unrelated false positive risk, and the broader
  // WIDE_ORDER_COLUMN_PATTERN (also matches ordinal/sort/sequence/rank/
  // position/lane/slot/index) for `tasks` and `task_events` specifically —
  // the two tables where a hand-authored ordering/priority-lane column would
  // actually defeat the AC's intent.

  it("AC 5 — no ordering column (or wider synonym on tasks/task_events) exists on any table from this migration", async () => {
    const WIDENED_TABLES = ["tasks", "task_events"];
    const narrowTables = NEW_TABLES.filter((table) => !WIDENED_TABLES.includes(table));

    const allColumns = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [NEW_TABLES],
    );

    const violations = allColumns.rows.filter(({ table_name, column_name }) => {
      const pattern = WIDENED_TABLES.includes(table_name) ? WIDE_ORDER_COLUMN_PATTERN : ORDER_COLUMN_PATTERN;
      return pattern.test(column_name);
    });
    expect(violations).toEqual([]);

    // Sanity the scan actually ran over something in both groups.
    expect(narrowTables.length).toBe(NEW_TABLES.length - WIDENED_TABLES.length);
    expect(allColumns.rows.some((r) => r.table_name === "tasks")).toBe(true);
    expect(allColumns.rows.some((r) => r.table_name === "task_events")).toBe(true);

    // Sanity check the narrow regex is meaningful at all: plans.sort_order (a
    // legitimate catalog display-order column from migration 0002, not a
    // task-ordering column) is OUTSIDE this migration's table list and
    // therefore correctly excluded from the scan above.
    const plansHasSortOrder = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'plans' AND column_name = 'sort_order'",
    );
    expect(plansHasSortOrder.rowCount).toBe(1);

    // Backstop: real columns queried from the database (not retyped string
    // literals) that must NOT be false-flagged by the narrow pattern, even
    // though several of them contain "rank"/"index"/"position" substrings
    // that the WIDE pattern (deliberately scoped to tasks/task_events only)
    // would catch.
    const assertRealColumnUnflagged = async (table: string, column: string) => {
      const existsResult = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
        [table, column],
      );
      expect(existsResult.rowCount, `${table}.${column} should exist`).toBe(1);
      expect(ORDER_COLUMN_PATTERN.test(column), `${table}.${column} should not match the narrow pattern`).toBe(
        false,
      );
    };
    await assertRealColumnUnflagged("project_source_index", "rank_position");
    await assertRealColumnUnflagged("metric_daily", "avg_rank_position");
    await assertRealColumnUnflagged("geo_analyses", "lever_rank");
    await assertRealColumnUnflagged("semantic_nodes", "priority_rank");
    await assertRealColumnUnflagged("content_chunks", "chunk_index");
    await assertRealColumnUnflagged("corpus_passages", "passage_index");
    await assertRealColumnUnflagged("source_domains", "authority_tier");

    // Document why the WIDE pattern is deliberately NOT applied to those
    // tables: it WOULD flag several of them (proving the pattern itself is
    // meaningful, not a no-op), which is exactly why item 11's scope split
    // exists rather than widening every one of the 35 tables.
    expect(WIDE_ORDER_COLUMN_PATTERN.test("rank_position")).toBe(true);
    expect(WIDE_ORDER_COLUMN_PATTERN.test("chunk_index")).toBe(true);
    expect(WIDE_ORDER_COLUMN_PATTERN.test("priority_rank")).toBe(true);
  });

  // ---- ref_counters -------------------------------------------------------

  it("ref_counters — PK uniqueness, atomic increment via UPDATE ... RETURNING, and cascades from workspaces", async () => {
    const workspaceId = await createWorkspace();
    await client.query("INSERT INTO ref_counters (workspace_id, prefix) VALUES ($1, 'HUB')", [workspaceId]);
    await expect(
      client.query("INSERT INTO ref_counters (workspace_id, prefix) VALUES ($1, 'HUB')", [workspaceId]),
    ).rejects.toThrow(/ref_counters_pkey/);

    const incremented = await client.query<{ next_value: number }>(
      "UPDATE ref_counters SET next_value = next_value + 1 WHERE workspace_id = $1 AND prefix = 'HUB' RETURNING next_value",
      [workspaceId],
    );
    expect(incremented.rows[0]!.next_value).toBe(2);

    await client.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    const remaining = await client.query("SELECT 1 FROM ref_counters WHERE workspace_id = $1", [workspaceId]);
    expect(remaining.rowCount).toBe(0);
  });

  // ---- vector uniqueness-includes-model: content_chunks ------------------

  it("content_chunks — ux_content_chunks includes embedding_model, and the HNSW index is used", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const contentHash = createHash("sha256").update("chunk-content").digest();

    const insertChunk = (model: string | null) =>
      client.query(
        `INSERT INTO content_chunks
           (workspace_id, project_id, url, chunk_index, text, token_count, content_hash, embedding_model)
         VALUES ($1, $2, 'https://example.com', 0, 'text', 10, $3, $4)`,
        [workspaceId, projectId, contentHash, model],
      );

    await expect(insertChunk("model-a")).resolves.toBeDefined();
    await expect(insertChunk("model-b")).resolves.toBeDefined();
    await expect(insertChunk("model-a")).rejects.toThrow(/ux_content_chunks/);

    for (let i = 0; i < 30; i++) {
      await client.query(
        `INSERT INTO content_chunks
           (workspace_id, project_id, url, chunk_index, text, token_count, content_hash, embedding_model, embedding)
         VALUES ($1, $2, 'https://example.com', $3, 'text', 10, $4, 'model-hnsw', $5)`,
        [
          workspaceId,
          projectId,
          i + 1,
          createHash("sha256").update(`chunk-${i}`).digest(),
          halfvecLiteral(i),
        ],
      );
    }
    // eslint-disable-next-line nominara/no-session-scoped-config -- test-fixture convenience on a dedicated test connection to force an index scan for verification, not tenant-context traffic; SET LOCAL would silently no-op outside an explicit transaction here.
    await client.query("SET enable_seqscan = off");
    const explain = await client.query(
      "EXPLAIN SELECT id FROM content_chunks ORDER BY embedding <=> $1 LIMIT 5",
      [halfvecLiteral(0)],
    );
    const plan = explain.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/Index Scan.*ix_content_chunks_hnsw/is);
  });

  // KNOWN LIMITATION (E-3), pinned rather than left as a comment-only claim:
  // embedding_model is nullable, and Postgres's NULL-distinct default means
  // ux_content_chunks (workspace_id, content_hash, embedding_model, is_draft)
  // does NOT dedupe two rows that share a NULL model — unlike two rows
  // sharing the SAME non-null model, which IS rejected (proven above).
  it("content_chunks — ux_content_chunks does NOT dedupe rows sharing a NULL embedding_model (E-3, documented limitation)", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const contentHash = createHash("sha256").update("chunk-null-model").digest();

    const insertChunk = () =>
      client.query(
        `INSERT INTO content_chunks
           (workspace_id, project_id, url, chunk_index, text, token_count, content_hash, embedding_model)
         VALUES ($1, $2, 'https://example.com', 0, 'text', 10, $3, NULL)`,
        [workspaceId, projectId, contentHash],
      );

    await expect(insertChunk()).resolves.toBeDefined();
    await expect(insertChunk()).resolves.toBeDefined();
  });

  // ---- vector uniqueness-includes-model: corpus_passages ------------------

  it("corpus_passages — ux_corpus_passages includes embedding_model, and the HNSW index is used", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const contentHash = createHash("sha256").update("passage-content").digest();

    const insertPassage = (model: string) =>
      client.query(
        `INSERT INTO corpus_passages
           (workspace_id, project_id, citation_url_hash, url, domain, passage_index, text, token_count,
            content_hash, embedding_model, expires_at)
         VALUES ($1, $2, $3, 'https://example.com', 'example.com', 0, 'text', 10, $4, $5, now() + interval '30 days')`,
        [workspaceId, projectId, createHash("sha256").update("url").digest(), contentHash, model],
      );

    await expect(insertPassage("model-a")).resolves.toBeDefined();
    await expect(insertPassage("model-b")).resolves.toBeDefined();
    await expect(insertPassage("model-a")).rejects.toThrow(/ux_corpus_passages/);

    for (let i = 0; i < 30; i++) {
      await client.query(
        `INSERT INTO corpus_passages
           (workspace_id, project_id, citation_url_hash, url, domain, passage_index, text, token_count,
            content_hash, embedding_model, embedding, expires_at)
         VALUES ($1, $2, $3, 'https://example.com', 'example.com', $4, 'text', 10, $5, 'model-hnsw', $6, now() + interval '30 days')`,
        [
          workspaceId,
          projectId,
          createHash("sha256").update(`url-${i}`).digest(),
          i + 1,
          createHash("sha256").update(`passage-${i}`).digest(),
          halfvecLiteral(i),
        ],
      );
    }
    // eslint-disable-next-line nominara/no-session-scoped-config -- test-fixture convenience on a dedicated test connection to force an index scan for verification, not tenant-context traffic; SET LOCAL would silently no-op outside an explicit transaction here.
    await client.query("SET enable_seqscan = off");
    const explain = await client.query(
      "EXPLAIN SELECT id FROM corpus_passages ORDER BY embedding <=> $1 LIMIT 5",
      [halfvecLiteral(0)],
    );
    const plan = explain.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/Index Scan.*ix_corpus_hnsw/is);
  });

  // ---- niche_reports.sample_size NOT NULL ---------------------------------

  it("niche_reports — sample_size is NOT NULL", async () => {
    await expect(
      client.query(
        `INSERT INTO niche_reports
           (slug, title, category_slug, engine_keys, period_label, generated_at, next_refresh_at, payload, meta_description)
         VALUES ('slug', 'Title', 'crm', ARRAY['chatgpt'], 'August 2026', now(), now(), '{}'::jsonb, 'desc')`,
      ),
    ).rejects.toThrow(/null value in column "sample_size"/i);

    await expect(
      client.query(
        `INSERT INTO niche_reports
           (slug, title, category_slug, engine_keys, period_label, generated_at, next_refresh_at, payload,
            sample_size, meta_description)
         VALUES ('slug2', 'Title', 'crm', ARRAY['chatgpt'], 'August 2026', now(), now(), '{}'::jsonb, 25, 'desc')`,
      ),
    ).resolves.toBeDefined();
  });

  // ---- the STORY-008 FK debt: displacement_events.task_id -----------------

  it("displacement_events.task_id — deleting the referenced task nulls the column rather than blocking or cascading", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const taskId = await createTask(workspaceId, projectId);

    const result = await client.query<{ id: string }>(
      `INSERT INTO displacement_events
         (workspace_id, project_id, prompt_id, engine_key, kind, before_result_id, after_result_id, displaced_by, task_id)
       VALUES ($1, $2, $3, 'chatgpt', 'presence_lost', $4, $5, '[]'::jsonb, $6)
       RETURNING id`,
      [workspaceId, projectId, randomUUID(), randomUUID(), randomUUID(), taskId],
    );
    const eventId = result.rows[0]!.id;

    await client.query("DELETE FROM tasks WHERE id = $1", [taskId]);

    const row = await client.query("SELECT task_id FROM displacement_events WHERE id = $1", [eventId]);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].task_id).toBeNull();
  });

  it("displacement_events.task_id — a task_id pointing at a nonexistent task is rejected (the FK is real)", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);

    await expect(
      client.query(
        `INSERT INTO displacement_events
           (workspace_id, project_id, prompt_id, engine_key, kind, before_result_id, after_result_id, displaced_by, task_id)
         VALUES ($1, $2, $3, 'chatgpt', 'presence_lost', $4, $5, '[]'::jsonb, $6)`,
        [workspaceId, projectId, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow(/displacement_events_task_id_fkey/);
  });

  // ---- share_tokens.ck_share_scope_nonempty -------------------------------

  it("share_tokens — ck_share_scope_nonempty rejects an empty scope, permits one element", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const userId = await createUser();

    await expect(createShareToken(workspaceId, userId, { scopeProjectIds: [] })).rejects.toThrow(
      /ck_share_scope_nonempty/,
    );
    await expect(
      createShareToken(workspaceId, userId, { scopeProjectIds: [projectId] }),
    ).resolves.toBeDefined();
  });

  // ---- aux_findings partial unique index on fingerprint -------------------

  it("aux_findings — ux_aux_findings_fp dedupes among non-resolved rows only, mirroring the task dedupe shape", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const auditId = await createAuxAudit(workspaceId, projectId);
    const fingerprint = createHash("sha256").update("finding-fp").digest();

    const firstId = await createAuxFinding(workspaceId, projectId, auditId, { fingerprint });
    await expect(
      createAuxFinding(workspaceId, projectId, auditId, { fingerprint }),
    ).rejects.toThrow(/ux_aux_findings_fp/);

    await client.query("UPDATE aux_findings SET status = 'resolved' WHERE id = $1", [firstId]);
    await expect(
      createAuxFinding(workspaceId, projectId, auditId, { fingerprint }),
    ).resolves.toBeDefined();
  });

  // ---- custom_domains global uniqueness -----------------------------------

  it("custom_domains — ux_custom_domains_host is globally unique across workspaces, deliberately", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const insert = (workspaceId: string) =>
      client.query(
        `INSERT INTO custom_domains (workspace_id, hostname, cname_target, verification_token)
         VALUES ($1, 'reports.example.com', 'target.nominara.app', 'token')`,
        [workspaceId],
      );

    await expect(insert(workspaceA)).resolves.toBeDefined();
    await expect(insert(workspaceB)).rejects.toThrow(/ux_custom_domains_host/);
  });

  // ---- existence-only index checks ----------------------------------------

  it("ix_tr_brand_trgm and the attribution_daily/gsc_daily BRIN indexes exist", async () => {
    const check = async (indexName: string, tableName: string) => {
      const result = await client.query(
        "SELECT 1 FROM pg_indexes WHERE tablename = $1 AND indexname = $2",
        [tableName, indexName],
      );
      expect(result.rowCount, indexName).toBe(1);
    };

    await check("ix_tr_brand_trgm", "tool_runs");
    await check("ix_attribution_brin", "attribution_daily");
    await check("ix_gsc_daily_brin", "gsc_daily");
  });
});
