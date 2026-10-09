import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// Owner decision (8), checkpoint 2 — a competitor removal gets its own milestone
// kind, `competitor_removed`, instead of reusing `competitor_added` under a
// title that says "removed". Migration 0098 widens the milestones.kind CHECK.
const MIGRATION = "0098_milestone_competitor_removed";
const NINE_EXISTING_KINDS = [
  "task_completed",
  "deployment",
  "aux_status_change",
  "schema_fixed",
  "source_seeded",
  "competitor_added",
  "engine_model_change",
  "prompt_set_change",
  "annotation",
];

describe("CP2 c-comp · migration 0098 — milestone kind competitor_removed", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
  }, 300_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  beforeEach(async () => {
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrateUp(client, MIGRATIONS_DIR);
    workspaceId = randomUUID();
    projectId = randomUUID();
    await client.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [
      workspaceId,
      `w-${workspaceId.slice(0, 8)}`,
    ]);
    await client.query(
      "INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'P',$3,'https://p.com','p.com')",
      [projectId, workspaceId, `p-${projectId.slice(0, 8)}`],
    );
  });

  const milestone = (kind: string) =>
    client.query("INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title) VALUES ($1,$2,now(),$3,'t')", [
      workspaceId,
      projectId,
      kind,
    ]);

  /** Roll back until 0098 itself is undone, whatever migrations a later lane stacks above it. */
  async function rollbackThisMigration(): Promise<void> {
    for (let step = 0; step < 200; step += 1) {
      const name = await rollbackLast(client, MIGRATIONS_DIR);
      if (name === MIGRATION) return;
      expect(name).not.toBeNull();
    }
    throw new Error(`${MIGRATION} was never rolled back`);
  }

  it("CP2-C-MS-1 · competitor_removed is an accepted milestone kind", async () => {
    await expect(milestone("competitor_removed")).resolves.toBeDefined();
  });

  it("CP2-C-MS-2 · all nine earlier kinds are still accepted, and an unknown kind is still rejected", async () => {
    for (const kind of NINE_EXISTING_KINDS) await milestone(kind);
    await expect(milestone("competitor_deleted")).rejects.toThrow(/violates check constraint/i);
  });

  it("CP2-C-MS-3 · the down migration keeps a competitor_removed row by turning it back into competitor_added, then rejects the new kind", async () => {
    await milestone("competitor_removed");
    await rollbackThisMigration();
    const rows = await client.query("SELECT kind FROM milestones");
    expect(rows.rows).toEqual([{ kind: "competitor_added" }]);
    await expect(milestone("competitor_removed")).rejects.toThrow(/violates check constraint/i);
  });

  it("CP2-C-MS-4 · the migration re-applies cleanly after a rollback", async () => {
    await rollbackThisMigration();
    const applied = await migrateUp(client, MIGRATIONS_DIR);
    expect(applied).toContain(MIGRATION);
    await expect(milestone("competitor_removed")).resolves.toBeDefined();
  });
});
