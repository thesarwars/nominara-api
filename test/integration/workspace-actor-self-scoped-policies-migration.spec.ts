import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// qa-reviewer mutation testing, STORY-021 close-out — gap 1: migration
// 0012's down.sql was never executed by any test (an always-required gate
// with zero CI coverage for this story). Follows
// test/integration/audit-rechained-marker-guard-migration.spec.ts's exact
// pattern (STORY-020's own precedent for this class of gap): isolated
// temp-dir snapshot, up -> both policies present -> rollbackLast -> both
// genuinely dropped (mid-state assertion BEFORE reapply) -> reapply ->
// both recreated.
const MIGRATION_NAME = "0012_actor_self_scoped_membership_policies";

describe("STORY-021 · migration 0012 rollback — actor-self-scoped policies", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let migrationsDir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    // 0012 is additive on top of 0002 (workspace_members/workspaces),
    // 0005 (nominara_app role), and 0006 (RLS enabled/FORCE plus the
    // app.current_workspace()/app.current_actor() functions the new
    // policies call) — no later migration touches either table's RLS.
    migrationsDir = await mkdtemp(path.join(tmpdir(), "nominara-story021-0012-isolated-"));
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

  async function policyCounts(): Promise<{ workspaceMembers: number; workspaces: number }> {
    const membersResult = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_policies WHERE schemaname = 'public' AND tablename = 'workspace_members' AND policyname = 'self_membership_workspace_members'",
    );
    const workspacesResult = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_policies WHERE schemaname = 'public' AND tablename = 'workspaces' AND policyname = 'self_membership_workspaces'",
    );
    return {
      workspaceMembers: Number(membersResult.rows[0]!.count),
      workspaces: Number(workspacesResult.rows[0]!.count),
    };
  }

  it("scenario — down.sql genuinely drops both actor-self-scoped policies (not left in place), up.sql genuinely recreates them on reapply", async () => {
    const before = await policyCounts();
    expect(before).toEqual({ workspaceMembers: 1, workspaces: 1 });

    const rolledBack = await rollbackLast(client, migrationsDir);
    expect(rolledBack).toBe(MIGRATION_NAME);

    // Mid-state, BEFORE reapply — a down.sql body swapped for `SELECT 1;`
    // would leave these counts at 1, exactly the gap qa-reviewer's mutation
    // testing was checking for.
    const midState = await policyCounts();
    expect(midState).toEqual({ workspaceMembers: 0, workspaces: 0 });

    // 0006's own ws_isolation_* policies on these same two tables are
    // untouched by 0012's down.sql — proves the rollback is scoped to
    // exactly the two policies it created, not the whole RLS surface.
    const ws0006Result = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_policies WHERE schemaname = 'public' AND tablename = 'workspace_members' AND policyname = 'ws_isolation_workspace_members'",
    );
    expect(Number(ws0006Result.rows[0]!.count)).toBe(1);

    const reapplied = await migrateUp(client, migrationsDir);
    expect(reapplied).toEqual([MIGRATION_NAME]);

    const after = await policyCounts();
    expect(after).toEqual({ workspaceMembers: 1, workspaces: 1 });
  });
});
