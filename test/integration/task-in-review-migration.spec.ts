import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// STORY-055, owner decision 30 - migration 0155 widens tasks.status with `in_review` and task_events.event with the two
// verification kinds (expand phase), and rebuilds ix_tasks_open over the three open statuses.
const MIGRATION = "0155_task_in_review";

describe("STORY-055 · migration 0155 - task status in_review", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
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
    await client.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${workspaceId.slice(0, 8)}`]);
    await client.query("INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'P',$3,'https://p.com','p.com')", [projectId, workspaceId, `p-${projectId.slice(0, 8)}`]);
  });

  const task = async (status: string): Promise<string> => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO tasks (id, workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status)
       VALUES ($1,$2,$3,$4,'authority',$5,'t','d',$6)`,
      [id, workspaceId, projectId, `T-${id.slice(0, 6)}`, randomBytes(16), status],
    );
    return id;
  };
  const event = (taskId: string, kind: string) =>
    client.query("INSERT INTO task_events (workspace_id, task_id, actor_type, event) VALUES ($1,$2,'system',$3)", [workspaceId, taskId, kind]);

  async function rollbackThisMigration(): Promise<void> {
    for (let step = 0; step < 200; step += 1) {
      const name = await rollbackLast(client, MIGRATIONS_DIR);
      if (name === MIGRATION) return;
      expect(name).not.toBeNull();
    }
    throw new Error(`${MIGRATION} was never rolled back`);
  }

  it("S055-MIG-1 · in_review is an accepted task status, the four earlier statuses still are, and an unknown one is still rejected", async () => {
    for (const status of ["todo", "in_progress", "in_review", "done", "dismissed"]) await task(status);
    await expect(task("reviewing")).rejects.toThrow(/violates check constraint/i);
  });

  it("S055-MIG-2 · the two verification events are accepted, the earlier ones still are, and an unknown one is rejected", async () => {
    const id = await task("in_review");
    for (const kind of ["created", "completed", "due_changed", "verification_submitted", "verification_failed"]) await event(id, kind);
    await expect(event(id, "verification_passed")).rejects.toThrow(/violates check constraint/i);
  });

  it("S055-MIG-3 · ix_tasks_open covers in_review, so the open-task queue stays one index scan", async () => {
    const def = (await client.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_tasks_open'")).rows[0].indexdef as string;
    expect(def).toMatch(/in_review/);
  });

  it("S055-MIG-4 · the down migration returns an in_review task to in_progress (still open), drops the verification events, then rejects the new values", async () => {
    const id = await task("in_review");
    await event(id, "verification_submitted");
    await event(id, "verification_failed");
    await event(id, "created");
    await rollbackThisMigration();
    expect((await client.query("SELECT status FROM tasks WHERE id = $1", [id])).rows).toEqual([{ status: "in_progress" }]);
    expect((await client.query("SELECT event FROM task_events WHERE task_id = $1", [id])).rows).toEqual([{ event: "created" }]);
    await expect(task("in_review")).rejects.toThrow(/violates check constraint/i);
    const def = (await client.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_tasks_open'")).rows[0].indexdef as string;
    expect(def).not.toMatch(/in_review/);
  });

  it("S055-MIG-5 · run as the NOSUPERUSER, NOBYPASSRLS owner (production), the down rewrites the rows and leaves FORCE RLS on both tables", async () => {
    const id = await task("in_review");
    await event(id, "verification_submitted");
    // The down rebuilds an index, which creates an object in the schema: the production owner can (it runs every migration).
    await client.query("GRANT USAGE, CREATE ON SCHEMA public TO nominara_owner");
    await client.query("ALTER TABLE tasks OWNER TO nominara_owner");
    await client.query("ALTER TABLE task_events OWNER TO nominara_owner");
    const down = await readFile(path.join(MIGRATIONS_DIR, `${MIGRATION}.down.sql`), "utf8");
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE nominara_owner");
      await client.query(down);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    await client.query("RESET ROLE");
    expect((await client.query("SELECT status FROM tasks WHERE id = $1", [id])).rows).toEqual([{ status: "in_progress" }]);
    expect((await client.query("SELECT 1 FROM task_events WHERE event = 'verification_submitted'")).rows).toEqual([]);
    const forced = await client.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('tasks','task_events') AND relkind = 'r' ORDER BY relname");
    expect(forced.rows).toEqual([
      { relname: "task_events", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "tasks", relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it("S055-MIG-6 · the migration re-applies cleanly after a rollback", async () => {
    await rollbackThisMigration();
    const applied = await migrateUp(client, MIGRATIONS_DIR);
    expect(applied).toContain(MIGRATION);
    await expect(task("in_review")).resolves.toBeDefined();
  });
});
