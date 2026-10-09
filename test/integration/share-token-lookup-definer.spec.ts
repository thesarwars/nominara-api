import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// CP2 owner decision (1) — app.share_token_by_hash is ONE narrow SECURITY DEFINER lookup owned by a DEDICATED role
// (not a superuser, not nominara_app, not the migration identity). Migration 0112 rebuilds it. These tests run as the
// REAL runtime roles; the HTTP harness connects as a superuser, which would pass every one of these vacuously.
const LOOKUP_ROLE = "nominara_share_lookup";

describe("CP2 decision 1 · app.share_token_by_hash is owned by a dedicated, narrow role", () => {
  let container: StartedPostgreSqlContainer;
  let admin: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
  }, 120_000);
  afterAll(async () => {
    await container.stop();
  });
  beforeEach(async () => {
    admin = new Client({ connectionString: container.getConnectionUri() });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS app CASCADE");
    await admin.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await admin.query("DROP SCHEMA IF EXISTS evil CASCADE");
    await admin.query("DROP SCHEMA public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await migrateUp(admin);
    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      await admin.query(`ALTER ROLE ${role} PASSWORD ${admin.escapeLiteral(resolvePassword(role, {}))}`);
    }
  });
  afterEach(async () => {
    await admin.end();
  });

  const asRole = (role: string): Pool =>
    new Pool({ host: container.getHost(), port: container.getPort(), database: "nominara_test", user: role, password: resolvePassword(role, {}) });

  async function seedToken(): Promise<{ ws: string; tokenId: string; hash: Buffer }> {
    const [ws, project, user, tokenId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const hash = randomBytes(32);
    await admin.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1::uuid,$1::text,$1::text,'growth')", [ws]);
    await admin.query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1,$2,now(),'active')", [user, `${user}@example.test`]);
    await admin.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://a.test','a.test')", [project, ws, `p-${project.slice(0, 8)}`]);
    await admin.query(
      `INSERT INTO share_tokens (id, workspace_id, label, token_hash, token_prefix, password_hash, password_required, scope_project_ids, created_by)
       VALUES ($1,$2,'SECRET LABEL',$3,'abcdefgh','$argon2id$stub',true,$4::uuid[],$5)`,
      [tokenId, ws, hash, [project], user],
    );
    return { ws, tokenId, hash };
  }

  it("DEF-1 · the function's owner is the dedicated role: NOLOGIN, NOSUPERUSER, NOINHERIT, no CREATEROLE/CREATEDB/REPLICATION, and neither nominara_app nor the migration identity", async () => {
    const r = await admin.query<{ owner: string; login: boolean; super: boolean; inherit: boolean; createrole: boolean; bypass: boolean; createdb: boolean; repl: boolean; migrator: string }>(
      `SELECT o.rolname AS owner, o.rolcanlogin AS login, o.rolsuper AS super, o.rolinherit AS inherit,
              o.rolcreaterole AS createrole, o.rolbypassrls AS bypass, o.rolcreatedb AS createdb, o.rolreplication AS repl, current_user AS migrator
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles o ON o.oid = p.proowner
        WHERE n.nspname = 'app' AND p.proname = 'share_token_by_hash'`,
    );
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row.owner).toBe(LOOKUP_ROLE);
    expect(row.owner).not.toBe("nominara_app");
    expect(row.owner).not.toBe(row.migrator);
    // NOBYPASSRLS: ISO-07 and ADR-0001 reserve BYPASSRLS for nominara_breakglass alone. The owner reads FORCE-RLS
    // share_tokens through ONE role-targeted SELECT policy instead (DEF-8), never through the attribute.
    expect([row.login, row.super, row.inherit, row.createrole, row.createdb, row.repl, row.bypass]).toEqual([false, false, false, false, false, false, false]);
  });

  it("DEF-2 · the owner's table rights are column-level SELECT on share_tokens only: it cannot read the token label, prefix or creator, cannot write, and sees no other table", async () => {
    await seedToken();
    const rights = await admin.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = $1`,
      [LOOKUP_ROLE],
    );
    // Table-level grants: none at all (column privileges are not listed in role_table_grants).
    expect(rights.rows).toEqual([]);
    const denied = async (sql: string): Promise<string | undefined> => {
      await admin.query("BEGIN");
      try {
        await admin.query(`SET LOCAL ROLE ${LOOKUP_ROLE}`);
        await admin.query(sql);
        return undefined;
      } catch (e) {
        return (e as { code?: string }).code;
      } finally {
        await admin.query("ROLLBACK");
      }
    };
    expect(await denied("SELECT label FROM share_tokens")).toBe("42501");
    expect(await denied("SELECT token_prefix FROM share_tokens")).toBe("42501");
    expect(await denied("SELECT created_by FROM share_tokens")).toBe("42501");
    expect(await denied("SELECT * FROM share_tokens")).toBe("42501");
    expect(await denied("UPDATE share_tokens SET view_count = 99")).toBe("42501");
    expect(await denied("DELETE FROM share_tokens")).toBe("42501");
    expect(await denied("SELECT id FROM users")).toBe("42501");
    expect(await denied("SELECT id FROM projects")).toBe("42501");
    expect(await denied("SELECT id FROM workspaces")).toBe("42501");
    expect(await denied("SELECT id, token_hash FROM share_tokens")).toBeUndefined();
  });

  it("DEF-3 · as nominara_app with NO context the lookup returns exactly the hashed token's row and nothing else, even with several workspaces' tokens present", async () => {
    const a = await seedToken();
    const b = await seedToken();
    await seedToken();
    const app = asRole("nominara_app");
    try {
      const ra = await app.query("SELECT * FROM app.share_token_by_hash($1)", [a.hash]);
      expect(ra.rows.map((r) => r.id)).toEqual([a.tokenId]);
      expect(ra.rows[0]!.workspace_id).toBe(a.ws);
      const rb = await app.query("SELECT * FROM app.share_token_by_hash($1)", [b.hash]);
      expect(rb.rows.map((r) => r.id)).toEqual([b.tokenId]);
      expect((await app.query("SELECT * FROM app.share_token_by_hash($1)", [randomBytes(32)])).rowCount).toBe(0);
      expect((await app.query("SELECT * FROM app.share_token_by_hash($1)", [Buffer.alloc(0)])).rowCount).toBe(0);
      expect((await app.query("SELECT * FROM app.share_token_by_hash(NULL)")).rowCount).toBe(0);
      // The function is not a way to enumerate: a hash is an equality key, there is no pattern or range form.
      const columns = ra.fields.map((f) => f.name);
      for (const forbidden of ["token_hash", "label", "token_prefix", "created_by"]) expect(columns).not.toContain(forbidden);
    } finally {
      await app.end();
    }
  });

  it("DEF-4 · every runtime role still reads ZERO share_tokens rows without a tenant context, and nominara_app cannot assume the lookup role", async () => {
    await seedToken();
    await seedToken();
    for (const role of RUNTIME_ROLES) {
      const pool = asRole(role);
      try {
        expect((await pool.query("SELECT id FROM share_tokens")).rowCount).toBe(0);
      } finally {
        await pool.end();
      }
    }
    const app = asRole("nominara_app");
    try {
      await expect(app.query(`SET ROLE ${LOOKUP_ROLE}`)).rejects.toMatchObject({ code: "42501" });
      await expect(app.query(`SELECT token_hash FROM share_tokens`)).resolves.toMatchObject({ rowCount: 0 });
    } finally {
      await app.end();
    }
  });

  it("DEF-5 · the pinned search_path holds against a hostile schema: a look-alike share_tokens earlier on the caller's path changes nothing", async () => {
    const a = await seedToken();
    await admin.query("CREATE SCHEMA evil");
    await admin.query("CREATE TABLE evil.share_tokens (LIKE public.share_tokens INCLUDING DEFAULTS)");
    await admin.query("GRANT USAGE ON SCHEMA evil TO nominara_app");
    await admin.query("GRANT SELECT ON ALL TABLES IN SCHEMA evil TO nominara_app");
    const meta = await admin.query<{ config: string[] | null }>(
      `SELECT p.proconfig AS config FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='app' AND p.proname='share_token_by_hash'`,
    );
    const path = (meta.rows[0]!.config ?? []).find((c) => c.startsWith("search_path="))!;
    expect(path).toBeDefined();
    // pg_catalog first, no user-writable schema ahead of it, and pg_temp (if named) last.
    const entries = path.slice("search_path=".length).split(",").map((s) => s.trim());
    expect(entries[0]).toBe("pg_catalog");
    expect(entries).not.toContain("evil");
    expect(entries).not.toContain('"$user"');
    // Every relation the body names is schema-qualified, so the path needs no schema beyond the catalog; pg_temp last.
    expect(entries).toEqual(["pg_catalog", "pg_temp"]);
    const app = asRole("nominara_app");
    try {
      const c = await app.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL search_path = evil, public");
        const r = await c.query("SELECT id FROM app.share_token_by_hash($1)", [a.hash]);
        expect(r.rows.map((x) => x.id)).toEqual([a.tokenId]);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    } finally {
      await app.end();
    }
  });

  it("DEF-6 · EXECUTE is held by nominara_app alone: PUBLIC, worker, report, portal and breakglass-less roles are refused", async () => {
    const s = await seedToken();
    for (const role of ["nominara_worker", "nominara_report", "nominara_portal"]) {
      const pool = asRole(role);
      try {
        await expect(pool.query("SELECT * FROM app.share_token_by_hash($1)", [s.hash])).rejects.toMatchObject({ code: "42501" });
      } finally {
        await pool.end();
      }
    }
    const holders = await admin.query<{ rolname: string }>(
      `SELECT r.rolname FROM pg_roles r, pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='app' AND p.proname='share_token_by_hash' AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
          AND NOT r.rolsuper AND r.rolname LIKE 'nominara\\_%' AND r.oid <> p.proowner ORDER BY 1`,
    );
    expect(holders.rows.map((r) => r.rolname)).toEqual(["nominara_app"]);
    expect((await admin.query("SELECT has_function_privilege('public','app.share_token_by_hash(bytea)','EXECUTE') AS ok")).rows[0]!.ok).toBe(false);
  });

  it("DEF-7 · the owner role owns exactly one object (the function) and holds no schema CREATE: it cannot be used to plant objects", async () => {
    const owned = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
      [LOOKUP_ROLE],
    );
    expect(owned.rows[0]!.n).toBe("1");
    const create = await admin.query<{ app: boolean; pub: boolean }>(
      `SELECT has_schema_privilege($1, 'app', 'CREATE') AS app, has_schema_privilege($1, 'public', 'CREATE') AS pub`,
      [LOOKUP_ROLE],
    );
    expect(create.rows[0]).toEqual({ app: false, pub: false });
  });

  it("DEF-8 · ISO-07 holds on the fully migrated schema: across the WHOLE cluster only nominara_breakglass has rolbypassrls", async () => {
    const r = await admin.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolbypassrls AND NOT rolsuper ORDER BY rolname");
    expect(r.rows.map((x) => x.rolname)).toEqual([BREAKGLASS_ROLE]);
  });

  it("DEF-9 · share_tokens carries exactly ONE policy for the owner role: FOR SELECT, TO nominara_share_lookup only, USING (true), no WITH CHECK; the ws_isolation policy is unchanged", async () => {
    const r = await admin.query<{ policyname: string; cmd: string; roles: string; qual: string | null; with_check: string | null }>(
      `SELECT policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'share_tokens' ORDER BY policyname`,
    );
    const mine = r.rows.filter((p) => p.roles.includes(LOOKUP_ROLE));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ policyname: "share_token_gate_lookup", cmd: "SELECT", roles: `{${LOOKUP_ROLE}}`, qual: "true", with_check: null });
    const iso = r.rows.filter((p) => p.policyname === "ws_isolation_share_tokens");
    expect(iso).toHaveLength(1);
    expect(iso[0]!.roles).not.toContain(LOOKUP_ROLE);
    expect(iso[0]!.qual).toContain("app.current_workspace()");
  });

  it("DEF-11 · nobody is a member of nominara_share_lookup: no pg_auth_members row, and no non-superuser role can MEMBER/USAGE/SET it", async () => {
    // The policy share_token_gate_lookup admits EVERY row to the role's privileges; the only thing keeping it inert is
    // that no role can assume the role. Mutation D2 (GRANT nominara_share_lookup TO nominara_worker) used to pass.
    const members = await admin.query<{ member: string }>(
      `SELECT m.rolname AS member FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member
        WHERE am.roleid = 'nominara_share_lookup'::regrole`,
    );
    expect(members.rows).toEqual([]);
    const reach = await admin.query<{ rolname: string; kind: string }>(
      `SELECT r.rolname, k.kind FROM pg_roles r CROSS JOIN (VALUES ('MEMBER'), ('USAGE'), ('SET')) AS k(kind)
        WHERE NOT r.rolsuper AND r.rolname <> 'nominara_share_lookup' AND pg_has_role(r.oid, 'nominara_share_lookup'::regrole, k.kind)`,
    );
    expect(reach.rows).toEqual([]);
  });

  it("DEF-10 · 0112 rolls back cleanly (owner returns to the migration identity, policy and grants gone, lookup still works) and re-applies", async () => {
    const s = await seedToken();
    for (let step = 0; step < 200; step += 1) {
      const name = await rollbackLast(admin, MIGRATIONS_DIR);
      if (name === null || name === "0112_share_token_lookup_definer_owner") {
        expect(name).toBe("0112_share_token_lookup_definer_owner");
        break;
      }
    }
    const owner = await admin.query<{ owner: string }>(
      `SELECT o.rolname AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles o ON o.oid = p.proowner WHERE n.nspname='app' AND p.proname='share_token_by_hash'`,
    );
    expect(owner.rows[0]!.owner).toBe("nominara");
    expect((await admin.query(`SELECT 1 FROM pg_policies WHERE tablename='share_tokens' AND policyname='share_token_gate_lookup'`)).rowCount).toBe(0);
    expect((await admin.query(`SELECT has_column_privilege($1,'share_tokens','token_hash','SELECT') AS ok`, [LOOKUP_ROLE])).rows[0]!.ok).toBe(false);
    const app = asRole("nominara_app");
    try {
      expect((await app.query("SELECT id FROM app.share_token_by_hash($1)", [s.hash])).rows.map((x) => x.id)).toEqual([s.tokenId]);
    } finally {
      await app.end();
    }
    await migrateUp(admin, MIGRATIONS_DIR);
    const again = await admin.query<{ owner: string }>(
      `SELECT o.rolname AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles o ON o.oid = p.proowner WHERE n.nspname='app' AND p.proname='share_token_by_hash'`,
    );
    expect(again.rows[0]!.owner).toBe(LOOKUP_ROLE);
  });
});
