import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// Group C review (owner decision B) · migration 0126 — scheduled_report_deliveries.status gains `sending`.
const TABLE = "scheduled_report_deliveries";
const NAME = "0126_scheduled_report_delivery_sending";

describe("migration 0126 — delivery status `sending`", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 180_000);
  afterAll(async () => {
    await container.stop();
  });
  beforeEach(async () => {
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrateUp(client, MIGRATIONS_DIR);
  });
  afterEach(async () => {
    await client.end();
  });

  async function report(): Promise<{ workspaceId: string; reportId: string }> {
    const ws = await client.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ('W', $1, 'free') RETURNING id", [`w-${Math.random().toString(36).slice(2, 8)}`]);
    const workspaceId = ws.rows[0]!.id;
    const r = await client.query<{ id: string }>(
      `INSERT INTO scheduled_reports (workspace_id, name, project_ids, cadence, recipients)
       VALUES ($1, 'R', ARRAY[gen_random_uuid()], 'weekly', ARRAY['o@example.com']::citext[]) RETURNING id`,
      [workspaceId],
    );
    return { workspaceId, reportId: r.rows[0]!.id };
  }
  const insert = (workspaceId: string, reportId: string, status: string, reason: string | null = null) =>
    client.query(`INSERT INTO ${TABLE} (workspace_id, scheduled_report_id, status, reason, recipient_count) VALUES ($1,$2,$3,$4,1)`, [workspaceId, reportId, status, reason]);

  it("up admits `sending` (and still rejects an unknown status)", async () => {
    const { workspaceId, reportId } = await report();
    await insert(workspaceId, reportId, "sending");
    await expect(insert(workspaceId, reportId, "sent")).rejects.toThrow(/violates check constraint/i);
  });

  it("down turns a seeded `sending` row into `failed` WITH a reason, keeps other rows, and re-narrows the CHECK; up again re-admits `sending`", async () => {
    const { workspaceId, reportId } = await report();
    await insert(workspaceId, reportId, "sending");
    await insert(workspaceId, reportId, "failed", "render exploded");
    await insert(workspaceId, reportId, "logged");

    expect(await rollbackLast(client, MIGRATIONS_DIR)).toBe(NAME);

    const rows = (await client.query(`SELECT status, reason FROM ${TABLE} ORDER BY status, reason NULLS LAST`)).rows as Array<{ status: string; reason: string | null }>;
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "failed", "logged"]);
    const rewritten = rows.find((r) => r.reason?.includes("rolled back from sending"));
    expect(rewritten, "the rewritten row must carry the reason").toBeDefined();
    expect(rows.some((r) => r.reason === "render exploded")).toBe(true); // an existing reason is preserved, not overwritten
    await expect(insert(workspaceId, reportId, "sending")).rejects.toThrow(/violates check constraint/i);

    await migrateUp(client, MIGRATIONS_DIR);
    await insert(workspaceId, reportId, "sending");
  });
});
