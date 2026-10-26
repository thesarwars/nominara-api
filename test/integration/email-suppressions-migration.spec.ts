import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_TABLES, RUNTIME_ROLES, expectedTablePrivileges } from "../../src/db/conventions.js";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";

// STORY-178 AC2 · migration 0141 — email_suppressions, a GLOBAL table (owner decision 9): a hard bounce is a property of the
// address, and the sending reputation it protects is shared. It holds the peppered hash only.
const TABLE = "email_suppressions";
const NAME = "0141_email_suppressions";
const HASH = Buffer.alloc(32, 7);

describe("migration 0141 — email_suppressions", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
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
    await client.query("GRANT USAGE ON SCHEMA public TO PUBLIC");
    await migrateUp(client, MIGRATIONS_DIR);
  });
  afterEach(async () => {
    await client.end();
  });

  const insert = (over: { hash?: Buffer; kind?: string; event?: string } = {}) =>
    client.query(`INSERT INTO ${TABLE} (recipient_hash, kind, provider_event_id) VALUES ($1,$2,$3)`, [over.hash ?? HASH, over.kind ?? "bounce", over.event ?? "msg_1"]);

  it("holds a hash, never an address: there is no column that could carry one", async () => {
    const cols = await client.query<{ column_name: string; data_type: string }>("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position", [TABLE]);
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r.data_type]));
    expect(byName.recipient_hash).toBe("bytea");
    expect(Object.keys(byName).filter((n) => /email|address|recipient$|^to$/u.test(n))).toEqual([]);
  });

  it("is a GLOBAL table: no workspace_id, no row-level security, and conventions.ts says so", async () => {
    const cols = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'workspace_id'", [TABLE]);
    expect(cols.rowCount).toBe(0);
    const rls = await client.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE relname = $1", [TABLE]);
    expect(rls.rows[0]!.relrowsecurity).toBe(false);
    expect(GLOBAL_TABLES).toContain(TABLE);
  });

  it("the kind is bounce or complaint and nothing else; a hash is exactly 32 bytes; an event id is not empty", async () => {
    await insert({ kind: "bounce", event: "e1" });
    await insert({ kind: "complaint", event: "e2" });
    await expect(insert({ kind: "transient", event: "e3" })).rejects.toThrow(/violates check constraint/i);
    await expect(insert({ hash: Buffer.alloc(31), event: "e4" })).rejects.toThrow(/violates check constraint/i);
    await expect(insert({ event: "" })).rejects.toThrow(/violates check constraint/i);
  });

  it("a redelivered event for the same address is a conflict; the same event for ANOTHER address in its `to` list is not", async () => {
    await insert({ event: "evt_a" });
    await expect(insert({ event: "evt_a" })).rejects.toThrow(/unique|duplicate/i);
    await insert({ event: "evt_a", hash: Buffer.alloc(32, 9) });
  });

  it("a lifted suppression keeps its row (so a replayed event stays a no-op) and leaves the active index", async () => {
    await insert({ event: "evt_b" });
    await client.query(`UPDATE ${TABLE} SET deleted_at = now()`);
    await expect(insert({ event: "evt_b" })).rejects.toThrow(/unique|duplicate/i);
    const idx = await client.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexdef ILIKE '%recipient_hash%' AND indexdef ILIKE '%deleted_at IS NULL%'", [TABLE]);
    expect(idx.rowCount).toBeGreaterThan(0);
  });

  it("grants: the API may read and append, a worker may only read, the report and portal roles have nothing, and none may UPDATE or DELETE", async () => {
    for (const role of RUNTIME_ROLES) {
      const granted = (
        await client.query<{ privilege_type: string }>("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = $1 AND grantee = $2", [TABLE, role])
      ).rows.map((r) => r.privilege_type).sort();
      expect(granted, role).toEqual([...expectedTablePrivileges(role, TABLE)].sort());
    }
    expect(expectedTablePrivileges("nominara_app", TABLE)).toEqual(["SELECT", "INSERT"]);
    expect(expectedTablePrivileges("nominara_worker", TABLE)).toEqual(["SELECT"]);
    expect(expectedTablePrivileges("nominara_report", TABLE)).toEqual([]);
    expect(expectedTablePrivileges("nominara_portal", TABLE)).toEqual([]);
  });

  it("the down drops the table", async () => {
    const down = await readFile(path.join(MIGRATIONS_DIR, `${NAME}.down.sql`), "utf8");
    await client.query(down);
    const gone = await client.query("SELECT to_regclass($1) AS t", [TABLE]);
    expect(gone.rows[0].t).toBeNull();
  });
});
