import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { RollupRebuildProjectNotFoundError, rebuildJobKey, runRollupRebuild } from "../../src/workers/rollup/rollup-rebuild.js";

// STORY-042 AC10 — the rebuild entry point. There is no admin HTTP surface (AdminController is an empty scaffold and the
// IP allow-list plus step-up auth AdminModule needs is unbuilt), so the entry point is an audited operator CLI
// (planner recommendation, same shape as plan:set / support:grant). Scenario 11 (rebuild equals incremental) is proven
// against the handler in rollup-metric-daily.spec.ts; this proves the thing that ENQUEUES it.

describe("STORY-042 AC10 · pnpm rollup:rebuild", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let otherWorkspaceId: string;
  const calls: Array<{ queue: string; workspaceId: string; payload: Record<string, unknown>; key: string }> = [];
  const enqueue = async (queue: "rollup.metric_daily", ws: string, payload: Record<string, unknown>, key: string): Promise<void> => {
    calls.push({ queue, workspaceId: ws, payload, key });
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);
  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE projects, workspaces CASCADE");
    calls.length = 0;
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    projectId = randomUUID();
    for (const w of [workspaceId, otherWorkspaceId]) {
      await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1,'W',$2,'growth')", [w, `w-${randomUUID().slice(0, 8)}`]);
    }
    await db.query(
      "INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://e.test','e.test')",
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  const args = () => ({ workspaceId, projectId, fromDate: "2026-09-01", toDate: "2026-09-30", operator: "ana", ticket: "OPS-42" });

  it("STORY-042 AC10 · enqueues ONE signed-range rebuild job for the project and writes an audit row naming operator and ticket", async () => {
    await runRollupRebuild(args(), { client: db, enqueue });

    expect(calls).toEqual([
      {
        queue: "rollup.metric_daily",
        workspaceId,
        payload: { projectId, fromDate: "2026-09-01", toDate: "2026-09-30", reason: "rebuild" },
        key: rebuildJobKey(projectId, "2026-09-01", "2026-09-30", "OPS-42"),
      },
    ]);
    const audit = await db.query("SELECT action, resource_type, resource_id, actor_ua, request_id, after_state FROM audit_log WHERE workspace_id = $1", [workspaceId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: "rollup.rebuild_requested", resource_type: "project", resource_id: projectId, actor_ua: "operator:ana", request_id: "OPS-42" });
    expect(audit.rows[0].after_state).toMatchObject({ from_date: "2026-09-01", to_date: "2026-09-30", ticket: "OPS-42", operator: "ana" });
  }, 60_000);

  it("STORY-042 AC10 · the same command twice asks for the same job key (a re-run is not a second rebuild)", async () => {
    await runRollupRebuild(args(), { client: db, enqueue });
    await runRollupRebuild(args(), { client: db, enqueue });
    expect(new Set(calls.map((c) => c.key)).size).toBe(1);
  }, 60_000);

  it("STORY-042 AC10 · a project that is not in the named workspace is refused: no audit row, nothing enqueued", async () => {
    await expect(runRollupRebuild({ ...args(), workspaceId: otherWorkspaceId }, { client: db, enqueue })).rejects.toBeInstanceOf(RollupRebuildProjectNotFoundError);
    await expect(runRollupRebuild({ ...args(), projectId: randomUUID() }, { client: db, enqueue })).rejects.toBeInstanceOf(RollupRebuildProjectNotFoundError);
    expect(calls).toEqual([]);
    expect((await db.query("SELECT 1 FROM audit_log WHERE workspace_id = ANY($1::uuid[])", [[workspaceId, otherWorkspaceId]])).rowCount).toBe(0);
  }, 60_000);

  it("STORY-042 AC10 · a deleted project is refused", async () => {
    await db.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [projectId]);
    await expect(runRollupRebuild(args(), { client: db, enqueue })).rejects.toBeInstanceOf(RollupRebuildProjectNotFoundError);
  }, 60_000);

  it("STORY-042 AC10 · an enqueue failure is thrown (exit 1), after the audit row committed — the attempt is on the record", async () => {
    await expect(
      runRollupRebuild(args(), {
        client: db,
        enqueue: async () => {
          throw new Error("queue down");
        },
      }),
    ).rejects.toThrow("queue down");
    expect((await db.query("SELECT 1 FROM audit_log WHERE workspace_id = $1 AND action = 'rollup.rebuild_requested'", [workspaceId])).rowCount).toBe(1);
  }, 60_000);
});
