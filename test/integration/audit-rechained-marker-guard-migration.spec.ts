import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";
import { RECHAINED_MARKER_ACTION } from "../../src/lib/crypto/audit-chain.js";

// STORY-020 fix round — code-reviewer should-fix #1: migration 0011
// (0011_audit_rechained_marker_privilege_guard) had no dedicated rollback
// test. test/integration/database-roles-and-grants.spec.ts already proved,
// via mutation testing, that an untested down.sql can be replaced with
// `SELECT 1;` and still pass the full gate suite — this follows that exact
// file's rollback-then-reapply pattern (isolated temp-dir snapshot, a
// mid-state assertion BEFORE reapply proving genuine removal, not just
// before/after symmetry) for this migration specifically.
//
// Renumbered from 0010 to 0011 when rebasing onto main after STORY-019
// merged its own 0010_session_strong_auth migration first.
const MIGRATION_NAME = "0011_audit_rechained_marker_privilege_guard";
const TRIGGER_NAME = "reject_rechained_marker_from_runtime_roles";
const FUNCTION_NAME = "reject_rechained_marker_from_runtime_roles";

describe("STORY-020 · migration 0011 rollback — trigger & function guard", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let migrationsDir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    // Full snapshot through 0011 — the trigger's own guard condition checks
    // current_user against the runtime roles created in 0005, and audit_log
    // (0004) carries RLS (0006) that the behavioral INSERT probes below must
    // satisfy, so this cannot be trimmed down to 0004+0011 alone.
    migrationsDir = await mkdtemp(path.join(tmpdir(), "nominara-story020-0011-isolated-"));
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

  async function catalogCounts(): Promise<{ triggers: number; functions: number }> {
    const triggerResult = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_trigger WHERE tgname = $1 AND tgrelid = 'audit_log'::regclass",
      [TRIGGER_NAME],
    );
    const fnResult = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_proc WHERE proname = $1 AND pronamespace = 'app'::regnamespace",
      [FUNCTION_NAME],
    );
    return {
      triggers: Number(triggerResult.rows[0]!.count),
      functions: Number(fnResult.rows[0]!.count),
    };
  }

  // Exercises the guard behaviorally, not just via catalog metadata — a
  // BEFORE INSERT trigger of the same name that no-ops (rather than genuinely
  // gone/present) would pass a catalog-only check but not this.
  async function attemptRechainedMarkerInsertAsRuntimeApp(): Promise<unknown> {
    const workspaceId = "12121212-1212-1212-1212-121212121212";
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE nominara_app");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      const result = await client.query(
        `INSERT INTO audit_log (workspace_id, actor_type, action, resource_type, request_id, prev_hash, row_hash)
         VALUES ($1, 'user', $2, 'workspace', 'req-0010-rollback', $3, $4) RETURNING seq`,
        [workspaceId, RECHAINED_MARKER_ACTION, Buffer.alloc(32, 0), Buffer.alloc(32, 1)],
      );
      return result;
    } finally {
      await client.query("ROLLBACK");
    }
  }

  it("scenario — down.sql genuinely drops the trigger and function (not left in place), up.sql genuinely recreates them on reapply", async () => {
    const before = await catalogCounts();
    expect(before).toEqual({ triggers: 1, functions: 1 });
    await expect(attemptRechainedMarkerInsertAsRuntimeApp()).rejects.toThrow(
      /marker rows may only be inserted by a privileged/i,
    );

    const rolledBack = await rollbackLast(client, migrationsDir);
    expect(rolledBack).toBe(MIGRATION_NAME);

    // Mid-state, BEFORE reapply — closes the exact gap the STORY-010 mutation
    // test found: a down.sql body swapped for `SELECT 1;` would leave these
    // counts at 1 and the marker insert still blocked.
    const midState = await catalogCounts();
    expect(midState).toEqual({ triggers: 0, functions: 0 });
    await expect(attemptRechainedMarkerInsertAsRuntimeApp()).resolves.toBeDefined();

    const reapplied = await migrateUp(client, migrationsDir);
    expect(reapplied).toEqual([MIGRATION_NAME]);

    const after = await catalogCounts();
    expect(after).toEqual({ triggers: 1, functions: 1 });
    await expect(attemptRechainedMarkerInsertAsRuntimeApp()).rejects.toThrow(
      /marker rows may only be inserted by a privileged/i,
    );
  });
});
