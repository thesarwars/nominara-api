import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import { computeTenantTableNames, generateRlsSql, renderTenantTablesModule, TENANT_TABLES_FILE } from "../../src/db/rls/generate.js";
import { introspectTables } from "../../src/db/rls/introspect.js";
import { checkRls, isClean } from "../../src/db/rls/rls-check.js";

// STORY-011 · `pnpm db:rls-check`. Same shared-container / isolated-temp-
// migrations-dir pattern as the rest of this story's integration suite.
// Plants a deliberate breakage per bucket and confirms the RIGHT bucket
// fires — and ONLY that bucket, where the design makes that assertable —
// so this test would actually catch a regression in the checker itself,
// not just in the schema it checks.
describe("STORY-011 · pnpm db:rls-check", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let migrationsDir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    migrationsDir = await mkdtemp(path.join(tmpdir(), "nominara-story011-rlscheck-"));
    for (const name of [
      "0001_extensions_and_conventions",
      "0002_identity_tenancy_billing",
      "0003_projects_prompts_captures",
      "0004_rollups_aux_tasks_geo_tools",
      "0005_roles_grants_and_pooling",
      "0006_generated_rls_policies",
      // STORY-021 — checkRls() now unconditionally expects the two
      // ADR-0001 self-scoped policies once workspace_members/workspaces
      // exist (from 0002), regardless of which later migration created
      // them. Without 0012 here, this fixture is a "0006-only" schema
      // that checkRls (correctly) flags as missing those two policies.
      "0012_actor_self_scoped_membership_policies",
      // STORY-070 — `usage_reservations` is the FIRST tenant table created
      // after 0006 was generated, so it is the first one this fixture's
      // "every migration that creates a tenant table" set does not get for
      // free from 0001-0004. Without it the shadow schema is missing a table
      // that IS in the committed tenant-tables.generated.ts, and the drift
      // assertion below fails for a reason that is not drift.
      "0019_usage_reservations",
    ]) {
      for (const ext of ["up", "down"] as const) {
        const content = await readFile(path.join(MIGRATIONS_DIR, `${name}.${ext}.sql`), "utf8");
        await writeFile(path.join(migrationsDir, `${name}.${ext}.sql`), content);
      }
    }
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    await rm(migrationsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrateUp(client, migrationsDir);
  });

  afterEach(async () => {
    await client.end();
  });

  it("a freshly-migrated database is clean — all SEVEN buckets empty", async () => {
    const result = await checkRls(client);
    // Whole-object equality on purpose: a new bucket that nobody adds here
    // fails this test, which is how the seventh one got noticed at all.
    expect(result).toEqual({
      unclassifiedTables: [],
      missingRls: [],
      missingPolicies: [],
      unexpectedPolicies: [],
      policiesWithoutWithCheck: [],
      globalTablesWithPolicies: [],
      viewsWithoutSecurityInvoker: [],
      unclassifiedRelations: [],
    });
    expect(isClean(result)).toBe(true);
  });

  // Fix pass item 17 — nothing automatically verified the committed
  // migration/generated-file pair actually matches what the generator
  // produces right now. Verified manually by code-reviewer to currently
  // match, but nothing kept it that way — a hand-edit wouldn't be caught by
  // any test (only by db:rls-check's structural comparison, which doesn't
  // run in CI — see gap G-5). This runs the generator against the SAME
  // live, migrated database this whole file already has and asserts the
  // result equals the literal on-disk file content, byte for byte.
  it("fix pass item 17 — the committed 0006_generated_rls_policies.up.sql and tenant-tables.generated.ts both equal what the generator produces right now", async () => {
    const tables = await introspectTables(client);

    const generatedMigration = generateRlsSql(tables);
    const onDiskMigration = await readFile(
      path.join(migrationsDir, "0006_generated_rls_policies.up.sql"),
      "utf8",
    );
    expect(generatedMigration).toBe(onDiskMigration);

    const generatedTenantTables = renderTenantTablesModule(computeTenantTableNames(tables));
    const onDiskTenantTables = await readFile(TENANT_TABLES_FILE, "utf8");
    expect(generatedTenantTables).toBe(onDiskTenantTables);
  });

  it("bucket: unclassifiedTables — a new table with no workspace_id and no GLOBAL_TABLES/TENANT_SCOPE_COLUMN entry", async () => {
    await client.query("CREATE TABLE probe_unclassified (id uuid PRIMARY KEY DEFAULT gen_random_uuid())");
    try {
      const result = await checkRls(client);
      expect(result.unclassifiedTables).toEqual(["probe_unclassified"]);
      // The other buckets are unaffected by this specific breakage.
      expect(result.missingPolicies).toEqual([]);
      expect(result.unexpectedPolicies).toEqual([]);
      expect(result.policiesWithoutWithCheck).toEqual([]);
      expect(result.globalTablesWithPolicies).toEqual([]);
      // An unclassified table's RLS state is undetermined by design — it is
      // reported via unclassifiedTables, not double-counted in missingRls.
      expect(result.missingRls.some((entry) => entry.startsWith("probe_unclassified"))).toBe(false);
    } finally {
      await client.query("DROP TABLE IF EXISTS probe_unclassified");
    }
  });

  it("bucket: missingRls — a tenant table with RLS disabled", async () => {
    await client.query("ALTER TABLE competitors NO FORCE ROW LEVEL SECURITY");
    await client.query("ALTER TABLE competitors DISABLE ROW LEVEL SECURITY");
    try {
      const result = await checkRls(client);
      expect(result.missingRls.some((entry) => entry.startsWith("competitors:"))).toBe(true);
      expect(result.unclassifiedTables).toEqual([]);
      expect(result.globalTablesWithPolicies).toEqual([]);
    } finally {
      await client.query("ALTER TABLE competitors ENABLE ROW LEVEL SECURITY");
      await client.query("ALTER TABLE competitors FORCE ROW LEVEL SECURITY");
    }
  });

  it("bucket: missingPolicies (and unexpectedPolicies stays clean) — dropping a policy outright", async () => {
    await client.query("DROP POLICY ws_isolation_competitors ON competitors");
    try {
      const result = await checkRls(client);
      expect(result.missingPolicies).toContain("competitors.ws_isolation_competitors");
      expect(result.unexpectedPolicies).toEqual([]);
      expect(result.policiesWithoutWithCheck).toEqual([]);
      expect(result.globalTablesWithPolicies).toEqual([]);
      expect(result.unclassifiedTables).toEqual([]);
    } finally {
      // Restore via the exact generated migration body, not a hand-typed policy.
      const sql = await readFile(path.join(migrationsDir, "0006_generated_rls_policies.up.sql"), "utf8");
      await client.query(sql);
    }
  });

  it("bucket: unexpectedPolicies — adding a stray, non-generated policy on a real tenant table", async () => {
    await client.query(
      "CREATE POLICY stray_policy ON competitors FOR SELECT TO nominara_portal USING (true)",
    );
    try {
      const result = await checkRls(client);
      expect(result.unexpectedPolicies).toContain("competitors.stray_policy");
      expect(result.missingPolicies).toEqual([]);
      expect(result.globalTablesWithPolicies).toEqual([]);
    } finally {
      await client.query("DROP POLICY IF EXISTS stray_policy ON competitors");
    }
  });

  it("bucket: globalTablesWithPolicies — a stray policy on a GLOBAL_TABLES entry", async () => {
    await client.query("CREATE POLICY stray_global_policy ON engines FOR SELECT TO nominara_portal USING (true)");
    try {
      const result = await checkRls(client);
      expect(result.globalTablesWithPolicies).toContain("engines.stray_global_policy");
      // A global table's stray policy is NOT scoped into unexpectedPolicies
      // (that bucket only inspects classifiable tenant tables) — the two
      // buckets are deliberately kept separate rather than overlapping.
      expect(result.unexpectedPolicies).toEqual([]);
      expect(result.missingPolicies).toEqual([]);
    } finally {
      await client.query("DROP POLICY IF EXISTS stray_global_policy ON engines");
    }
  });

  // ------------------------------------------------------------------------
  // Fix pass item 1 — partition-CHILD policy CONTENT, not just ENABLE/FORCE
  // flags. Before this fix, checkRls never compared a child's actual policy
  // against its parent's — these three cases each independently prove the
  // gate now catches what the story's own headline finding was about.
  // ------------------------------------------------------------------------

  describe("partition-child policy content (fix pass item 1)", () => {
    async function currentMonthChildOf(parent: string): Promise<string> {
      const result = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_inherits i
           JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class p ON p.oid = i.inhparent
          WHERE p.relname = $1 AND c.relkind = 'r' AND c.relname <> $1 || '_default'
          ORDER BY c.relname
          LIMIT 1`,
        [parent],
      );
      expect(result.rowCount).toBe(1);
      return result.rows[0]!.relname;
    }

    it("(a) a permissive USING (true) / WITH CHECK (true) policy planted directly on a partition child trips unexpectedPolicies AND missingPolicies", async () => {
      const child = await currentMonthChildOf("answer_captures");
      await client.query(`DROP POLICY ws_isolation_${child} ON ${child}`);
      await client.query(
        `CREATE POLICY ws_isolation_${child} ON ${child} FOR ALL TO nominara_app, nominara_worker, nominara_report USING (true) WITH CHECK (true)`,
      );
      try {
        const result = await checkRls(client);
        expect(result.unexpectedPolicies).toContain(`${child}.ws_isolation_${child}`);
        expect(result.missingPolicies).toContain(`${child}.ws_isolation_${child}`);
      } finally {
        await client.query(`DROP POLICY IF EXISTS ws_isolation_${child} ON ${child}`);
        await client.query(`SELECT app.apply_tenant_rls('${child}'::regclass)`);
      }
    });

    it("(b) removing a child's policy entirely while ENABLE/FORCE flags remain trips missingPolicies, NOT missingRls", async () => {
      const child = await currentMonthChildOf("answer_captures");
      await client.query(`DROP POLICY ws_isolation_${child} ON ${child}`);
      try {
        const result = await checkRls(client);
        expect(result.missingPolicies).toContain(`${child}.ws_isolation_${child}`);
        expect(result.missingRls.some((entry) => entry.startsWith(`${child}:`))).toBe(false);
      } finally {
        await client.query(`SELECT app.apply_tenant_rls('${child}'::regclass)`);
      }
    });

    it("(c) a child's policy predicate not matching its parent's (workspace_id swapped for a constant) trips both missingPolicies and unexpectedPolicies", async () => {
      const child = await currentMonthChildOf("answer_captures");
      await client.query(`DROP POLICY ws_isolation_${child} ON ${child}`);
      await client.query(
        `CREATE POLICY ws_isolation_${child} ON ${child} FOR ALL TO nominara_app, nominara_worker, nominara_report
           USING (project_id = app.current_workspace())
           WITH CHECK (project_id = app.current_workspace())`,
      );
      try {
        const result = await checkRls(client);
        expect(result.missingPolicies).toContain(`${child}.ws_isolation_${child}`);
        expect(result.unexpectedPolicies).toContain(`${child}.ws_isolation_${child}`);
      } finally {
        await client.query(`DROP POLICY IF EXISTS ws_isolation_${child} ON ${child}`);
        await client.query(`SELECT app.apply_tenant_rls('${child}'::regclass)`);
      }
    });

    it("a correctly-applied child (via app.apply_tenant_rls) is clean — no false positive", async () => {
      const child = await currentMonthChildOf("answer_captures");
      const result = await checkRls(client);
      expect(result.missingPolicies.some((entry) => entry.startsWith(`${child}.`))).toBe(false);
      expect(result.unexpectedPolicies.some((entry) => entry.startsWith(`${child}.`))).toBe(false);
      expect(result.missingRls.some((entry) => entry.startsWith(`${child}:`))).toBe(false);
    });
  });

  // ------------------------------------------------------------------------
  // Fix pass item 12, "scenario 4b" — the actually-dangerous policy SHAPE
  // AC 23 describes ("the read filter alone would still permit a write that
  // moves a row to another tenant") is separate FOR SELECT / FOR UPDATE
  // policies with a permissive SELECT — a shape this generator never
  // produces, but which rls-check must still be able to detect if it
  // appeared by accident. Confirms unexpectedPolicies fires.
  // ------------------------------------------------------------------------

  it("scenario 4b — a dangerous split FOR SELECT USING(true) / FOR UPDATE WITH CHECK(true) shape trips unexpectedPolicies (and missingPolicies, since the real FOR ALL policy is gone)", async () => {
    await client.query("DROP POLICY ws_isolation_competitors ON competitors");
    await client.query("CREATE POLICY danger_select_competitors ON competitors FOR SELECT TO nominara_app USING (true)");
    await client.query(
      "CREATE POLICY danger_update_competitors ON competitors FOR UPDATE TO nominara_app WITH CHECK (true)",
    );
    try {
      const result = await checkRls(client);
      expect(result.missingPolicies).toContain("competitors.ws_isolation_competitors");
      expect(result.unexpectedPolicies).toContain("competitors.danger_select_competitors");
      expect(result.unexpectedPolicies).toContain("competitors.danger_update_competitors");
    } finally {
      await client.query("DROP POLICY IF EXISTS danger_select_competitors ON competitors");
      await client.query("DROP POLICY IF EXISTS danger_update_competitors ON competitors");
      const sql = await readFile(path.join(migrationsDir, "0006_generated_rls_policies.up.sql"), "utf8");
      await client.query(sql);
    }
  });

  it("bucket: policiesWithoutWithCheck — a hand-edited FOR ALL policy with a NULL with_check", async () => {
    await client.query("DROP POLICY ws_isolation_competitors ON competitors");
    await client.query(
      `CREATE POLICY ws_isolation_competitors ON competitors
         FOR ALL TO nominara_app, nominara_worker, nominara_report
         USING (workspace_id = app.current_workspace())`, // no WITH CHECK — the defect under test
    );
    try {
      const result = await checkRls(client);
      expect(result.policiesWithoutWithCheck).toContain("competitors.ws_isolation_competitors");
    } finally {
      const sql = await readFile(path.join(migrationsDir, "0006_generated_rls_policies.up.sql"), "utf8");
      await client.query("DROP POLICY IF EXISTS ws_isolation_competitors ON competitors");
      await client.query(sql);
    }
  });

  // --------------------------------------------------------------------------
  // STORY-152 — the seventh bucket, and the only one about a relation this
  // check could not previously SEE.
  //
  // ⚠ THIS IS A REAL LEAK THAT THE OTHER SIX CALLED CLEAN. `CENSUS_TABLES_SQL`
  // filters `relkind IN ('r','p')`, `test/isolation/support/discovery.ts` uses
  // the same filter, and ISO-16 inspects `pg_matviews` — so before this bucket
  // existed, a plain view was outside every gate's universe. A view without
  // `security_invoker` executes as its OWNER, the migration role, which
  // bypasses RLS on every base table it reads.
  //
  // The breaker below is the exact reproduction from STORY-152's review: it
  // returned `isClean: true` on a database containing this view granted to all
  // four runtime roles, while the view served every tenant's rows to a caller
  // pinned to one workspace.
  // --------------------------------------------------------------------------

  it("bucket: viewsWithoutSecurityInvoker — a view that bypasses RLS on its base tables", async () => {
    await client.query("CREATE VIEW leaky_probe_view AS SELECT * FROM projects");
    try {
      const result = await checkRls(client);
      expect(
        result.viewsWithoutSecurityInvoker,
        "a view with no reloptions at all must FAIL — unset is the dangerous default, not a pass",
      ).toContain("leaky_probe_view: security_invoker=unset");
      expect(isClean(result), "and it must make the whole check dirty, or the gate still passes").toBe(false);
    } finally {
      await client.query("DROP VIEW IF EXISTS leaky_probe_view");
    }
  });

  it("bucket: viewsWithoutSecurityInvoker — explicitly FALSE is caught too, not just absent", async () => {
    // The one-edit path back to a leak on a view that was created correctly:
    // `ALTER VIEW ... SET (security_invoker = false)` leaves reloptions
    // populated, so a check that merely tested for a non-empty array would
    // pass this.
    await client.query("CREATE VIEW invoker_off_view WITH (security_invoker = false) AS SELECT * FROM projects");
    try {
      const result = await checkRls(client);
      expect(result.viewsWithoutSecurityInvoker).toContain("invoker_off_view: security_invoker=security_invoker=false");
      expect(isClean(result)).toBe(false);
    } finally {
      await client.query("DROP VIEW IF EXISTS invoker_off_view");
    }
  });

  it("⚠ a CORRECT view passes, so the bucket discriminates rather than failing everything", async () => {
    // The anti-vacuity half. Without this, a bucket that reported every view
    // unconditionally would pass both breakers above and be indistinguishable
    // from a working one.
    //
    // A view built here rather than `project_entitled_engines`: this fixture
    // applies a hand-picked migration SUBSET (see beforeAll) and the story's
    // own view is not in it. Building the shape locally tests the property
    // instead of the fixture's migration list, and does not silently start
    // passing for a different reason if that list changes.
    await client.query("CREATE VIEW correct_probe_view WITH (security_invoker = true) AS SELECT * FROM projects");
    try {
      const result = await checkRls(client);
      expect(
        result.viewsWithoutSecurityInvoker,
        "a view carrying security_invoker=true must NOT be reported",
      ).toEqual([]);
      expect(isClean(result)).toBe(true);
    } finally {
      await client.query("DROP VIEW IF EXISTS correct_probe_view");
    }
  });

  // ⚠ `WITH (security_invoker = on)` IS CORRECT AND MUST NOT BE REPORTED.
  // Postgres stores the author's spelling, so a string match on "=true" flags
  // a view that is properly protected. Fail-safe, but a gate that cries wolf
  // is a gate people stop reading.
  it("accepts every spelling Postgres accepts for security_invoker", async () => {
    await client.query("CREATE VIEW v_on WITH (security_invoker = on) AS SELECT * FROM projects");
    await client.query("CREATE VIEW v_bare WITH (security_invoker) AS SELECT * FROM projects");
    await client.query(
      "CREATE VIEW v_barrier WITH (security_barrier = true, security_invoker = true) AS SELECT * FROM projects",
    );
    try {
      const result = await checkRls(client);
      expect(result.viewsWithoutSecurityInvoker, "all three spellings mean true").toEqual([]);
      expect(isClean(result)).toBe(true);
    } finally {
      for (const name of ["v_on", "v_bare", "v_barrier"]) {
        await client.query(`DROP VIEW IF EXISTS ${name}`);
      }
    }
  });

  // ==========================================================================
  // ⚠ THE CLASS, NOT THE INSTANCE.
  //
  // The view hole existed because this module enumerated an allow-list of
  // relkinds and everything else was invisible. Adding views to the list fixed
  // one entry and left the shape — a review then walked ONE RELKIND OVER and
  // did it again with a foreign table, to which RLS does not apply at all.
  // The census is inverted now, and these are its breakers.
  // ==========================================================================
  it("bucket: unclassifiedRelations — a MATERIALIZED view, which has no bucket of its own", async () => {
    await client.query("CREATE MATERIALIZED VIEW mv_probe AS SELECT id, workspace_id FROM projects");
    try {
      const result = await checkRls(client);
      expect(result.unclassifiedRelations).toContain("mv_probe (relkind=m)");
      expect(isClean(result), "ISO-16 forbids these; rls-check must not call one clean").toBe(false);
    } finally {
      await client.query("DROP MATERIALIZED VIEW IF EXISTS mv_probe");
    }
  });

  it("bucket: unclassifiedRelations — a FOREIGN TABLE, which RLS does not apply to at all", async () => {
    // The exact shape a review used to walk around the seventh bucket. There
    // is no policy to be missing and no flag to be unset, so every other
    // bucket is silent by construction.
    await client.query("CREATE EXTENSION IF NOT EXISTS file_fdw");
    await client.query("CREATE SERVER IF NOT EXISTS probe_srv FOREIGN DATA WRAPPER file_fdw");
    await client.query(
      "CREATE FOREIGN TABLE projects_shadow (id uuid, workspace_id uuid) SERVER probe_srv OPTIONS (filename '/dev/null', format 'csv')",
    );
    try {
      const result = await checkRls(client);
      expect(result.unclassifiedRelations).toContain("projects_shadow (relkind=f)");
      expect(isClean(result)).toBe(false);
    } finally {
      await client.query("DROP FOREIGN TABLE IF EXISTS projects_shadow");
      await client.query("DROP SERVER IF EXISTS probe_srv");
    }
  });

  // ⚠ THE SAME RELATION, IN THE SCHEMA THE FIRST FIX FORGOT. The relkind
  // census was `public`-only for a round while ISO-23 had already been
  // widened — so the reasoning was written down in this repository and simply
  // not carried across. A review planted this in `app`, where the codebase
  // already keeps functions, and it fell through every control: this bucket
  // did not see the schema, ISO-23 looks only at views, ISO-16 only at
  // matviews, and RLS does not apply to foreign tables at all.
  it("bucket: unclassifiedRelations — a foreign table in a NON-public schema", async () => {
    await client.query("CREATE EXTENSION IF NOT EXISTS file_fdw");
    await client.query("CREATE SERVER IF NOT EXISTS probe_srv2 FOREIGN DATA WRAPPER file_fdw");
    await client.query("CREATE SCHEMA IF NOT EXISTS app");
    await client.query(
      "CREATE FOREIGN TABLE app.projects_shadow (id uuid, workspace_id uuid) SERVER probe_srv2 OPTIONS (filename '/dev/null', format 'csv')",
    );
    try {
      const result = await checkRls(client);
      expect(result.unclassifiedRelations, "schema-qualified, because `public` is no longer assumed").toContain(
        "app.projects_shadow (relkind=f)",
      );
      expect(isClean(result)).toBe(false);
    } finally {
      await client.query("DROP FOREIGN TABLE IF EXISTS app.projects_shadow");
      await client.query("DROP SERVER IF EXISTS probe_srv2");
    }
  });

  // `security_invoker = t` was reported as a violation by the second version
  // of this check, which enumerated `true|on|1|yes`. Postgres's boolean input
  // also takes `t`, `tr`, `tru`, `y`, `ye` and every case variant, so the
  // enumeration was always going to be one spelling short. The parse is
  // Postgres's own now, and this asserts the awkward spellings rather than
  // the obvious ones.
  it.each(["t", "T", "TRUE", "yes", "1", "on"])(
    "accepts security_invoker = %s, because Postgres does",
    async (spelling) => {
      await client.query(`CREATE VIEW v_spell WITH (security_invoker = ${spelling}) AS SELECT * FROM projects`);
      try {
        const result = await checkRls(client);
        expect(result.viewsWithoutSecurityInvoker).toEqual([]);
      } finally {
        await client.query("DROP VIEW IF EXISTS v_spell");
      }
    },
  );

  it("extension-owned views are excluded by dependency, not by name", async () => {
    // pg_stat_statements installs two views into `public` with no
    // security_invoker. They are excluded via pg_depend deptype='e' — and if
    // that exclusion ever became a two-name allow-list, this asserts the
    // mechanism that makes the NEXT extension safe too.
    const extensionViews = await client.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_depend d ON d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'e'
        WHERE n.nspname = 'public' AND c.relkind = 'v'`,
    );
    expect(
      extensionViews.rowCount,
      "if no extension view exists here, the exclusion below is proving nothing",
    ).toBeGreaterThan(0);
    const result = await checkRls(client);
    for (const row of extensionViews.rows) {
      expect(result.viewsWithoutSecurityInvoker.join(",")).not.toContain(row.relname);
    }
  });
});
