import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUNTIME_ROLES } from "../../src/db/conventions.js";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// STORY-016 · migration 0014 — email one-time codes (fallback sign-in) and
// their rate-limit ledger. Follows
// test/integration/oauth-authorization-requests-migration.spec.ts's exact
// pattern: isolated temp-dir snapshot of the full chain up to and including
// this migration, up -> table/columns/CHECK/index present, grants
// restricted to nominara_app -> rollbackLast -> genuinely gone (mid-state,
// BEFORE reapply) -> reapply -> everything back.
const MIGRATION_NAME = "0014_email_otp";

describe("STORY-016 · migration 0014 — email_otp_codes / email_otp_requests", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let migrationsDir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    migrationsDir = await mkdtemp(path.join(tmpdir(), "nominara-story016-0014-isolated-"));
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
      "0013_oauth_authorization_requests",
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

  async function tableExists(tableName: string): Promise<boolean> {
    const result = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
      [tableName],
    );
    return Number(result.rows[0]!.count) === 1;
  }

  async function createUser(): Promise<string> {
    const result = await client.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [`otp-test-${Math.random().toString(36).slice(2)}@example.com`],
    );
    return result.rows[0]!.id;
  }

  // ---- table/columns present after up ----------------------------------------

  it("creates email_otp_codes with the expected columns and types", async () => {
    const result = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'email_otp_codes'
       ORDER BY ordinal_position`,
    );
    const byName = new Map(result.rows.map((row) => [row.column_name, row]));

    expect(byName.get("id")).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
    expect(byName.get("user_id")).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
    expect(byName.get("code_hash")).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(byName.get("attempts")).toMatchObject({ data_type: "smallint", is_nullable: "NO" });
    expect(byName.get("max_attempts")).toMatchObject({ data_type: "smallint", is_nullable: "NO" });
    expect(byName.get("expires_at")).toMatchObject({ data_type: "timestamp with time zone", is_nullable: "NO" });
    expect(byName.get("consumed_at")).toMatchObject({ data_type: "timestamp with time zone", is_nullable: "YES" });
    expect(byName.get("invalidated_at")).toMatchObject({ data_type: "timestamp with time zone", is_nullable: "YES" });
    expect(byName.get("invalidated_reason")).toMatchObject({ data_type: "text", is_nullable: "YES" });
    expect(byName.get("created_at")).toMatchObject({ data_type: "timestamp with time zone", is_nullable: "NO" });
  });

  it("creates email_otp_requests with the expected columns and types", async () => {
    const result = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'email_otp_requests'
       ORDER BY ordinal_position`,
    );
    const byName = new Map(result.rows.map((row) => [row.column_name, row]));

    expect(byName.get("id")).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
    expect(byName.get("email_hash")).toMatchObject({ data_type: "bytea", is_nullable: "NO" });
    expect(byName.get("source_hash")).toMatchObject({ data_type: "bytea", is_nullable: "YES" });
    expect(byName.get("created_at")).toMatchObject({ data_type: "timestamp with time zone", is_nullable: "NO" });
  });

  it("email_otp_requests accepts a row with no linked user (no FK to users)", async () => {
    await expect(
      client.query("INSERT INTO email_otp_requests (email_hash) VALUES ($1)", [Buffer.alloc(32, 1)]),
    ).resolves.toBeDefined();
  });

  // ---- CHECK constraints -------------------------------------------------------

  it("rejects an invalidated_reason outside attempts_exhausted/superseded", async () => {
    const userId = await createUser();
    await expect(
      client.query(
        `INSERT INTO email_otp_codes (user_id, code_hash, expires_at, invalidated_at, invalidated_reason)
         VALUES ($1, 'hash', now() + interval '10 minutes', now(), 'bogus_reason')`,
        [userId],
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("rejects invalidated_reason set while invalidated_at is NULL", async () => {
    const userId = await createUser();
    await expect(
      client.query(
        `INSERT INTO email_otp_codes (user_id, code_hash, expires_at, invalidated_reason)
         VALUES ($1, 'hash', now() + interval '10 minutes', 'superseded')`,
        [userId],
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("rejects invalidated_at set while invalidated_reason is NULL", async () => {
    const userId = await createUser();
    await expect(
      client.query(
        `INSERT INTO email_otp_codes (user_id, code_hash, expires_at, invalidated_at)
         VALUES ($1, 'hash', now() + interval '10 minutes', now())`,
        [userId],
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("accepts both invalidated_at and invalidated_reason set together, and both left NULL", async () => {
    const userId = await createUser();
    await expect(
      client.query(
        `INSERT INTO email_otp_codes (user_id, code_hash, expires_at, invalidated_at, invalidated_reason)
         VALUES ($1, 'hash', now() + interval '10 minutes', now(), 'attempts_exhausted')`,
        [userId],
      ),
    ).resolves.toBeDefined();

    await expect(
      client.query(
        `INSERT INTO email_otp_codes (user_id, code_hash, expires_at)
         VALUES ($1, 'hash', now() + interval '10 minutes')`,
        [userId],
      ),
    ).resolves.toBeDefined();
  });

  it("cascades delete from users to email_otp_codes", async () => {
    const userId = await createUser();
    await client.query(
      `INSERT INTO email_otp_codes (user_id, code_hash, expires_at) VALUES ($1, 'hash', now() + interval '10 minutes')`,
      [userId],
    );
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    const remaining = await client.query("SELECT count(*) AS count FROM email_otp_codes WHERE user_id = $1", [userId]);
    expect(Number(remaining.rows[0]!.count)).toBe(0);
  });

  // ---- indexes -------------------------------------------------------------------

  it("has the partial 'live codes' index on email_otp_codes(user_id)", async () => {
    const result = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ix_email_otp_codes_live'",
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]!.indexdef).toMatch(/WHERE \(\(consumed_at IS NULL\) AND \(invalidated_at IS NULL\)\)/);
  });

  it("has the rate-limit window indexes on email_otp_requests", async () => {
    const result = await client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'email_otp_requests'",
    );
    const names = result.rows.map((row) => row.indexname);
    expect(names).toContain("ix_email_otp_requests_email_window");
    expect(names).toContain("ix_email_otp_requests_source_window");
  });

  // ---- grants: only nominara_app, nothing for worker/report/portal -------------

  async function grantsFor(tableName: string) {
    const result = await client.query<{
      rolname: string;
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
    }>(
      `SELECT rolname,
         has_table_privilege(rolname, $1, 'SELECT') AS sel,
         has_table_privilege(rolname, $1, 'INSERT') AS ins,
         has_table_privilege(rolname, $1, 'UPDATE') AS upd,
         has_table_privilege(rolname, $1, 'DELETE') AS del
       FROM (VALUES ('nominara_app'), ('nominara_worker'), ('nominara_report'), ('nominara_portal')) AS t(rolname)`,
      [tableName],
    );
    return new Map(result.rows.map((row) => [row.rolname, row]));
  }

  it("grants nominara_app full privileges on both tables; worker/report/portal have none", async () => {
    for (const tableName of ["email_otp_codes", "email_otp_requests"]) {
      const byRole = await grantsFor(tableName);
      expect(byRole.get("nominara_app"), tableName).toMatchObject({ sel: true, ins: true, upd: true, del: true });
      for (const role of ["nominara_worker", "nominara_report", "nominara_portal"]) {
        expect(byRole.get(role), `${role} on ${tableName}`).toMatchObject({ sel: false, ins: false, upd: false, del: false });
      }
    }
  });

  it("RUNTIME_ROLES catalog is exactly the 4 roles this test exercises (guards against a silently-added 5th role)", () => {
    expect([...RUNTIME_ROLES].sort()).toEqual(
      ["nominara_app", "nominara_portal", "nominara_report", "nominara_worker"].sort(),
    );
  });

  // ---- down.sql genuinely drops both tables; up.sql recreates them -------------

  it("down.sql genuinely drops both tables (not left in place), up.sql genuinely recreates them on reapply", async () => {
    expect(await tableExists("email_otp_codes")).toBe(true);
    expect(await tableExists("email_otp_requests")).toBe(true);

    const rolledBack = await rollbackLast(client, migrationsDir);
    expect(rolledBack).toBe(MIGRATION_NAME);

    // Mid-state, BEFORE reapply.
    expect(await tableExists("email_otp_codes")).toBe(false);
    expect(await tableExists("email_otp_requests")).toBe(false);

    const reapplied = await migrateUp(client, migrationsDir);
    expect(reapplied).toEqual([MIGRATION_NAME]);

    expect(await tableExists("email_otp_codes")).toBe(true);
    expect(await tableExists("email_otp_requests")).toBe(true);
  });
});
