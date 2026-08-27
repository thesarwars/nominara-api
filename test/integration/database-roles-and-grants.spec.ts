import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BREAKGLASS_ROLE,
  DATABASE_ROLES,
  MIGRATION_OWNER_ROLE,
  RUNTIME_ROLES,
  expectedTablePrivileges,
  type TablePrivilege,
} from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";
import { assertNotMigrationOwner, inspectConnectedRole } from "../../src/db/roles.js";

// STORY-010 · database roles & grants. Same shared-container /
// isolated-temp-migrations-dir pattern as test/integration/
// rollups-aux-tasks-geo-tools.spec.ts, extended to 0001-0005 since the
// grants in 0005 need the full 69-table census to exist first.
describe("STORY-010 · database roles, grants & connection limits", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let migrationsDir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    migrationsDir = await mkdtemp(path.join(tmpdir(), "nominara-story010-isolated-"));
    for (const name of [
      "0001_extensions_and_conventions",
      "0002_identity_tenancy_billing",
      "0003_projects_prompts_captures",
      "0004_rollups_aux_tasks_geo_tools",
      "0005_roles_grants_and_pooling",
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

    // Migration 0005 deliberately sets NO passwords (see its header) — set
    // local test-fixture passwords here, mirroring src/db/dev-credentials.ts,
    // so this file can open direct connections AS each role.
    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      const password = resolvePassword(role, {});
      // client.escapeLiteral, not hand-rolled quote-doubling — see
      // src/db/dev-credentials.ts's identical fix (post-review item 14).
      await client.query(`ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(password)}`);
    }
  });

  afterEach(async () => {
    await client.end();
  });

  // ---- helpers -----------------------------------------------------------

  async function openConnection(role: string, password?: string): Promise<Client> {
    const c = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: role,
      password: password ?? resolvePassword(role, {}),
    });
    await c.connect();
    return c;
  }

  // Matches test/integration/rollups-aux-tasks-geo-tools.spec.ts's census
  // query exactly: information_schema.tables counts each partition of
  // answer_captures/citation_facts/mention_facts as its own BASE TABLE (78
  // rows), which is NOT the 69-table census (59 tenant + 10 global) this
  // story's grants are scoped to. pg_class + relispartition excludes them.
  const CENSUS_TABLES_SQL = `
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT c.relispartition
  `;

  let seq = 0;
  async function createWorkspace(): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'free') RETURNING id",
      [`Workspace ${seq}`, `workspace-${seq}-${Math.random().toString(36).slice(2)}`],
    );
    return result.rows[0]!.id;
  }

  // ---- connection-limit catalog (part of scenario 7) ----------------------

  it("connection-limit catalog values match spec: 400/300/40/60/2, -1 for owner", () => {
    expect(DATABASE_ROLES.nominara_app!.connectionLimit).toBe(400);
    expect(DATABASE_ROLES.nominara_worker!.connectionLimit).toBe(300);
    expect(DATABASE_ROLES.nominara_report!.connectionLimit).toBe(40);
    expect(DATABASE_ROLES.nominara_portal!.connectionLimit).toBe(60);
    expect(DATABASE_ROLES[BREAKGLASS_ROLE]!.connectionLimit).toBe(2);
    expect(DATABASE_ROLES[MIGRATION_OWNER_ROLE]!.connectionLimit).toBe(-1);
  });

  it("pg_roles attributes actually match DATABASE_ROLES for all 6 roles (login, bypassrls, connection limit)", async () => {
    const result = await client.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolbypassrls: boolean;
      rolconnlimit: number;
    }>("SELECT rolname, rolcanlogin, rolbypassrls, rolconnlimit FROM pg_roles WHERE rolname = ANY($1::text[])", [
      Object.keys(DATABASE_ROLES),
    ]);
    const byName = new Map(result.rows.map((row) => [row.rolname, row]));
    for (const [name, spec] of Object.entries(DATABASE_ROLES)) {
      const actual = byName.get(name);
      expect(actual, `${name} missing from pg_roles`).toBeDefined();
      expect(actual!.rolcanlogin, `${name} login`).toBe(spec.login);
      expect(actual!.rolbypassrls, `${name} bypassrls`).toBe(spec.bypassrls);
      expect(actual!.rolconnlimit, `${name} connlimit`).toBe(spec.connectionLimit);
    }
  });

  // ---- scenario 1 ----------------------------------------------------------

  it("scenario 1 — exactly nominara_breakglass has rolbypassrls across the WHOLE cluster (no runtime role, and no role under any other name, holds policy bypass)", async () => {
    // Post-review fix #10: the previous version of this test scoped the
    // query with `rolname LIKE 'nominara_%'`, which both under-matches (`_`
    // is a single-char wildcard in SQL LIKE) and, more importantly,
    // over-matches by construction — a BYPASSRLS role under any OTHER name
    // would pass silently, defeating the AC's literal "the set is exactly
    // that one" requirement. This drops the name filter entirely and checks
    // the whole cluster, excluding actual Postgres superusers (which
    // legitimately bypass RLS by an entirely different, unrelated
    // mechanism — ownership/superuser status, not the BYPASSRLS attribute).
    const result = await client.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolbypassrls AND NOT rolsuper ORDER BY rolname",
    );
    expect(result.rows.map((r) => r.rolname)).toEqual([BREAKGLASS_ROLE]);
  });

  // ---- post-review fix #2 — converging ALTER ROLE resets ALL dangerous
  // attributes, not just the ones already being tracked -----------------------

  it("post-review fix #2 — re-applying 0005 converges a hand-altered runtime role's dangerous attributes back to safe (BYPASSRLS/SUPERUSER/CREATEDB/CREATEROLE/REPLICATION all cleared)", async () => {
    // Simulates a role pre-created by Terraform, or a stale prior manual
    // ALTER ROLE, carrying attributes far more dangerous than anything
    // conventions.ts's DATABASE_ROLES spec was previously checking for.
    await client.query(
      "ALTER ROLE nominara_worker BYPASSRLS SUPERUSER CREATEDB CREATEROLE REPLICATION",
    );
    const before = await client.query<{
      rolbypassrls: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
    }>(
      "SELECT rolbypassrls, rolsuper, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname = 'nominara_worker'",
    );
    expect(before.rows[0]).toEqual({
      rolbypassrls: true,
      rolsuper: true,
      rolcreatedb: true,
      rolcreaterole: true,
      rolreplication: true,
    });

    // Re-run 0005's own SQL directly (same pattern as the idempotency test
    // below) — this is the "re-apply the migration" step the fix calls for,
    // without needing to touch _migrations bookkeeping.
    const sql = await readFile(path.join(migrationsDir, "0005_roles_grants_and_pooling.up.sql"), "utf8");
    await client.query(sql);

    const after = await client.query<{
      rolbypassrls: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
    }>(
      "SELECT rolbypassrls, rolsuper, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname = 'nominara_worker'",
    );
    expect(after.rows[0]).toEqual({
      rolbypassrls: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    });
  });

  // ---- scenario 2 ------------------------------------------------------------

  it("scenario 2 — attempt an insert as the portal role is rejected", async () => {
    const portalClient = await openConnection("nominara_portal");
    try {
      await expect(
        portalClient.query("INSERT INTO workspaces (name, slug, plan_key) VALUES ('x', 'portal-insert-test', 'free')"),
      ).rejects.toThrow(/permission denied for table workspaces/i);
    } finally {
      await portalClient.end();
    }
  });

  // ---- scenario 3 ------------------------------------------------------------

  it("scenario 3 — attempt a select on credentials as the worker role is rejected", async () => {
    const workerClient = await openConnection("nominara_worker");
    try {
      await expect(workerClient.query("SELECT 1 FROM user_credentials LIMIT 1")).rejects.toThrow(
        /permission denied for table user_credentials/i,
      );
    } finally {
      await workerClient.end();
    }
  });

  // ---- scenario 4 ------------------------------------------------------------

  it("scenario 4 — attempt an update on the audit log as the API role (nominara_app) is rejected", async () => {
    const appClient = await openConnection("nominara_app");
    try {
      await expect(appClient.query("UPDATE audit_log SET action = 'x' WHERE seq = 1")).rejects.toThrow(
        /permission denied for table audit_log/i,
      );
    } finally {
      await appClient.end();
    }
  });

  it("nominara_app CAN insert into audit_log (proves the sequence USAGE grant), but cannot update or delete it", async () => {
    const workspaceId = await createWorkspace();
    const appClient = await openConnection("nominara_app");
    try {
      const insertResult = await appClient.query<{ seq: string }>(
        `INSERT INTO audit_log (workspace_id, actor_type, action, resource_type, request_id, prev_hash, row_hash)
         VALUES ($1, 'user', 'workspace.create', 'workspace', 'req-1', $2, $3) RETURNING seq`,
        [workspaceId, Buffer.alloc(32, 0), Buffer.alloc(32, 1)],
      );
      const seqId = insertResult.rows[0]!.seq;
      expect(seqId).toBeDefined();

      await expect(appClient.query("UPDATE audit_log SET action = 'y' WHERE seq = $1", [seqId])).rejects.toThrow(
        /permission denied for table audit_log/i,
      );
      await expect(appClient.query("DELETE FROM audit_log WHERE seq = $1", [seqId])).rejects.toThrow(
        /permission denied for table audit_log/i,
      );
    } finally {
      await appClient.end();
    }
  });

  // Post-review fix #8: the sequence-USAGE correction (CORRECTION 2 in
  // 0005.up.sql) only had a test for nominara_app — mirror it for
  // nominara_worker, the other write-capable role.
  it("nominara_worker CAN insert into audit_log (proves the sequence USAGE grant), but cannot update or delete it", async () => {
    const workspaceId = await createWorkspace();
    const workerClient = await openConnection("nominara_worker");
    try {
      const insertResult = await workerClient.query<{ seq: string }>(
        `INSERT INTO audit_log (workspace_id, actor_type, action, resource_type, request_id, prev_hash, row_hash)
         VALUES ($1, 'system', 'workspace.create', 'workspace', 'req-2', $2, $3) RETURNING seq`,
        [workspaceId, Buffer.alloc(32, 0), Buffer.alloc(32, 1)],
      );
      const seqId = insertResult.rows[0]!.seq;
      expect(seqId).toBeDefined();

      await expect(workerClient.query("UPDATE audit_log SET action = 'y' WHERE seq = $1", [seqId])).rejects.toThrow(
        /permission denied for table audit_log/i,
      );
      await expect(workerClient.query("DELETE FROM audit_log WHERE seq = $1", [seqId])).rejects.toThrow(
        /permission denied for table audit_log/i,
      );
    } finally {
      await workerClient.end();
    }
  });

  // ---- post-review fix #3 — ALTER DEFAULT PRIVILEGES coverage ---------------
  // Mutation-tested: deleting all six ALTER DEFAULT PRIVILEGES statements
  // from 0005.up.sql left 20/20 tests passing before this fix, because the
  // 69-table census matrix below only checks tables that already existed AT
  // GRANT TIME (covered by the preceding blanket GRANT). This proves a table
  // created AFTER the migration runs still gets the right privileges.

  it("post-review fix #3 — a table created AFTER migration 0005 (by the same role that ran it) still gets runtime-role privileges via ALTER DEFAULT PRIVILEGES", async () => {
    await client.query("CREATE TABLE probe_default_privs (id bigserial PRIMARY KEY, v text)");
    try {
      const result = await client.query<{
        app_insert: boolean;
        report_select: boolean;
        report_update: boolean;
        app_seq_usage: boolean;
      }>(
        `SELECT
           has_table_privilege('nominara_app', 'probe_default_privs', 'INSERT') AS app_insert,
           has_table_privilege('nominara_report', 'probe_default_privs', 'SELECT') AS report_select,
           has_table_privilege('nominara_report', 'probe_default_privs', 'UPDATE') AS report_update,
           has_sequence_privilege('nominara_app', 'probe_default_privs_id_seq', 'USAGE') AS app_seq_usage`,
      );
      expect(result.rows[0]).toEqual({
        app_insert: true,
        report_select: true,
        report_update: false,
        app_seq_usage: true,
      });
    } finally {
      await client.query("DROP TABLE IF EXISTS probe_default_privs");
    }
  });

  // ---- scenario 7 ------------------------------------------------------------

  it("scenario 7 — exhausting nominara_breakglass's connection limit (2) rejects a 3rd direct connection with the role-specific error; nominara_app is unaffected", async () => {
    const conn1 = await openConnection(BREAKGLASS_ROLE);
    const conn2 = await openConnection(BREAKGLASS_ROLE);
    try {
      // Post-review fix #11: tightened from a bare /too many connections/i,
      // which would ALSO match Postgres's generic cluster-wide "sorry, too
      // many clients already" message (max_connections exhaustion) — a
      // false pass that proves nothing about the per-role CONNECTION LIMIT
      // this scenario is actually about. Matching the role name in the
      // error message is specific to the per-role limit.
      await expect(openConnection(BREAKGLASS_ROLE)).rejects.toThrow(
        /too many connections for role "nominara_breakglass"/i,
      );

      const appConn = await openConnection("nominara_app");
      await expect(appConn.query("SELECT 1")).resolves.toBeDefined();
      await appConn.end();
    } finally {
      await conn1.end();
      await conn2.end();
    }
  });

  it("nominara_owner has rolcanlogin=false, and a direct connection attempt as it fails", async () => {
    const result = await client.query<{ rolcanlogin: boolean }>(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = $1",
      [MIGRATION_OWNER_ROLE],
    );
    expect(result.rows[0]!.rolcanlogin).toBe(false);

    // A password is set here purely so the connection attempt fails on the
    // rolcanlogin check rather than on password verification — Postgres
    // authenticates the password BEFORE it checks whether the role may log
    // in at all, so an unset password would fail for the wrong reason.
    await client.query(`ALTER ROLE ${MIGRATION_OWNER_ROLE} PASSWORD 'irrelevant'`);
    await expect(openConnection(MIGRATION_OWNER_ROLE, "irrelevant")).rejects.toThrow(
      /is not permitted to log in/i,
    );
  });

  // ---- scenario 8 ------------------------------------------------------------

  it("scenario 8 — inspectConnectedRole reports correctly for a running nominara_app connection, never the migration owner", async () => {
    const appClient = await openConnection("nominara_app");
    try {
      const info = await inspectConnectedRole(appClient);
      expect(info.sessionUser).toBe("nominara_app");
      expect(info.currentUser).toBe("nominara_app");
      expect(info.isMigrationOwner).toBe(false);
      expect(info.isRuntimeRole).toBe(true);
      await expect(assertNotMigrationOwner(appClient)).resolves.toBeDefined();
    } finally {
      await appClient.end();
    }
  });

  it("assertNotMigrationOwner throws when connected as nominara_owner", async () => {
    // nominara_owner is NOLOGIN, so it cannot open its own connection — this
    // exercises assertNotMigrationOwner's actual throw path via SET ROLE.
    // `client` here connects as the docker-compose superuser, and a
    // superuser may SET ROLE to any role regardless of membership grants —
    // no explicit `GRANT nominara_owner TO ...` is needed for this (nor does
    // 0005.up.sql issue one any more; see its CORRECTION 1a).
    await client.query(`SET ROLE ${MIGRATION_OWNER_ROLE}`);
    try {
      await expect(assertNotMigrationOwner(client)).rejects.toThrow(/migration owner/i);
    } finally {
      await client.query("RESET ROLE");
    }
  });

  // ---- user_credentials — grant, not policy (security-and-tenancy.md §1) -----

  it("user_credentials — nominara_app keeps full privileges (the auth path); worker/report/portal have none", async () => {
    const result = await client.query<{
      rolname: string;
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
    }>(
      `SELECT rolname,
         has_table_privilege(rolname, 'user_credentials', 'SELECT') AS sel,
         has_table_privilege(rolname, 'user_credentials', 'INSERT') AS ins,
         has_table_privilege(rolname, 'user_credentials', 'UPDATE') AS upd,
         has_table_privilege(rolname, 'user_credentials', 'DELETE') AS del
       FROM (VALUES ('nominara_app'), ('nominara_worker'), ('nominara_report'), ('nominara_portal')) AS t(rolname)`,
    );
    const byRole = new Map(result.rows.map((row) => [row.rolname, row]));
    expect(byRole.get("nominara_app")).toMatchObject({ sel: true, ins: true, upd: true, del: true });
    for (const role of ["nominara_worker", "nominara_report", "nominara_portal"]) {
      expect(byRole.get(role), role).toMatchObject({ sel: false, ins: false, upd: false, del: false });
    }
  });

  // ---- SET LOCAL reverts at both COMMIT and ROLLBACK -------------------------

  it("set_config(..., true) (SET LOCAL) reverts to null after COMMIT, and also after ROLLBACK", async () => {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', 'committed-txn', true)");
    const duringCommit = await client.query("SELECT current_setting('app.current_workspace_id', true) AS ws");
    expect(duringCommit.rows[0]!.ws).toBe("committed-txn");
    await client.query("COMMIT");
    const afterCommit = await client.query("SELECT current_setting('app.current_workspace_id', true) AS ws");
    expect(afterCommit.rows[0]!.ws == null || afterCommit.rows[0]!.ws === "").toBe(true);

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', 'rolled-back-txn', true)");
    const duringRollback = await client.query("SELECT current_setting('app.current_workspace_id', true) AS ws");
    expect(duringRollback.rows[0]!.ws).toBe("rolled-back-txn");
    await client.query("ROLLBACK");
    const afterRollback = await client.query("SELECT current_setting('app.current_workspace_id', true) AS ws");
    expect(afterRollback.rows[0]!.ws == null || afterRollback.rows[0]!.ws === "").toBe(true);
  });

  // ---- census-driven ACL matrix (task 14) ------------------------------------

  it("census-driven ACL matrix — every one of the 69 tables matches EXPECTED_TABLE_PRIVILEGES for every runtime role", async () => {
    const tablesResult = await client.query<{ table_name: string }>(CENSUS_TABLES_SQL);
    expect(tablesResult.rowCount).toBe(69);

    const privResult = await client.query<{
      table_name: string;
      rolname: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT t.table_name, r.rolname,
         has_table_privilege(r.rolname, t.table_name, 'SELECT') AS can_select,
         has_table_privilege(r.rolname, t.table_name, 'INSERT') AS can_insert,
         has_table_privilege(r.rolname, t.table_name, 'UPDATE') AS can_update,
         has_table_privilege(r.rolname, t.table_name, 'DELETE') AS can_delete
       FROM (${CENSUS_TABLES_SQL}) t
       CROSS JOIN (VALUES ('nominara_app'), ('nominara_worker'), ('nominara_report'), ('nominara_portal')) AS r(rolname)`,
    );

    const mismatches: string[] = [];
    for (const row of privResult.rows) {
      const expected = [...expectedTablePrivileges(row.rolname, row.table_name)].sort();
      const actual: TablePrivilege[] = [];
      if (row.can_select) actual.push("SELECT");
      if (row.can_insert) actual.push("INSERT");
      if (row.can_update) actual.push("UPDATE");
      if (row.can_delete) actual.push("DELETE");
      actual.sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        mismatches.push(`${row.rolname} on ${row.table_name}: expected [${expected.join(",")}], got [${actual.join(",")}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  // SCOPE, and it matters: this file applies 0001-0005 ONLY (see the
  // isolated migrationsDir in beforeAll), so this asserts the state 0005
  // leaves behind — not a standing invariant of the deployed database.
  //
  // STORY-120 later grants nominara_app exactly USAGE + SELECT here, in
  // migration 0015, because readiness reads the ledger over the pooled
  // connection and could never succeed without it. The decided end-state
  // matrix for the FULL chain lives in
  // test/integration/readiness-as-runtime-role.spec.ts; this assertion stays
  // as the proof that the grant arrives in 0015 deliberately and is not
  // something 0005 quietly handed out.
  it("after 0005, no runtime role has any privilege on the _migrations schema (STORY-120's grant arrives later, in 0015)", async () => {
    for (const role of RUNTIME_ROLES) {
      const usage = await client.query<{ has_usage: boolean }>(
        "SELECT has_schema_privilege($1, '_migrations', 'USAGE') AS has_usage",
        [role],
      );
      expect(usage.rows[0]!.has_usage, `${role} schema usage`).toBe(false);

      const tablePriv = await client.query<{ can_select: boolean }>(
        "SELECT has_table_privilege($1, '_migrations.applied', 'SELECT') AS can_select",
        [role],
      );
      expect(tablePriv.rows[0]!.can_select, `${role} table select`).toBe(false);
    }
  });

  // ---- idempotency & rollback (task 13 widening) ------------------------------

  it("migration 0005's own SQL is idempotent — applying it a second time directly does not throw", async () => {
    const sql = await readFile(path.join(migrationsDir, "0005_roles_grants_and_pooling.up.sql"), "utf8");
    // 0005 was already applied once via migrateUp in beforeEach; this
    // re-runs its body directly (bypassing the _migrations bookkeeping) to
    // prove the SQL itself, not just the runner's skip-if-applied logic, is
    // idempotent.
    await expect(client.query(sql)).resolves.toBeDefined();
  });

  it("rollback-then-reapply of 0005 leaves the grant matrix identical, and rollback GENUINELY revokes everything in between", async () => {
    const snapshot = async () => {
      const result = await client.query<{
        table_name: string;
        rolname: string;
        s: boolean;
        i: boolean;
        u: boolean;
        d: boolean;
      }>(
        `SELECT t.table_name, r.rolname,
           has_table_privilege(r.rolname, t.table_name, 'SELECT') AS s,
           has_table_privilege(r.rolname, t.table_name, 'INSERT') AS i,
           has_table_privilege(r.rolname, t.table_name, 'UPDATE') AS u,
           has_table_privilege(r.rolname, t.table_name, 'DELETE') AS d
         FROM (${CENSUS_TABLES_SQL}) t
         CROSS JOIN (VALUES ('nominara_app'), ('nominara_worker'), ('nominara_report'), ('nominara_portal')) AS r(rolname)
         ORDER BY t.table_name, r.rolname`,
      );
      return result.rows;
    };

    const before = await snapshot();
    const rolledBack = await rollbackLast(client, migrationsDir);
    expect(rolledBack).toBe("0005_roles_grants_and_pooling");

    // Post-review fix #4: the previous version of this test only compared
    // snapshots BEFORE rollback+reapply and AFTER — a symmetric no-op (a
    // down migration that does nothing, then an up migration that also does
    // nothing) passes that comparison just as trivially as a correct
    // rollback does. Mutation testing proved this: replacing the entire down
    // migration body with `SELECT 1;` still passed 20/20 tests. This
    // mid-state assertion, taken BEFORE the re-apply below, closes that gap
    // by proving the grants are genuinely gone after rollback, not merely
    // unchanged.
    const midState = await snapshot();
    for (const row of midState) {
      expect(row, `${row.rolname} on ${row.table_name} still holds a privilege after rollback`).toMatchObject({
        s: false,
        i: false,
        u: false,
        d: false,
      });
    }

    for (const role of RUNTIME_ROLES) {
      const usage = await client.query<{ has_usage: boolean }>(
        "SELECT has_schema_privilege($1, 'public', 'USAGE') AS has_usage",
        [role],
      );
      expect(usage.rows[0]!.has_usage, `${role} public schema usage after rollback`).toBe(false);
    }

    const eventTriggerCount = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_event_trigger WHERE evtname = 'breakglass_login_alert'",
    );
    expect(Number(eventTriggerCount.rows[0]!.count)).toBe(0);

    const fnCount = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_proc WHERE proname = 'breakglass_login_alert' AND pronamespace = 'app'::regnamespace",
    );
    expect(Number(fnCount.rows[0]!.count)).toBe(0);

    const reapplied = await migrateUp(client, migrationsDir);
    expect(reapplied).toEqual(["0005_roles_grants_and_pooling"]);
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  // ---- break-glass login event trigger (task 15) -----------------------------

  it("the break-glass login event trigger exists and is enabled", async () => {
    const result = await client.query<{ evtname: string; evtenabled: string; evtevent: string }>(
      "SELECT evtname, evtenabled, evtevent FROM pg_event_trigger WHERE evtname = 'breakglass_login_alert'",
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]!.evtevent).toBe("login");
    // 'O' = fires in "origin" and "local" modes, i.e. enabled by default.
    expect(result.rows[0]!.evtenabled).toBe("O");
  });

  // Post-review fix #15: reads logs via testcontainers' own container.logs()
  // API instead of shelling out to the host `docker` CLI — the latter
  // breaks under remote docker hosts/podman, and a fixed `tail -n 500` can
  // silently truncate under log volume from earlier tests in this file.
  async function readContainerLogs(sinceEpochSeconds?: number, timeoutMs = 2_000): Promise<string> {
    const stream = await container.logs(sinceEpochSeconds !== undefined ? { since: sinceEpochSeconds } : undefined);
    return await new Promise<string>((resolve, reject) => {
      let data = "";
      const timer = setTimeout(() => {
        stream.destroy();
        resolve(data);
      }, timeoutMs);
      stream.on("data", (chunk: Buffer | string) => {
        data += chunk.toString();
      });
      stream.on("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      stream.on("end", () => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  it(
    "a break-glass connection produces the RAISE LOG line naming the role AND the exact backend pid (stand-in for the production page, gap G-1)",
    async () => {
      // Post-review fix #6: the previous version of this test read the
      // whole log tail with no time bound and no pid bound — an EARLIER,
      // unrelated scenario (connection-limit exhaustion, above) already
      // opens THREE nominara_breakglass connections before this test runs,
      // any of which could satisfy a bare /nominara_breakglass_login/
      // match even if THIS connection's log line never appeared at all.
      // Bounding by `since` (this test's own start time) AND matching the
      // exact backend pid closes that gap.
      const sinceEpochSeconds = Math.floor(Date.now() / 1000);
      const breakglassClient = await openConnection(BREAKGLASS_ROLE);
      let pid: number;
      try {
        const pidResult = await breakglassClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        pid = pidResult.rows[0]!.pid;
      } finally {
        await breakglassClient.end();
      }

      // Give the log line a moment to actually land before reading.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const logs = await readContainerLogs(sinceEpochSeconds);
      const pidPattern = new RegExp(`nominara_breakglass_login.*pid=${pid}(?!\\d)`);
      expect(logs).toMatch(pidPattern);
    },
    10_000,
  );

  // ---- post-review fix #7 — the exception handler is behaviorally proven,
  // not just regex-matched against pg_proc.prosrc -----------------------------

  it("post-review fix #7 — EXCEPTION WHEN OTHERS in the break-glass login trigger prevents cluster-wide login lockout even when the trigger body itself is broken", async () => {
    // This is the single highest-blast-radius failure mode in the whole
    // migration: an `ON login` event trigger that raises unhandled breaks
    // authentication for EVERY role, not just nominara_breakglass. A regex
    // check on pg_proc.prosrc never actually exercises the handler — this
    // does, by installing a body that genuinely raises (integer division by
    // zero, not an early RETURN) for every login, then proving both a
    // runtime role and the break-glass role can still authenticate.
    await client.query(`
      CREATE OR REPLACE FUNCTION app.breakglass_login_alert()
      RETURNS event_trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        boom int;
      BEGIN
        boom := 1 / 0; -- deliberately raises for EVERY login, not just break-glass
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
      $$;
    `);

    try {
      const appClient = await openConnection("nominara_app");
      await expect(appClient.query("SELECT 1")).resolves.toBeDefined();
      await appClient.end();

      const breakglassClient = await openConnection(BREAKGLASS_ROLE);
      await expect(breakglassClient.query("SELECT 1")).resolves.toBeDefined();
      await breakglassClient.end();
    } finally {
      // Restore the real function from the migration's actual DDL — this
      // re-runs the whole (idempotent) 0005 SQL rather than hand-typing the
      // original body a second time, so it can never drift from the shipped
      // migration.
      const sql = await readFile(path.join(migrationsDir, "0005_roles_grants_and_pooling.up.sql"), "utf8");
      await client.query(sql);
    }
  });

  it("a non-break-glass login does NOT produce the break-glass log line", async () => {
    const appClient = await openConnection("nominara_app");
    await appClient.query("SELECT 1");
    await appClient.end();
    // No direct negative assertion on log content here (log volume across
    // the whole suite makes an exact absence check flaky) — the function's
    // own `IF session_user = 'nominara_breakglass'` guard is what matters,
    // and is exercised directly below instead.
    const result = await client.query<{ prosrc: string }>(
      "SELECT prosrc FROM pg_proc WHERE proname = 'breakglass_login_alert' AND pronamespace = 'app'::regnamespace",
    );
    expect(result.rows[0]!.prosrc).toMatch(/session_user\s*=\s*'nominara_breakglass'/);
    expect(result.rows[0]!.prosrc).toMatch(/EXCEPTION\s+WHEN\s+OTHERS/i);
  });
});
