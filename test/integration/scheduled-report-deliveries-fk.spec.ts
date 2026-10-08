import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// CP1 re-audit (e-reports MAJOR) — scheduled_report_deliveries must not be able
// to reference another tenant's scheduled report or artifact. Postgres checks FKs
// without RLS, so a single-column FK accepted a foreign id and let tenant B's
// delete cascade into tenant A's history, and gave an FK-error existence oracle.
// The FKs are composite on (workspace_id, id).
const TABLE = "scheduled_report_deliveries";

describe("CP1 e-reports · scheduled_report_deliveries foreign keys are tenant-consistent", () => {
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

  async function tenant(label: string): Promise<{ workspaceId: string; reportId: string; artifactId: string }> {
    const ws = await client.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'free') RETURNING id", [
      `WS ${label}`,
      `ws-${label}-${Math.random().toString(36).slice(2, 8)}`,
    ]);
    const workspaceId = ws.rows[0]!.id;
    const r = await client.query<{ id: string }>(
      `INSERT INTO scheduled_reports (workspace_id, name, project_ids, cadence, recipients)
       VALUES ($1, 'R', ARRAY[gen_random_uuid()], 'weekly', ARRAY['o@example.com']::citext[]) RETURNING id`,
      [workspaceId],
    );
    const art = await client.query<{ id: string }>(
      `INSERT INTO report_artifacts (workspace_id, project_ids, period_start, period_end, format, object_key, bytes, methodology_footer, expires_at)
       VALUES ($1, ARRAY[gen_random_uuid()], '2026-01-01', '2026-01-31', 'pdf', 'k', 1, '{}'::jsonb, now() + interval '1 day') RETURNING id`,
      [workspaceId],
    );
    return { workspaceId, reportId: r.rows[0]!.id, artifactId: art.rows[0]!.id };
  }

  async function asTenant<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE nominara_app");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      return await fn();
    } finally {
      await client.query("ROLLBACK");
    }
  }

  it("CP1-E-FK-1 · tenant A cannot insert a delivery that names tenant B's scheduled report", async () => {
    const a = await tenant("a");
    const b = await tenant("b");
    await asTenant(a.workspaceId, async () => {
      await expect(
        client.query(`INSERT INTO ${TABLE} (workspace_id, scheduled_report_id, status) VALUES ($1, $2, 'failed')`, [a.workspaceId, b.reportId]),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  it("CP1-E-FK-2 · tenant A cannot name tenant B's report artifact", async () => {
    const a = await tenant("a");
    const b = await tenant("b");
    await asTenant(a.workspaceId, async () => {
      await expect(
        client.query(`INSERT INTO ${TABLE} (workspace_id, scheduled_report_id, status, report_artifact_id) VALUES ($1, $2, 'delivered', $3)`, [
          a.workspaceId,
          a.reportId,
          b.artifactId,
        ]),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  it("CP1-E-FK-3 · a same-tenant delivery with its own report and artifact is accepted", async () => {
    const a = await tenant("a");
    await asTenant(a.workspaceId, async () => {
      await expect(
        client.query(`INSERT INTO ${TABLE} (workspace_id, scheduled_report_id, status, report_artifact_id) VALUES ($1, $2, 'delivered', $3)`, [
          a.workspaceId,
          a.reportId,
          a.artifactId,
        ]),
      ).resolves.toBeDefined();
    });
  });

  it("CP1-E-FK-4 · deleting the report cascades to its own deliveries only", async () => {
    const a = await tenant("a");
    const b = await tenant("b");
    for (const t of [a, b]) {
      await client.query(`INSERT INTO ${TABLE} (workspace_id, scheduled_report_id, status) VALUES ($1, $2, 'logged')`, [t.workspaceId, t.reportId]);
    }
    await client.query("DELETE FROM scheduled_reports WHERE id = $1", [b.reportId]);
    const left = await client.query<{ workspace_id: string }>(`SELECT workspace_id FROM ${TABLE}`);
    expect(left.rows).toEqual([{ workspace_id: a.workspaceId }]);
  });

  it("CP1-E-FK-5 · deleting the artifact nulls report_artifact_id and keeps workspace_id", async () => {
    const a = await tenant("a");
    await client.query(`INSERT INTO ${TABLE} (workspace_id, scheduled_report_id, status, report_artifact_id) VALUES ($1, $2, 'delivered', $3)`, [
      a.workspaceId,
      a.reportId,
      a.artifactId,
    ]);
    await client.query("DELETE FROM report_artifacts WHERE id = $1", [a.artifactId]);
    const row = await client.query<{ workspace_id: string; report_artifact_id: string | null }>(`SELECT workspace_id, report_artifact_id FROM ${TABLE}`);
    expect(row.rows).toEqual([{ workspace_id: a.workspaceId, report_artifact_id: null }]);
  });

  it("CP1-E-FK-6 · the new migration rolls back and re-applies cleanly", async () => {
    // Roll back UNTIL this migration rather than assuming it is the newest (later lanes add migrations).
    let rolledBack: string | null = null;
    for (let step = 0; step < 200 && rolledBack !== "0079_scheduled_report_deliveries_tenant_fk" && (step === 0 || rolledBack !== null); step += 1) {
      rolledBack = await rollbackLast(client, MIGRATIONS_DIR);
    }
    expect(rolledBack).toBe("0079_scheduled_report_deliveries_tenant_fk");
    const a = await tenant("a");
    const b = await tenant("b");
    // single-column FKs are back: the cross-tenant row is accepted again
    await expect(
      client.query(`INSERT INTO ${TABLE} (workspace_id, scheduled_report_id, status) VALUES ($1, $2, 'failed')`, [a.workspaceId, b.reportId]),
    ).resolves.toBeDefined();
    await client.query(`DELETE FROM ${TABLE}`);
    await migrateUp(client, MIGRATIONS_DIR);
    await expect(
      client.query(`INSERT INTO ${TABLE} (workspace_id, scheduled_report_id, status) VALUES ($1, $2, 'failed')`, [a.workspaceId, b.reportId]),
    ).rejects.toThrow(/foreign key/i);
  });
});
