import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";

// Migration 0127 - invoices.due_at. period_start / period_end become the SERVICE period, so the due date needs its own
// column. Existing rows hold the invoice-level end in period_end (the old past-due proxy); the backfill copies it so no
// existing invoice's past-due answer changes. invoices is FORCE RLS, so the file is run the production way: as the
// NOSUPERUSER, NOBYPASSRLS nominara_owner, which would update ZERO rows if FORCE were not lifted around the backfill.

const NAME = "0127_invoices_due_at";

describe("migration 0127 - invoices.due_at", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let baselineDir: string;
  const workspaceId = randomUUID();
  const ended = new Date(Date.UTC(2026, 8, 1, 12, 0, 0));

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    baselineDir = await mkdtemp(path.join(tmpdir(), "nominara-0127-"));
    for (const entry of await readdir(MIGRATIONS_DIR)) {
      if (entry.slice(0, 4) < "0127") await copyFile(path.join(MIGRATIONS_DIR, entry), path.join(baselineDir, entry));
    }
    await migrateUp(client, baselineDir);
    await client.query(`INSERT INTO plans (key, display_name, monthly_price, annual_price, entitlements) VALUES ('free','Free',0,0,'{}') ON CONFLICT (key) DO NOTHING`);
    await client.query(`INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1,'W',$2,'free')`, [workspaceId, `w-${workspaceId.slice(0, 8)}`]);
    for (const n of [1, 2]) {
      await client.query(
        `INSERT INTO invoices (workspace_id, stripe_invoice_id, status, subtotal, total, period_start, period_end)
         VALUES ($1,$2,'open',129,129,$3,$4)`,
        [workspaceId, `in_${n}`, new Date(ended.getTime() - n * 1000), new Date(ended.getTime() + n * 1000)],
      );
    }
  }, 300_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
    if (baselineDir) await rm(baselineDir, { recursive: true, force: true });
  });

  it("up, run as the NOBYPASSRLS owner, backfills due_at = period_end on every existing row and leaves FORCE RLS on; down drops the column; up again restores it", async () => {
    const policy = async () => (await client.query("SELECT cmd, roles, qual, with_check FROM pg_policies WHERE tablename = 'invoices' AND policyname = 'ws_isolation_invoices'")).rows;
    const policyBefore = await policy();
    expect(policyBefore).toHaveLength(1);
    await client.query("ALTER TABLE invoices OWNER TO nominara_owner");
    const attrs = (await client.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'nominara_owner'")).rows[0];
    expect(attrs).toEqual({ rolsuper: false, rolbypassrls: false });

    const up = await readFile(path.join(MIGRATIONS_DIR, `${NAME}.up.sql`), "utf8");
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE nominara_owner");
    await client.query(up);
    await client.query("COMMIT");
    await client.query("RESET ROLE");

    const rows = (await client.query("SELECT stripe_invoice_id, due_at, period_end FROM invoices ORDER BY stripe_invoice_id")).rows as Array<{ due_at: Date | null; period_end: Date }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.due_at?.getTime()).toBe(row.period_end.getTime());
    expect((await client.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'invoices' AND relkind = 'r'")).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await policy()).toEqual(policyBefore);

    const down = await readFile(path.join(MIGRATIONS_DIR, `${NAME}.down.sql`), "utf8");
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE nominara_owner");
    await client.query(down);
    await client.query("COMMIT");
    await client.query("RESET ROLE");
    const cols = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'due_at'");
    expect(cols.rowCount).toBe(0);
    expect((await client.query("SELECT count(*)::int AS n FROM invoices")).rows[0]).toEqual({ n: 2 });

    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE nominara_owner");
    await client.query(up);
    await client.query("COMMIT");
    await client.query("RESET ROLE");
    expect((await client.query("SELECT count(*)::int AS n FROM invoices WHERE due_at = period_end")).rows[0]).toEqual({ n: 2 });
  });
});
