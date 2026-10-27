import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// Owner decision 2026-10-27 (item 2) — a recovery that follows a completed task pins its
// own milestone kind, `displacement_recovered`. Migration 0142 widens milestones.kind (expand phase).
const MIGRATION = "0142_milestone_displacement_recovered";
const TEN_EXISTING_KINDS = [
  "task_completed",
  "deployment",
  "aux_status_change",
  "schema_fixed",
  "source_seeded",
  "competitor_added",
  "competitor_removed",
  "engine_model_change",
  "prompt_set_change",
  "annotation",
];

describe("STORY-056 · migration 0142 — milestone kind displacement_recovered", () => {
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

  /** Roll back until 0142 itself is undone, whatever migrations a later lane stacks above it. */
  async function rollbackThisMigration(): Promise<void> {
    for (let step = 0; step < 200; step += 1) {
      const name = await rollbackLast(client, MIGRATIONS_DIR);
      if (name === MIGRATION) return;
      expect(name).not.toBeNull();
    }
    throw new Error(`${MIGRATION} was never rolled back`);
  }

  it("S056-MS-1 · displacement_recovered is an accepted milestone kind", async () => {
    await expect(milestone("displacement_recovered")).resolves.toBeDefined();
  });

  it("S056-MS-2 · all ten earlier kinds are still accepted, and an unknown kind is still rejected", async () => {
    for (const kind of TEN_EXISTING_KINDS) await milestone(kind);
    await expect(milestone("displacement_deleted")).rejects.toThrow(/violates check constraint/i);
  });

  it("S056-MS-3 · the down migration keeps a displacement_recovered row by turning it into an annotation, then rejects the new kind", async () => {
    await milestone("displacement_recovered");
    await rollbackThisMigration();
    const rows = await client.query("SELECT kind FROM milestones");
    expect(rows.rows).toEqual([{ kind: "annotation" }]);
    await expect(milestone("displacement_recovered")).rejects.toThrow(/violates check constraint/i);
  });

  it("S056-MS-4 · the migration re-applies cleanly after a rollback", async () => {
    await rollbackThisMigration();
    const applied = await migrateUp(client, MIGRATIONS_DIR);
    expect(applied).toContain(MIGRATION);
    await expect(milestone("displacement_recovered")).resolves.toBeDefined();
  });
});
