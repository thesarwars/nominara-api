import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BREAKGLASS_ROLE, PARTITIONED_FACT_TABLES, RUNTIME_ROLES } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { assertDemoSeedAllowed, DemoSeedRefusedError } from "../../src/db/seed/demo/guard.js";
import { runSeedDemo, type SeedDemoPool, type SeedDemoPoolClient } from "../../src/db/seed-demo.js";
import { readWallet } from "../../src/lib/credits/wallet.js";

// STORY-169 (API step 3/3) — `pnpm db:seed-demo`, end to end, as a real
// tenant-scoped `nominara_app` connection. RLS and tenant context are one of
// the four dangerous areas (development-workflow.md), so — same posture as
// `action-items.spec.ts` and `generated-rls-and-tenant-context.spec.ts` —
// every WRITE this test proves goes through the actual runtime role, never
// the superuser fixture connection, which would pass vacuously against RLS.
//
// `client` (the superuser) plays TWO roles here, matching production
// exactly: it is the fixture's own setup connection, AND it is the seed's
// own `DATABASE_URL` owner connection (partition DDL, workspace lookup) —
// `runSeedDemo`'s `ownerClient` parameter. `testPool()` stands in for
// `DATABASE_URL_POOLED`, opening a real `nominara_app` login per call,
// structurally satisfying `SeedDemoPool` the same way `pg.Pool` does.
describe("STORY-169 · db:seed-demo — end to end", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let seq = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 300_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrateUp(client);
    seq = 0;

    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      const password = resolvePassword(role, {});
      await client.query(`ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(password)}`);
    }
  });

  afterEach(async () => {
    await client.end();
  });

  function testPool(): SeedDemoPool {
    return {
      async connect(): Promise<SeedDemoPoolClient> {
        const app = new Client({
          host: container.getHost(),
          port: container.getMappedPort(5432),
          database: container.getDatabase(),
          user: "nominara_app",
          password: resolvePassword("nominara_app", {}),
        });
        await app.connect();
        return Object.assign(app, { release: () => void app.end() });
      },
      async end() {
        // Nothing to do — every `connect()` opens and releases its own
        // connection, matching how `runSeedDemo` uses a pool: one
        // `connect()`/`release()` pair per invocation.
      },
    };
  }

  async function createWorkspace(planKey = "business", timezone = "UTC"): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      `INSERT INTO workspaces (name, slug, plan_key, timezone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [`Workspace ${String(seq)}`, `workspace-${String(seq)}-${randomUUID()}`, planKey, timezone],
    );
    return result.rows[0]!.id;
  }

  function collectingLog(): { readonly lines: string[]; readonly log: (line: string) => void } {
    const lines: string[] = [];
    return { lines, log: (line) => lines.push(line) };
  }

  async function projectsOf(workspaceId: string): Promise<Record<string, unknown>[]> {
    const result = await client.query(`SELECT * FROM projects WHERE workspace_id = $1 ORDER BY name`, [workspaceId]);
    return result.rows;
  }

  async function defaultPartitionCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of PARTITIONED_FACT_TABLES) {
      const result = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}_default`);
      counts[table] = Number(result.rows[0]!.n);
    }
    return counts;
  }

  // FR-GD/STORY-169's own worked example — high confidence needs cells_30d
  // >= 120 (`CONFIDENCE_THRESHOLDS.high`). Every entitled engine gets a
  // capture on every day regardless of presence, so cells_30d is exactly
  // `promptsPerProject * entitledEngines * 30` — deterministic, not
  // probabilistic. `promptsPerProject: 2` clears it for every real plan
  // (growth's 4 engines: 2*4*30=240; business's 6: 2*6*30=360) while keeping
  // the test fast.
  const FAST_OPTIONS = { windowDays: 60, promptsPerProject: 2 };

  it("STORY-169 · seeds a workspace with no projects: creates the 3 fixtures and fills every contract-A field", async () => {
    const workspaceId = await createWorkspace("business");
    const { log } = collectingLog();

    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log }, FAST_OPTIONS);

    const projects = await projectsOf(workspaceId);
    expect(projects).toHaveLength(3);
    expect(projects.map((p) => p.name).sort()).toEqual(["HubSpot CRM", "Stripe Payments", "Zendesk Service Hub"]);

    for (const project of projects) {
      expect(project.demo_seeded_at, `${String(project.name)}.demo_seeded_at`).not.toBeNull();
      expect(project.visibility_blended, `${String(project.name)}.visibility_blended`).not.toBeNull();
      expect(project.visibility_delta_30d, `${String(project.name)}.visibility_delta_30d`).not.toBeNull();
      expect(project.rendering_quality, `${String(project.name)}.rendering_quality`).not.toBeNull();
      expect(project.rendering_delta_30d, `${String(project.name)}.rendering_delta_30d`).not.toBeNull();
      expect(project.sentiment_score, `${String(project.name)}.sentiment_score`).not.toBeNull();
      expect(project.sentiment_delta_30d, `${String(project.name)}.sentiment_delta_30d`).not.toBeNull();
      expect(project.aux_score_current, `${String(project.name)}.aux_score_current`).not.toBeNull();
      expect(project.source_coverage, `${String(project.name)}.source_coverage`).not.toBeNull();
      expect(project.open_task_count, `${String(project.name)}.open_task_count`).toBeGreaterThanOrEqual(5);
      expect(project.visibility_by_engine, `${String(project.name)}.visibility_by_engine`).not.toBeNull();
      expect(Object.keys(project.visibility_by_engine as Record<string, unknown>)).toHaveLength(6); // business = 6 entitled engines
      expect(project.sparkline_30d, `${String(project.name)}.sparkline_30d`).toHaveLength(30);
      // confidenceFor(cells_30d) — "high" at >= 120, the same threshold the
      // read-time API applies (src/lib/scoring/visibility.ts).
      expect(Number(project.cells_30d), `${String(project.name)}.cells_30d`).toBeGreaterThanOrEqual(120);

      const severities = project.open_tasks_by_severity as { critical: number; high: number; medium: number; low: number };
      const bucketed = severities.critical + severities.high + severities.medium + severities.low;
      // AUX-R-001 is ALWAYS a critical finding-linked task; open_task_count
      // legitimately exceeds the severity buckets (the generic filler tasks
      // derive no severity) — both must hold.
      expect(severities.critical, `${String(project.name)}.open_tasks_by_severity.critical`).toBeGreaterThanOrEqual(1);
      expect(bucketed).toBeLessThanOrEqual(Number(project.open_task_count));
    }
  }, 120_000);

  it("STORY-169 · a second workspace is untouched", async () => {
    const targetWorkspaceId = await createWorkspace("business");
    const otherWorkspaceId = await createWorkspace("growth");
    const otherProject = await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, status)
       VALUES ($1,'Untouched','untouched-project','https://untouched.example','untouched.example','active')
       RETURNING id`,
      [otherWorkspaceId],
    );

    await runSeedDemo(
      { workspaceId: targetWorkspaceId, purge: false },
      { ownerClient: client, pool: testPool(), log: () => {} },
      FAST_OPTIONS,
    );

    const otherProjects = await projectsOf(otherWorkspaceId);
    expect(otherProjects).toHaveLength(1);
    expect(otherProjects[0]!.id).toBe(otherProject.rows[0]!.id);
    expect(otherProjects[0]!.demo_seeded_at).toBeNull();
    expect(otherProjects[0]!.visibility_blended).toBeNull();

    const captures = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM answer_captures WHERE workspace_id = $1`, [
      otherWorkspaceId,
    ]);
    expect(Number(captures.rows[0]!.n)).toBe(0);

    const otherWallet = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM credit_wallets WHERE workspace_id = $1`, [
      otherWorkspaceId,
    ]);
    expect(Number(otherWallet.rows[0]!.n)).toBe(0);
  }, 120_000);

  it("STORY-169 · a re-run without --purge is idempotent — no doubled cells", async () => {
    const workspaceId = await createWorkspace("growth");

    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);
    const firstProjects = await projectsOf(workspaceId);
    expect(firstProjects).toHaveLength(3);
    const projectId = firstProjects[0]!.id as string;

    async function countOf(table: string, id: string): Promise<number> {
      const result = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE project_id = $1`, [id]);
      return Number(result.rows[0]!.n);
    }

    // Sequential, deliberately — `client` is a single `pg.Client`, and
    // concurrent queries on one connection are a deprecated pattern (pg
    // itself warns on it) rather than real parallelism.
    async function countsFor(id: string): Promise<Record<string, number>> {
      return {
        captures: await countOf("answer_captures", id),
        mentions: await countOf("mention_facts", id),
        citations: await countOf("citation_facts", id),
        tasks: await countOf("tasks", id),
        findings: await countOf("aux_findings", id),
        sources: await countOf("project_source_index", id),
      };
    }

    const before = await countsFor(projectId);

    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);

    const secondProjects = await projectsOf(workspaceId);
    expect(secondProjects, "a re-run must not create MORE projects").toHaveLength(3);

    const after = await countsFor(projectId);
    expect(after).toEqual(before);
  }, 180_000);

  it("STORY-169 · no row lands in a *_default partition", async () => {
    const workspaceId = await createWorkspace("business");
    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);

    const defaults = await defaultPartitionCounts();
    for (const [table, count] of Object.entries(defaults)) {
      expect(count, `${table}_default`).toBe(0);
    }
  }, 120_000);

  it("STORY-169 · --purge deletes a seed-created project and nulls out a pre-existing one, and never touches the wallet", async () => {
    const workspaceId = await createWorkspace("growth");
    const preExisting = await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, status)
       VALUES ($1,'Real Project','real-project','https://real.example','real.example','active')
       RETURNING id`,
      [workspaceId],
    );
    const preExistingId = preExisting.rows[0]!.id;

    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);

    const seededProjects = await projectsOf(workspaceId);
    // The one pre-existing project plus 2 new fixtures — `min(3,
    // projects.max)`, and growth's plan entitlement is >= 3.
    expect(seededProjects).toHaveLength(3);
    const seededPreExisting = seededProjects.find((p) => p.id === preExistingId)!;
    expect(seededPreExisting.demo_seeded_at).not.toBeNull();
    expect(seededPreExisting.visibility_blended).not.toBeNull();

    const walletBefore = await readWallet(client, workspaceId);
    expect(walletBefore).not.toBeNull();

    await runSeedDemo({ workspaceId, purge: true }, { ownerClient: client, pool: testPool(), log: () => {} });

    const afterPurge = await projectsOf(workspaceId);
    // Only the pre-existing project survives; every seed-created one is gone.
    expect(afterPurge.map((p) => p.id)).toEqual([preExistingId]);
    const purgedPreExisting = afterPurge[0]!;
    expect(purgedPreExisting.demo_seeded_at).toBeNull();
    expect(purgedPreExisting.visibility_blended).toBeNull();
    expect(purgedPreExisting.visibility_delta_30d).toBeNull();
    expect(purgedPreExisting.rendering_quality).toBeNull();
    expect(purgedPreExisting.aux_score_current).toBeNull();
    expect(purgedPreExisting.source_coverage).toBeNull();
    expect(purgedPreExisting.open_task_count).toBe(0);
    expect((purgedPreExisting.open_tasks_by_severity as { critical: number }).critical).toBe(0);

    const remainingTasks = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM tasks WHERE project_id = $1`, [
      preExistingId,
    ]);
    expect(Number(remainingTasks.rows[0]!.n)).toBe(0);
    const remainingFindings = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM aux_findings WHERE project_id = $1`,
      [preExistingId],
    );
    expect(Number(remainingFindings.rows[0]!.n)).toBe(0);
    const remainingCaptures = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM answer_captures WHERE project_id = $1`,
      [preExistingId],
    );
    expect(Number(remainingCaptures.rows[0]!.n)).toBe(0);

    // Not reversible, and the story is explicit that --purge must not try:
    // the wallet and its ledger are untouched.
    const walletAfter = await readWallet(client, workspaceId);
    expect(walletAfter).toEqual(walletBefore);
    const ledgerCount = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM credit_ledger WHERE workspace_id = $1`, [
      workspaceId,
    ]);
    expect(Number(ledgerCount.rows[0]!.n)).toBeGreaterThan(0);
  }, 180_000);

  it("STORY-169 · provisions a wallet through the real grant path, and leaves an existing one alone", async () => {
    const workspaceId = await createWorkspace("business");
    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);

    const wallet = await readWallet(client, workspaceId);
    expect(wallet).not.toBeNull();
    expect(wallet!.includedBalance).toBeGreaterThan(0);

    const ledger = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'grant'`,
      [workspaceId],
    );
    expect(Number(ledger.rows[0]!.n)).toBe(1);

    // Re-running must not re-provision or re-grant.
    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);
    const walletAgain = await readWallet(client, workspaceId);
    expect(walletAgain).toEqual(wallet);
    const ledgerAgain = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'grant'`,
      [workspaceId],
    );
    expect(Number(ledgerAgain.rows[0]!.n)).toBe(1);
  }, 180_000);

  it("STORY-169 · the guard refuses a non-local target and production, even against a real database", () => {
    // No hazard here is specific to a live connection — `assertDemoSeedAllowed`
    // is pure — but the story's own Integration-test bullet names this
    // explicitly, so it is asserted again here rather than only in the unit
    // spec, alongside the real database this whole file exercises.
    expect(() =>
      assertDemoSeedAllowed({
        nodeEnv: "production",
        databaseUrl: `postgres://nominara:nominara@${container.getHost()}:${String(container.getMappedPort(5432))}/${container.getDatabase()}`,
        databaseUrlPooled: `postgres://nominara_app:x@${container.getHost()}:${String(container.getMappedPort(5432))}/${container.getDatabase()}`,
        optIn: "1",
      }),
    ).toThrow(DemoSeedRefusedError);

    expect(() =>
      assertDemoSeedAllowed({
        nodeEnv: "development",
        databaseUrl: "postgres://u:p@db.production.internal:5432/nominara",
        databaseUrlPooled: "postgres://u:p@db.production.internal:6432/nominara",
        optIn: "1",
      }),
    ).toThrow(DemoSeedRefusedError);
  });
});
