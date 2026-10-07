import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PORTAL_READABLE_TABLES } from "../../src/db/conventions.js";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";
import { TENANT_TABLES } from "../../src/db/rls/tenant-tables.generated.js";

// NEW-E-1 · migration 0051 (Track E lane range) — D6 nullable brand colours,
// the share_tokens.scope_tabs vocabulary {overview,growth_map,matrix,sources,
// tasks}, and the tenant-scoped scheduled_report_deliveries table.
const TABLE = "scheduled_report_deliveries";

describe("NEW-E-1 · migration 0051 — Track E sharing", () => {
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

  async function rollbackBoth(): Promise<void> {
    expect(await rollbackLast(client, MIGRATIONS_DIR)).toBe("0080_portal_session_gate");
    expect(await rollbackLast(client, MIGRATIONS_DIR)).toBe("0079_scheduled_report_deliveries_tenant_fk");
    expect(await rollbackLast(client, MIGRATIONS_DIR)).toBe("0052_track_e_sharing_validate");
    expect(await rollbackLast(client, MIGRATIONS_DIR)).toBe("0051_track_e_sharing");
  }

  async function workspace(label: string): Promise<{ workspaceId: string; userId: string; projectId: string; reportId: string }> {
    const ws = await client.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'free') RETURNING id",
      [`WS ${label}`, `ws-${label}-${Math.random().toString(36).slice(2, 8)}`],
    );
    const workspaceId = ws.rows[0]!.id;
    const u = await client.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `${label}-${Math.random().toString(36).slice(2)}@example.com`,
    ]);
    const userId = u.rows[0]!.id;
    const r = await client.query<{ id: string }>(
      `INSERT INTO scheduled_reports (workspace_id, name, project_ids, cadence, recipients)
       VALUES ($1, 'R', ARRAY[gen_random_uuid()], 'weekly', ARRAY['o@example.com']::citext[]) RETURNING id`,
      [workspaceId],
    );
    return { workspaceId, userId, projectId: "", reportId: r.rows[0]!.id };
  }

  async function insertToken(workspaceId: string, userId: string, tabs: string[]): Promise<void> {
    await client.query(
      `INSERT INTO share_tokens (workspace_id, label, token_hash, token_prefix, scope_project_ids, scope_tabs, created_by)
       VALUES ($1, 'L', $2, 'abcd1234', ARRAY[gen_random_uuid()], $3::text[], $4)`,
      [workspaceId, Buffer.from(Math.random().toString()), tabs, userId],
    );
  }

  it("NEW-E-1 AC1 · the new table has forced RLS and a ws_isolation policy", async () => {
    const rls = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relkind = 'r'",
      [TABLE],
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = await client.query("SELECT policyname FROM pg_policies WHERE tablename = $1", [TABLE]);
    expect(pol.rows.map((r) => r.policyname)).toEqual([`ws_isolation_${TABLE}`]);
  });

  it("NEW-E-1 AC1 · the new table is a tenant table and is NOT portal-readable", () => {
    expect(TENANT_TABLES.has(TABLE)).toBe(true);
    expect(PORTAL_READABLE_TABLES as readonly string[]).not.toContain(TABLE);
  });

  it("NEW-E-1 AC1 · a foreign-tenant insert is rejected (ISO-03 pattern), an own-tenant insert succeeds", async () => {
    const a = await workspace("a");
    const b = await workspace("b");
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE nominara_app");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [a.workspaceId]);
      await expect(
        client.query(`INSERT INTO ${TABLE} (workspace_id, scheduled_report_id, status, recipient_count) VALUES ($1, $2, 'delivered', 1)`, [
          a.workspaceId,
          a.reportId,
        ]),
      ).resolves.toBeDefined();
      await client.query("SAVEPOINT s");
      await expect(
        client.query(`INSERT INTO ${TABLE} (workspace_id, scheduled_report_id, status, recipient_count) VALUES ($1, $2, 'delivered', 1)`, [
          b.workspaceId,
          b.reportId,
        ]),
      ).rejects.toThrow(/row-level security/i);
      await client.query("ROLLBACK TO SAVEPOINT s");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("NEW-E-1 · status CHECK admits exactly delivered/failed/skipped_cap/logged", async () => {
    const a = await workspace("c");
    for (const status of ["delivered", "failed", "skipped_cap", "logged"]) {
      await client.query(`INSERT INTO ${TABLE} (workspace_id, scheduled_report_id, status, recipient_count) VALUES ($1, $2, $3, 0)`, [
        a.workspaceId,
        a.reportId,
        status,
      ]);
    }
    await expect(
      client.query(`INSERT INTO ${TABLE} (workspace_id, scheduled_report_id, status, recipient_count) VALUES ($1, $2, 'sent', 0)`, [
        a.workspaceId,
        a.reportId,
      ]),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("NEW-E-1 AC2 · share_tokens accepts {growth_map,matrix} and rejects an unknown tab", async () => {
    const a = await workspace("d");
    await expect(insertToken(a.workspaceId, a.userId, ["growth_map", "matrix"])).resolves.toBeUndefined();
    await expect(insertToken(a.workspaceId, a.userId, ["overview", "sources", "tasks"])).resolves.toBeUndefined();
    await expect(insertToken(a.workspaceId, a.userId, ["bogus"])).rejects.toThrow(/violates check constraint/i);
  });

  it("NEW-E-1 AC2 · the retired tabs 'tracking' and 'aux' are no longer accepted", async () => {
    const a = await workspace("e");
    await expect(insertToken(a.workspaceId, a.userId, ["tracking"])).rejects.toThrow(/violates check constraint/i);
    await expect(insertToken(a.workspaceId, a.userId, ["aux"])).rejects.toThrow(/violates check constraint/i);
  });

  it("NEW-E-1 AC3 · a brand_themes row inserted with no colours stores NULLs (D6)", async () => {
    const a = await workspace("f");
    const r = await client.query(
      "INSERT INTO brand_themes (workspace_id) VALUES ($1) RETURNING color_primary, color_accent, color_bg, color_fg",
      [a.workspaceId],
    );
    expect(r.rows[0]).toEqual({ color_primary: null, color_accent: null, color_bg: null, color_fg: null });
  });

  it("NEW-E-1 AC4 · up/down/up is clean and down restores the prior constraints", async () => {
    await rollbackBoth();
    const gone = await client.query("SELECT 1 FROM information_schema.tables WHERE table_name = $1", [TABLE]);
    expect(gone.rowCount).toBe(0);
    const col = await client.query<{ is_nullable: string; column_default: string | null }>(
      "SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name='brand_themes' AND column_name='color_primary'",
    );
    expect(col.rows[0]!.is_nullable).toBe("NO");
    expect(col.rows[0]!.column_default).toContain("#4f46e5");
    const a = await workspace("g");
    await expect(insertToken(a.workspaceId, a.userId, ["tracking", "aux"])).resolves.toBeUndefined();
    await expect(insertToken(a.workspaceId, a.userId, ["growth_map"])).rejects.toThrow(/violates check constraint/i);
    await migrateUp(client, MIGRATIONS_DIR);
    const back = await client.query("SELECT 1 FROM information_schema.tables WHERE table_name = $1", [TABLE]);
    expect(back.rowCount).toBe(1);
  });

  it("NEW-E-1 · up maps existing 'tracking'/'aux' rows into the new vocabulary instead of failing", async () => {
    await rollbackBoth();
    const a = await workspace("h");
    await insertToken(a.workspaceId, a.userId, ["overview", "tracking", "aux"]);
    await insertToken(a.workspaceId, a.userId, ["aux"]);
    await migrateUp(client, MIGRATIONS_DIR);
    const r = await client.query<{ scope_tabs: string[] }>("SELECT scope_tabs FROM share_tokens ORDER BY array_length(scope_tabs,1) DESC");
    expect(r.rows[0]!.scope_tabs.sort()).toEqual(["growth_map", "matrix", "overview"]);
    expect(r.rows[1]!.scope_tabs).toEqual(["overview"]);
  });
});
