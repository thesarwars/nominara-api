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

  /**
   * STORY-169 review (minor) — stands in for a misconfigured
   * `DATABASE_URL_POOLED` that names the migration OWNER (superuser,
   * BYPASSRLS) instead of `nominara_app`. `runSeedDemo` must refuse before
   * any tenant write, the same way `test/isolation/assertions/iso-00-anti-
   * vacuity.ts` refuses to trust anything else it asserts over a
   * superuser connection.
   */
  function superuserPool(): SeedDemoPool {
    return {
      async connect(): Promise<SeedDemoPoolClient> {
        const superuser = new Client({ connectionString: container.getConnectionUri() });
        await superuser.connect();
        return Object.assign(superuser, { release: () => void superuser.end() });
      },
      async end() {},
    };
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

  it("STORY-169 review · a critical AUX-finding task (AUX-R-001) carries no fabricated playbook_slug, so it resolves to copy_patch, not open_playbook", async () => {
    // The exact review violation: the seed used to set `playbook_slug =
    // fix-aux-r-001` on EVERY AUX-finding task, and `derivePrimaryAction`
    // (tasks.service.ts) checks `playbook_slug` BEFORE `source_finding_id`
    // — so the critical robots.txt row resolved to `open_playbook`, target
    // a slug no real playbook has, instead of `copy_patch` against the
    // finding's own `suggested_fix` (FR-AX-04).
    const workspaceId = await createWorkspace("business");
    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);

    const rows = await client.query<{ playbook_slug: string | null; source_finding_id: string | null }>(
      `SELECT t.playbook_slug, t.source_finding_id
         FROM tasks t
         JOIN aux_findings af ON af.id = t.source_finding_id
        WHERE t.workspace_id = $1 AND af.rule_code = 'AUX-R-001'`,
      [workspaceId],
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows.rows) {
      expect(row.source_finding_id).not.toBeNull();
      expect(row.playbook_slug).toBeNull();
    }
  }, 120_000);

  it("STORY-169 review · an authority task's playbook_slug comes from source_domains.seeding_playbook_slug, never a fabricated literal", async () => {
    // The exact review violation: EVERY `TG-SOURCE-ABSENCE` authority task
    // carried the hardcoded literal `playbook_slug = 'seed-source-domain'`
    // — a slug no `source_domains` row, and no playbook catalog, has ever
    // defined. The fix reads `source_domains.seeding_playbook_slug` (set on
    // the seeded rows themselves) instead of inventing one.
    const workspaceId = await createWorkspace("business");
    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);

    const rows = await client.query<{
      task_playbook_slug: string | null;
      domain_playbook_slug: string | null;
      task_id: string;
    }>(
      `SELECT t.playbook_slug AS task_playbook_slug, sd.seeding_playbook_slug AS domain_playbook_slug, t.id AS task_id
         FROM tasks t
         JOIN source_domains sd ON sd.id = t.source_domain_id
        WHERE t.workspace_id = $1 AND t.rule_code = 'TG-SOURCE-ABSENCE'`,
      [workspaceId],
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows.rows) {
      // Never the fabricated literal the review found.
      expect(row.task_playbook_slug).not.toBe("seed-source-domain");
      // Exactly what the LINKED source_domains row carries — null included,
      // never a value the seed invented independently of that row.
      expect(row.task_playbook_slug).toBe(row.domain_playbook_slug);
    }
  }, 120_000);

  it("STORY-169 review · seeded gap_severity matches scoring-models.md §5 — critical/high only on a seedable domain, never on brand-present rows", async () => {
    // The exact review violation: `gap_severity` used to be picked at
    // random, independent of `context_weight`/`is_seedable`, so a
    // non-seedable encyclopedic/news domain could come back `critical` and
    // generate a `TG-SOURCE-ABSENCE` authority task for a domain §5 says
    // must never get one.
    const workspaceId = await createWorkspace("business");
    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);

    const rows = await client.query<{
      gap_severity: string;
      is_seedable: boolean;
      brand_present_on_domain: boolean;
      context_weight: string;
    }>(
      `SELECT psi.gap_severity, sd.is_seedable, psi.brand_present_on_domain, psi.context_weight::text
         FROM project_source_index psi
         JOIN source_domains sd ON sd.id = psi.source_domain_id
         JOIN projects p ON p.id = psi.project_id
        WHERE p.workspace_id = $1`,
      [workspaceId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);

    let sawCritical = false;
    let sawHigh = false;
    for (const row of rows.rows) {
      if (row.gap_severity === "critical" || row.gap_severity === "high") {
        expect(row.is_seedable, `${row.gap_severity} gap on a non-seedable domain`).toBe(true);
        expect(row.brand_present_on_domain, `${row.gap_severity} gap with the brand present`).toBe(false);
        if (row.gap_severity === "critical") sawCritical = true;
        if (row.gap_severity === "high") sawHigh = true;
      }
      if (row.gap_severity === "none") {
        // §5: 'none' is either brand-present, or (only reachable when NOT
        // present) a zero context weight — never a positive weight left
        // unclassified.
        expect(row.brand_present_on_domain === true || Number(row.context_weight) === 0).toBe(true);
      }
    }
    // "at least one critical and one high, always" — per project.
    const projectCount = await client.query<{ n: string }>(
      `SELECT count(DISTINCT project_id)::text AS n FROM project_source_index psi
         JOIN projects p ON p.id = psi.project_id WHERE p.workspace_id = $1`,
      [workspaceId],
    );
    expect(sawCritical).toBe(true);
    expect(sawHigh).toBe(true);
    expect(Number(projectCount.rows[0]!.n)).toBe(3);
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

  it("STORY-060 · every seeded mention row carries its answer's form, and one answer has exactly one form", async () => {
    const workspaceId = await createWorkspace("growth");
    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);
    const unclassified = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM mention_facts WHERE workspace_id = $1 AND answer_form IS NULL`,
      [workspaceId],
    );
    expect(Number(unclassified.rows[0]!.n)).toBe(0);
    const split = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (SELECT result_id FROM mention_facts WHERE workspace_id = $1
        GROUP BY result_id HAVING count(DISTINCT answer_form) > 1) t`,
      [workspaceId],
    );
    expect(Number(split.rows[0]!.n)).toBe(0);
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

  // STORY-169 review, PROBE C — `--purge`'s first version ran
  // `DELETE FROM metric_daily WHERE project_id = $1` unconditionally, which
  // for a pre-existing project destroyed real rollup history OUTSIDE the
  // seed's own 60-day window, and left the seed's own `tracked_prompts`
  // and `competitors` behind with nothing marking them as the seed's.
  it("STORY-169 review · --purge on a PRE-EXISTING project keeps its real metric_daily history and real competitor, and removes only the prompts the seed itself inserted", async () => {
    const workspaceId = await createWorkspace("growth");
    const project = await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, status)
       VALUES ($1,'Real Project','real-project-c','https://real-c.example','real-c.example','active')
       RETURNING id`,
      [workspaceId],
    );
    const projectId = project.rows[0]!.id;

    // A REAL rollup row, 90 days before today — well outside the seed's own
    // 60-day backfill window, so it is untouched by anything the seed
    // itself ever writes.
    await client.query(
      `INSERT INTO metric_daily
         (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date,
          cells_total, cells_present, presence_rate, sov, visibility_score, scoring_version)
       VALUES ($1,$2,'all','brand',$2, (CURRENT_DATE - 90), 5, 3, 0.6, 0.4, 42.5, 'v1')`,
      [workspaceId, projectId],
    );

    // A REAL competitor and a REAL tracked prompt — neither carries any
    // demo marker, and the prompt's text is deliberately outside every
    // DEMO_PROMPT_TEMPLATES string so it can never collide by text_hash.
    const realCompetitor = await client.query<{ id: string }>(
      `INSERT INTO competitors (workspace_id, project_id, name, root_domain, aliases, source)
       VALUES ($1,$2,'Real Competitor Co','real-competitor.example',ARRAY[]::text[],'user')
       RETURNING id`,
      [workspaceId, projectId],
    );
    const realPrompt = await client.query<{ id: string }>(
      `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status)
       VALUES ($1,$2,'a hand-written prompt only a real customer would type',sha256('a hand-written prompt only a real customer would type'::bytea),'custom','decision','active')
       RETURNING id`,
      [workspaceId, projectId],
    );

    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);

    const demoPromptsBefore = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tracked_prompts WHERE project_id = $1 AND generator_meta ->> 'demo_seed_marker' = 'demo-seed'`,
      [projectId],
    );
    expect(Number(demoPromptsBefore.rows[0]!.n)).toBeGreaterThan(0);

    await runSeedDemo({ workspaceId, purge: true }, { ownerClient: client, pool: testPool(), log: () => {} });

    // The real, 90-day-old rollup row survives byte-for-byte.
    const realRow = await client.query<{ cells_total: number; visibility_score: string }>(
      `SELECT cells_total, visibility_score::text FROM metric_daily
        WHERE project_id = $1 AND metric_date = (CURRENT_DATE - 90) AND engine_key = 'all' AND entity_type = 'brand'`,
      [projectId],
    );
    expect(realRow.rows).toHaveLength(1);
    expect(realRow.rows[0]!.cells_total).toBe(5);
    expect(Number(realRow.rows[0]!.visibility_score)).toBeCloseTo(42.5, 3);

    // Only the demo-window days are gone — the seed's own facts, and
    // whatever the seed re-rolled from them, never the day 90 days back.
    const demoWindowRows = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM metric_daily
        WHERE project_id = $1 AND metric_date >= (CURRENT_DATE - 59)`,
      [projectId],
    );
    expect(Number(demoWindowRows.rows[0]!.n)).toBe(0);

    // The real competitor survives — untouched by anything `--purge` does
    // (competitors carry no demo marker at all, a known, documented gap).
    const competitorStillThere = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM competitors WHERE id = $1 AND deleted_at IS NULL`,
      [realCompetitor.rows[0]!.id],
    );
    expect(Number(competitorStillThere.rows[0]!.n)).toBe(1);

    // The real prompt survives, by id.
    const realPromptStillThere = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tracked_prompts WHERE id = $1 AND deleted_at IS NULL`,
      [realPrompt.rows[0]!.id],
    );
    expect(Number(realPromptStillThere.rows[0]!.n)).toBe(1);

    // Every demo-marked prompt is gone.
    const demoPromptsAfter = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tracked_prompts WHERE project_id = $1 AND generator_meta ->> 'demo_seed_marker' = 'demo-seed'`,
      [projectId],
    );
    expect(Number(demoPromptsAfter.rows[0]!.n)).toBe(0);

    // `prompts_active` reflects reality again — the real prompt only.
    const projectRow = await client.query<{ prompts_active: number }>(`SELECT prompts_active FROM projects WHERE id = $1`, [
      projectId,
    ]);
    expect(projectRow.rows[0]!.prompts_active).toBe(1);
  }, 180_000);

  // STORY-169 review — `prompts_cap` used to be left at whatever
  // `ensurePrompts` wrote during the seed run; `--purge` never touched it.
  // Asserting the SAME cap after purge (growth's own 40) would pass even
  // without the fix, since nothing changes the workspace's entitlement in
  // between — the fix and its absence would write the SAME number. This
  // test tells them apart by changing the PLAN between seed and purge, so
  // only a REAL recomputation, not a leftover value, can match afterward.
  it("STORY-169 review · --purge recomputes prompts_cap from the CURRENT entitlement, not a value left over from the seed run", async () => {
    const workspaceId = await createWorkspace("growth"); // prompts.max_per_project = 40
    const project = await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, status)
       VALUES ($1,'Real Project','real-project-cap','https://real-cap.example','real-cap.example','active')
       RETURNING id`,
      [workspaceId],
    );
    const projectId = project.rows[0]!.id;

    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);

    const afterSeed = await client.query<{ prompts_cap: number }>(`SELECT prompts_cap FROM projects WHERE id = $1`, [projectId]);
    expect(afterSeed.rows[0]!.prompts_cap).toBe(40);

    // Downgrade the WORKSPACE's plan after seeding, before purging —
    // starter's `prompts.max_per_project` is 30 (migration 0002). The
    // seed-time cap of 40 is now stale.
    await client.query(`UPDATE workspaces SET plan_key = 'starter' WHERE id = $1`, [workspaceId]);

    await runSeedDemo({ workspaceId, purge: true }, { ownerClient: client, pool: testPool(), log: () => {} });

    // Recomputed from the CURRENT (starter) entitlement — 30, never the
    // stale 40 a purge that skips this recomputation would leave in place.
    const afterPurge = await client.query<{ prompts_cap: number }>(`SELECT prompts_cap FROM projects WHERE id = $1`, [projectId]);
    expect(afterPurge.rows[0]!.prompts_cap).toBe(30);
  }, 180_000);

  // STORY-169 re-audit, PROBE G — the test above never catches the
  // `deleteExistingDemoFacts` timezone bug, because its workspace is UTC:
  // `captured_at >= $2::date` casts `$2` to midnight in the SESSION's
  // timezone, which only diverges from the WORKSPACE's own local midnight
  // (what `earliestDay` actually means) on a workspace at UTC+13 or above,
  // where local noon on the earliest window day is still the PRIOR day in
  // UTC. Pacific/Kiritimati is a fixed +14 offset year-round — deterministic,
  // no DST edge to chase. Two things break without the fix: a same-day
  // re-run duplicates the earliest day's facts (never deleted, so re-insert
  // doubles them), and `--purge` leaves that day's demo-marked facts behind
  // on a real project — unmarked synthetic data past the point `--purge`
  // claims to have removed it.
  it("STORY-169 re-audit · on a UTC+14 pre-existing project, a re-seed does not duplicate facts and --purge removes every demo-marked one", async () => {
    const workspaceId = await createWorkspace("growth", "Pacific/Kiritimati");
    const project = await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, status)
       VALUES ($1,'Real Project','real-project-g','https://real-g.example','real-g.example','active')
       RETURNING id`,
      [workspaceId],
    );
    const projectId = project.rows[0]!.id;

    // A REAL rollup row, 90 days before today — well outside the seed's own
    // 60-day backfill window, so it is untouched by anything the seed does.
    await client.query(
      `INSERT INTO metric_daily
         (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date,
          cells_total, cells_present, presence_rate, sov, visibility_score, scoring_version)
       VALUES ($1,$2,'all','brand',$2, (CURRENT_DATE - 90), 5, 3, 0.6, 0.4, 42.5, 'v1')`,
      [workspaceId, projectId],
    );

    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);

    const capturesAfterFirstSeed = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM answer_captures WHERE project_id = $1 AND normalizer_version = 'demo-seed'`,
      [projectId],
    );
    expect(Number(capturesAfterFirstSeed.rows[0]!.n)).toBeGreaterThan(0);

    // Re-run, same day — idempotent means the SAME demo capture count, not
    // the earliest window day's facts doubled up.
    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);
    const capturesAfterReSeed = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM answer_captures WHERE project_id = $1 AND normalizer_version = 'demo-seed'`,
      [projectId],
    );
    expect(Number(capturesAfterReSeed.rows[0]!.n)).toBe(Number(capturesAfterFirstSeed.rows[0]!.n));

    await runSeedDemo({ workspaceId, purge: true }, { ownerClient: client, pool: testPool(), log: () => {} });

    // Every demo-marked capture is gone — none left behind on the earliest
    // window day (or any other), unmarked, on a REAL project.
    const capturesAfterPurge = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM answer_captures WHERE project_id = $1 AND normalizer_version = 'demo-seed'`,
      [projectId],
    );
    expect(Number(capturesAfterPurge.rows[0]!.n)).toBe(0);

    // No metric_daily row survives inside the seed's own 60-day window —
    // the real 90-day-old row is the only history left.
    const demoWindowRows = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM metric_daily WHERE project_id = $1 AND metric_date >= (CURRENT_DATE - 59)`,
      [projectId],
    );
    expect(Number(demoWindowRows.rows[0]!.n)).toBe(0);

    const realRow = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM metric_daily
        WHERE project_id = $1 AND metric_date = (CURRENT_DATE - 90) AND engine_key = 'all' AND entity_type = 'brand'`,
      [projectId],
    );
    expect(Number(realRow.rows[0]!.n)).toBe(1);

    // The real project's own denormalised score is not a leftover synthetic
    // one — the demo marker was cleared with everything else.
    const projectRow = await client.query<{ demo_seeded_at: string | null }>(
      `SELECT demo_seeded_at FROM projects WHERE id = $1`,
      [projectId],
    );
    expect(projectRow.rows[0]!.demo_seeded_at).toBeNull();
  }, 180_000);

  // STORY-169 review, PROBE E — the seed's first version counted only
  // `status = 'active'` projects against `projects.max`, and never checked
  // `prompts.max_per_project`/`prompts.max_total`/`competitors.max_per_project`
  // at all, so it could push a workspace and a project past its own plan's
  // caps. growth's real entitlements (migration 0002): `projects.max = 3`,
  // `prompts.max_per_project = 40`.
  it("STORY-169 review · never exceeds the plan's project cap or a project's prompt cap", async () => {
    const workspaceId = await createWorkspace("growth");

    await client.query(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, status)
       VALUES ($1,'Paused','paused-e','https://paused-e.example','paused-e.example','paused')`,
      [workspaceId],
    );
    await client.query(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, status)
       VALUES ($1,'Initializing','init-e','https://init-e.example','init-e.example','initializing')`,
      [workspaceId],
    );
    const active = await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, status)
       VALUES ($1,'Active At Cap','active-e','https://active-e.example','active-e.example','active')
       RETURNING id`,
      [workspaceId],
    );
    const activeProjectId = active.rows[0]!.id;

    // Fill the active project's prompt cap exactly (growth: 40 per project).
    // `text` bound twice ($3 and $4) rather than reusing $3 under a
    // `::bytea` cast — same parser limitation `facts.ts`'s `ensurePrompts`
    // already documents ("inconsistent types deduced for parameter $N").
    for (let i = 0; i < 40; i += 1) {
      const text = `pre-existing prompt number ${String(i)}`;
      await client.query(
        `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status)
         VALUES ($1,$2,$3,sha256($4::bytea),'custom','decision','active')`,
        [workspaceId, activeProjectId, text, text],
      );
    }

    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);

    // projects.max = 3: the paused + initializing + active-at-cap projects
    // already occupy every slot (ANY status counts, per structural-usage.ts)
    // — the seed must create NONE of its three fixtures.
    const allProjects = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL`,
      [workspaceId],
    );
    expect(Number(allProjects.rows[0]!.n)).toBe(3);
    const fixtureNames = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM projects WHERE workspace_id = $1 AND name IN ('HubSpot CRM','Stripe Payments','Zendesk Service Hub')`,
      [workspaceId],
    );
    expect(Number(fixtureNames.rows[0]!.n)).toBe(0);

    // The active project was already AT its 40-prompt cap — the seed must
    // add none (it is one of the seed's own three targets, since it is
    // `status = 'active'`).
    const slotOccupyingPrompts = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tracked_prompts
        WHERE project_id = $1 AND status <> 'archived' AND deleted_at IS NULL`,
      [activeProjectId],
    );
    expect(Number(slotOccupyingPrompts.rows[0]!.n)).toBe(40);
  }, 180_000);

  // STORY-169 review — PROBE C above proves a REAL fact OUTSIDE the demo
  // window survives `--purge` byte-for-byte, but its own real row sits 90
  // days back, so it never exercises purge.ts's RE-ROLL half at all: a day
  // INSIDE the demo window that ALSO carries a real fact. This is the
  // headline behaviour commit 9e45f54's message claims ("re-roll real
  // metric_daily on --purge") and, before this test, nothing could catch a
  // regression in it — a blanket `DELETE FROM metric_daily` for the whole
  // range (the pre-review defect) and a purge that skips the re-roll
  // entirely (leaving the demo-inflated row in place) both produce
  // DIFFERENT wrong answers than the real-only re-roll, and this test tells
  // all three apart.
  it("STORY-169 review · --purge re-rolls a day with a REAL fact inside the demo window to its real-only value, and drops rows for demo-only days", async () => {
    const workspaceId = await createWorkspace("growth");
    const project = await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, status)
       VALUES ($1,'Real Project','real-project-h','https://real-h.example','real-h.example','active')
       RETURNING id`,
      [workspaceId],
    );
    const projectId = project.rows[0]!.id;

    // A REAL prompt and a REAL, present `chatgpt` capture, on a fixed
    // calendar day well INSIDE the seed's 60-day window (today - 5) —
    // never derived from `now()` at test-run time, so it cannot flake
    // across a UTC midnight boundary.
    const realPrompt = await client.query<{ id: string }>(
      `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status)
       VALUES ($1,$2,'a real customer prompt no demo template ever produces',
               sha256('a real customer prompt no demo template ever produces'::bytea),'custom','decision','active')
       RETURNING id`,
      [workspaceId, projectId],
    );
    await client.query(
      `INSERT INTO answer_captures
         (workspace_id, project_id, run_id, prompt_id, engine_key, sample_index, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash, payload,
          brand_present, sov, sentiment_label, status)
       VALUES ($1,$2,gen_random_uuid(),$3,'chatgpt',0,
               ((CURRENT_DATE - 5)::timestamp + interval '10 hours')::timestamptz,
               'api','1.0.0','real-capture-h',sha256('real-capture-h'::bytea),'{}'::jsonb,
               true,0.5,'positive','parsed')`,
      [workspaceId, projectId, realPrompt.rows[0]!.id],
    );

    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);

    // Before purge: the mixed day's `all`-engine rollup combines the real
    // cell with the seed's own demo cells for that same day — strictly
    // more than the real fact's own count of 1.
    const beforePurge = await client.query<{ cells_total: string }>(
      `SELECT cells_total::text FROM metric_daily
        WHERE project_id = $1 AND metric_date = (CURRENT_DATE - 5) AND engine_key = 'all' AND entity_type = 'brand'`,
      [projectId],
    );
    expect(beforePurge.rows).toHaveLength(1);
    expect(Number(beforePurge.rows[0]!.cells_total)).toBeGreaterThan(1);

    await runSeedDemo({ workspaceId, purge: true }, { ownerClient: client, pool: testPool(), log: () => {} });

    // Re-rolled, not blanket-deleted and not left at its demo-inflated
    // value: the mixed day KEEPS a row, now computed from the real fact
    // ALONE.
    const afterPurgeMixedDay = await client.query<{ cells_total: string }>(
      `SELECT cells_total::text FROM metric_daily
        WHERE project_id = $1 AND metric_date = (CURRENT_DATE - 5) AND engine_key = 'all' AND entity_type = 'brand'`,
      [projectId],
    );
    expect(afterPurgeMixedDay.rows).toHaveLength(1);
    expect(Number(afterPurgeMixedDay.rows[0]!.cells_total)).toBe(1);

    // The real capture itself survives purge, untouched.
    const realCaptureStillThere = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM answer_captures WHERE project_id = $1 AND normalizer_version = 'real-capture-h'`,
      [projectId],
    );
    expect(Number(realCaptureStillThere.rows[0]!.n)).toBe(1);

    // A demo-ONLY day (no real fact at all, today - 10) inside the same
    // window loses its row entirely — never left behind, and never
    // recreated from nothing.
    const demoOnlyDayRow = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM metric_daily WHERE project_id = $1 AND metric_date = (CURRENT_DATE - 10)`,
      [projectId],
    );
    expect(Number(demoOnlyDayRow.rows[0]!.n)).toBe(0);
  }, 180_000);

  // STORY-169 re-audit — `structuralCap`/`projectsMaxCap` mapped ANY
  // non-number (including `null`/`false`) to `Infinity`, "no numeric
  // ceiling". `classification.ts`'s own `structuralLimitFrom` — the ONE
  // place that knows what a resolved entitlement value means — says the
  // opposite: `null`/`false` mean a FINITE cap of `0`, "no allowance at
  // all", and names `prompts.max_per_project` on the FREE plan (migration
  // 0002) as its own example. So the seed was writing competitors and
  // prompts PAST a cap that should have let it write NONE. `projects.max`
  // on free is `0` too, so this needs a PRE-EXISTING active project — the
  // seed's `ensureDemoProjects` never creates a fixture on this plan, but
  // `listActiveProjects` still targets whatever is already active.
  it("STORY-169 re-audit · on the free plan, adds no competitors and caps prompts at what activation.service would write (0)", async () => {
    const workspaceId = await createWorkspace("free");
    const project = await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, status)
       VALUES ($1,'Free Plan Project','free-plan-project','https://free-plan.example','free-plan.example','active')
       RETURNING id`,
      [workspaceId],
    );
    const projectId = project.rows[0]!.id;

    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);

    const competitors = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM competitors WHERE project_id = $1 AND deleted_at IS NULL`,
      [projectId],
    );
    expect(Number(competitors.rows[0]!.n)).toBe(0);

    const prompts = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tracked_prompts WHERE project_id = $1 AND deleted_at IS NULL`,
      [projectId],
    );
    expect(Number(prompts.rows[0]!.n)).toBe(0);

    const projectRow = await client.query<{ prompts_active: number; prompts_cap: number }>(
      `SELECT prompts_active, prompts_cap FROM projects WHERE id = $1`,
      [projectId],
    );
    // Matches what activation.service.ts's own resolveCap would write for
    // this same entitlement value — a FINITE 0, never the column's
    // smallint-max sentinel `structuralCap` used to fall back to.
    expect(projectRow.rows[0]!.prompts_cap).toBe(0);
    expect(projectRow.rows[0]!.prompts_active).toBe(0);
  }, 180_000);

  // STORY-169 review (minor) — `noonUtc` used to stamp every capture at a
  // bare 12:00 UTC regardless of the workspace's own timezone. For any
  // workspace at UTC+12 through +14, 12:00 UTC already falls on the NEXT
  // local calendar day, so "today"'s facts rolled up under a day
  // `workspaceLocalWindow` never asked for, and "today" itself got no
  // rollup at all. Pacific/Kiritimati is a fixed UTC+14 offset year-round
  // (no DST), which keeps this test deterministic.
  it("STORY-169 review · a UTC+14 workspace's captures land on the correct workspace-local day, not the next one", async () => {
    const workspaceId = await createWorkspace("business", "Pacific/Kiritimati");
    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log: () => {} }, FAST_OPTIONS);

    const projects = await projectsOf(workspaceId);
    expect(projects.length).toBeGreaterThan(0);
    const projectId = projects[0]!.id as string;

    const todayRow = await client.query<{ today: string }>(
      `SELECT to_char((now() AT TIME ZONE 'Pacific/Kiritimati')::date, 'YYYY-MM-DD') AS today`,
    );
    const today = todayRow.rows[0]!.today;

    // A row for TODAY, workspace-local — not shifted a day into the future.
    const todayRollup = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM metric_daily WHERE project_id = $1 AND metric_date = $2::date`,
      [projectId, today],
    );
    expect(Number(todayRollup.rows[0]!.n)).toBeGreaterThan(0);

    // Nothing rolled up for TOMORROW — exactly what the bug produced.
    const tomorrowRollup = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM metric_daily WHERE project_id = $1 AND metric_date = ($2::date + 1)`,
      [projectId, today],
    );
    expect(Number(tomorrowRollup.rows[0]!.n)).toBe(0);

    expect(projects[0]!.visibility_blended).not.toBeNull();
    expect(projects[0]!.demo_seeded_at).not.toBeNull();

    // STORY-169 re-audit — the two assertions above cannot fail without the
    // fix: EVERY day's capture shifts forward by exactly one LOCAL day under
    // the bug (bare UTC noon of calendar day D is already D+1 local at
    // UTC+14), so "today"'s rollup exists anyway (built from yesterday's
    // shifted facts) and "tomorrow" stays empty (the loop below only calls
    // `rollUpDay` for days INSIDE the window, never for "tomorrow" itself —
    // so today's own facts, shifted there, are simply never rolled up, not
    // visibly absent). Mutation-tested: reverting `workspaceLocalWindow` to
    // bare UTC noon (`AT TIME ZONE 'UTC'` instead of the workspace's own
    // timezone) left both assertions above green. These three do not:
    //
    // 1. No demo capture is ever bucketed onto a LOCAL date after today —
    //    under the bug, today's own noon-UTC captures land on tomorrow.
    const futureCaptures = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM answer_captures
        WHERE project_id = $1 AND normalizer_version = 'demo-seed'
          AND (captured_at AT TIME ZONE 'Pacific/Kiritimati')::date > $2::date`,
      [projectId, today],
    );
    expect(Number(futureCaptures.rows[0]!.n)).toBe(0);

    // 2. The distinct LOCAL capture dates are EXACTLY the 60-day window
    //    ending today — under the bug the whole set shifts one day late
    //    (today-58 .. tomorrow), which still has 60 distinct dates but the
    //    wrong ones; this pins the actual dates, not just the count.
    const distinctDates = await client.query<{ d: string }>(
      `SELECT DISTINCT to_char((captured_at AT TIME ZONE 'Pacific/Kiritimati')::date, 'YYYY-MM-DD') AS d
         FROM answer_captures
        WHERE project_id = $1 AND normalizer_version = 'demo-seed'
        ORDER BY d`,
      [projectId],
    );
    const expectedDates = Array.from({ length: FAST_OPTIONS.windowDays }, (_, i) => {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - (FAST_OPTIONS.windowDays - 1 - i));
      return d.toISOString().slice(0, 10);
    });
    expect(distinctDates.rows.map((r) => r.d)).toEqual(expectedDates);

    // 3. The EARLIEST window day (today - 59) has its own metric_daily row —
    //    under the bug this day's captures shift to today-58, and nothing
    //    shifts IN from today-60 (never generated), so today-59 gets none.
    const earliestDay = expectedDates[0]!;
    const earliestRollup = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM metric_daily WHERE project_id = $1 AND metric_date = $2::date`,
      [projectId, earliestDay],
    );
    expect(Number(earliestRollup.rows[0]!.n)).toBeGreaterThan(0);
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

  it("STORY-169 review · a plan with no numeric included grant still gets a wallet ROW, truthfully logged as provisioned (not 'left untouched')", async () => {
    // The exact review violation: `provisionWalletWithGrant` returns
    // `applied: false` whenever `grant === 0` — even though it still
    // CREATES the wallet row, just with no ledger entry to write. Reading
    // `outcome.applied` as "provisioned" made this real, irreversible wallet
    // creation log as "workspace already has a wallet — left untouched.",
    // which is false. `enterprise`'s `credits.included_per_cycle` is the
    // literal string "custom" (plan-entitlements.ts), so `includedGrantOf`
    // resolves it to 0 — a real plan shape, not a synthetic one.
    const workspaceId = await createWorkspace("enterprise");
    const { log, lines } = collectingLog();

    await runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: testPool(), log }, FAST_OPTIONS);

    const wallet = await readWallet(client, workspaceId);
    expect(wallet).not.toBeNull();
    expect(wallet!.includedBalance).toBe(0);

    const ledger = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM credit_ledger WHERE workspace_id = $1`, [
      workspaceId,
    ]);
    expect(Number(ledger.rows[0]!.n)).toBe(0);

    expect(lines.some((line) => line.includes("left untouched"))).toBe(false);
    expect(lines.some((line) => line.includes("0-credit grant"))).toBe(true);
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

  // STORY-169 review (minor) — `assertDemoSeedAllowed` checks hostnames and
  // the opt-in only; it has no way to know which Postgres ROLE
  // `DATABASE_URL_POOLED` authenticates as. A pool that happens to connect
  // as the superuser bypasses RLS for every tenant write this seed makes,
  // silently.
  it("STORY-169 review · refuses to seed when the pooled connection is the superuser, not nominara_app", async () => {
    const workspaceId = await createWorkspace("business");

    await expect(
      runSeedDemo({ workspaceId, purge: false }, { ownerClient: client, pool: superuserPool(), log: () => {} }, FAST_OPTIONS),
    ).rejects.toThrow(DemoSeedRefusedError);

    // Nothing was written — the refusal fires before the FIRST tenant write.
    const projects = await projectsOf(workspaceId);
    expect(projects).toHaveLength(0);
  }, 60_000);

  it("STORY-169 review · the same refusal applies to --purge's pooled connection", async () => {
    const workspaceId = await createWorkspace("business");
    await expect(
      runSeedDemo({ workspaceId, purge: true }, { ownerClient: client, pool: superuserPool(), log: () => {} }),
    ).rejects.toThrow(DemoSeedRefusedError);
  }, 60_000);
});
