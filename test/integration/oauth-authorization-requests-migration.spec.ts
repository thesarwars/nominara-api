import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUNTIME_ROLES } from "../../src/db/conventions.js";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// STORY-015 · migration 0013 — the OAuth state parameter's server-held
// payload (PKCE verifier, session-binding hash) for an in-flight
// authorization-code flow. Follows
// test/integration/workspace-actor-self-scoped-policies-migration.spec.ts's
// exact pattern: isolated temp-dir snapshot of the full chain up to and
// including this migration, up -> table/columns/CHECK/index present, grants
// restricted to nominara_app -> rollbackLast -> genuinely gone (mid-state,
// BEFORE reapply) -> reapply -> everything back.
const MIGRATION_NAME = "0013_oauth_authorization_requests";

describe("STORY-015 · migration 0013 — oauth_authorization_requests", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let migrationsDir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    migrationsDir = await mkdtemp(path.join(tmpdir(), "nominara-story015-0013-isolated-"));
    for (const name of [
      "0001_extensions_and_conventions",
      "0002_identity_tenancy_billing",
      "0003_projects_prompts_captures",
      "0004_rollups_aux_tasks_geo_tools",
      "0005_roles_grants_and_pooling",
      "0006_generated_rls_policies",
      "0007_partition_maintenance_and_retention",
      "0008_identity_authenticator_attachment",
      "0009_session_model_and_refresh_tokens",
      "0010_session_strong_auth",
      "0011_audit_rechained_marker_privilege_guard",
      "0012_actor_self_scoped_membership_policies",
      MIGRATION_NAME,
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

  async function tableExists(): Promise<boolean> {
    const result = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'oauth_authorization_requests'",
    );
    return Number(result.rows[0]!.count) === 1;
  }

  // ---- table/columns present after up ----------------------------------------

  it("creates the table with the expected columns and types", async () => {
    const result = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'oauth_authorization_requests'
       ORDER BY ordinal_position`,
    );
    const byName = new Map(result.rows.map((row) => [row.column_name, row]));

    expect(byName.get("id")).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
    expect(byName.get("provider")).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(byName.get("purpose")).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(byName.get("link_user_id")).toMatchObject({ data_type: "uuid", is_nullable: "YES" });
    expect(byName.get("code_verifier")).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(byName.get("nonce")).toMatchObject({ data_type: "text", is_nullable: "YES" });
    expect(byName.get("binding_hash")).toMatchObject({ data_type: "bytea", is_nullable: "NO" });
    expect(byName.get("redirect_uri")).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(byName.get("expires_at")).toMatchObject({ data_type: "timestamp with time zone", is_nullable: "NO" });
    expect(byName.get("consumed_at")).toMatchObject({ data_type: "timestamp with time zone", is_nullable: "YES" });
    expect(byName.get("created_at")).toMatchObject({ data_type: "timestamp with time zone", is_nullable: "NO" });
  });

  // ---- CHECK constraints -------------------------------------------------------

  async function createWorkspaceUser(): Promise<string> {
    const result = await client.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [`oauth-test-${Math.random().toString(36).slice(2)}@example.com`],
    );
    return result.rows[0]!.id;
  }

  it("rejects a provider outside google/github/microsoft", async () => {
    await expect(
      client.query(
        `INSERT INTO oauth_authorization_requests
           (provider, purpose, code_verifier, binding_hash, redirect_uri, expires_at)
         VALUES ('facebook', 'login', 'verifier', $1, 'https://app.example/callback', now() + interval '5 minutes')`,
        [Buffer.alloc(32, 1)],
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("rejects a purpose outside login/link", async () => {
    await expect(
      client.query(
        `INSERT INTO oauth_authorization_requests
           (provider, purpose, code_verifier, binding_hash, redirect_uri, expires_at)
         VALUES ('google', 'signup', 'verifier', $1, 'https://app.example/callback', now() + interval '5 minutes')`,
        [Buffer.alloc(32, 1)],
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("rejects purpose='link' with a NULL link_user_id", async () => {
    await expect(
      client.query(
        `INSERT INTO oauth_authorization_requests
           (provider, purpose, code_verifier, binding_hash, redirect_uri, expires_at)
         VALUES ('google', 'link', 'verifier', $1, 'https://app.example/callback', now() + interval '5 minutes')`,
        [Buffer.alloc(32, 1)],
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("rejects purpose='login' with a NON-NULL link_user_id", async () => {
    const userId = await createWorkspaceUser();
    await expect(
      client.query(
        `INSERT INTO oauth_authorization_requests
           (provider, purpose, link_user_id, code_verifier, binding_hash, redirect_uri, expires_at)
         VALUES ('google', 'login', $2, 'verifier', $1, 'https://app.example/callback', now() + interval '5 minutes')`,
        [Buffer.alloc(32, 1), userId],
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("accepts purpose='login' with a NULL link_user_id, and purpose='link' with a NON-NULL link_user_id", async () => {
    const userId = await createWorkspaceUser();
    await expect(
      client.query(
        `INSERT INTO oauth_authorization_requests
           (provider, purpose, code_verifier, binding_hash, redirect_uri, expires_at)
         VALUES ('google', 'login', 'verifier', $1, 'https://app.example/callback', now() + interval '5 minutes')`,
        [Buffer.alloc(32, 1)],
      ),
    ).resolves.toBeDefined();

    await expect(
      client.query(
        `INSERT INTO oauth_authorization_requests
           (provider, purpose, link_user_id, code_verifier, binding_hash, redirect_uri, expires_at)
         VALUES ('github', 'link', $2, 'verifier', $1, 'https://app.example/callback', now() + interval '5 minutes')`,
        [Buffer.alloc(32, 1), userId],
      ),
    ).resolves.toBeDefined();
  });

  // ---- index -------------------------------------------------------------------

  it("has the partial expiry index scoped to unconsumed rows", async () => {
    const result = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ix_oauth_auth_requests_expiry'",
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]!.indexdef).toMatch(/WHERE \(consumed_at IS NULL\)/);
  });

  // ---- grants: only nominara_app, nothing for worker/report/portal -------------

  it("grants nominara_app full privileges; worker/report/portal have none", async () => {
    const result = await client.query<{
      rolname: string;
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
    }>(
      `SELECT rolname,
         has_table_privilege(rolname, 'oauth_authorization_requests', 'SELECT') AS sel,
         has_table_privilege(rolname, 'oauth_authorization_requests', 'INSERT') AS ins,
         has_table_privilege(rolname, 'oauth_authorization_requests', 'UPDATE') AS upd,
         has_table_privilege(rolname, 'oauth_authorization_requests', 'DELETE') AS del
       FROM (VALUES ('nominara_app'), ('nominara_worker'), ('nominara_report'), ('nominara_portal')) AS t(rolname)`,
    );
    const byRole = new Map(result.rows.map((row) => [row.rolname, row]));
    expect(byRole.get("nominara_app")).toMatchObject({ sel: true, ins: true, upd: true, del: true });
    for (const role of ["nominara_worker", "nominara_report", "nominara_portal"]) {
      expect(byRole.get(role), role).toMatchObject({ sel: false, ins: false, upd: false, del: false });
    }
  });

  it("RUNTIME_ROLES catalog is exactly the 4 roles this test exercises (guards against a silently-added 5th role)", () => {
    expect([...RUNTIME_ROLES].sort()).toEqual(
      ["nominara_app", "nominara_portal", "nominara_report", "nominara_worker"].sort(),
    );
  });

  // ---- down.sql genuinely drops the table; up.sql recreates it -----------------

  it("down.sql genuinely drops the table (not left in place), up.sql genuinely recreates it on reapply", async () => {
    expect(await tableExists()).toBe(true);

    const rolledBack = await rollbackLast(client, migrationsDir);
    expect(rolledBack).toBe(MIGRATION_NAME);

    // Mid-state, BEFORE reapply.
    expect(await tableExists()).toBe(false);

    const reapplied = await migrateUp(client, migrationsDir);
    expect(reapplied).toEqual([MIGRATION_NAME]);

    expect(await tableExists()).toBe(true);
  });
});
