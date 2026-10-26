import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";

// STORY-100 AC10 (owner decision 6) · migration 0140 — brand_themes.email_reply_to, nullable, expand-only.
const NAME = "0140_brand_themes_email_reply_to";

describe("migration 0140 — brand_themes.email_reply_to", () => {
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

  async function workspace(): Promise<string> {
    const ws = await client.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ('W', $1, 'free') RETURNING id", [`w-${Math.random().toString(36).slice(2, 8)}`]);
    return ws.rows[0]!.id;
  }
  const theme = (workspaceId: string, replyTo: string | null) =>
    client.query("INSERT INTO brand_themes (workspace_id, name, email_reply_to) VALUES ($1,'T',$2)", [workspaceId, replyTo]);

  it("the column is nullable with no default: a theme written without it has NULL, never an invented address", async () => {
    const ws = await workspace();
    await client.query("INSERT INTO brand_themes (workspace_id, name) VALUES ($1,'T')", [ws]);
    const row = await client.query("SELECT email_reply_to FROM brand_themes WHERE workspace_id = $1", [ws]);
    expect(row.rows[0]).toEqual({ email_reply_to: null });
  });

  it("the CHECK refuses a control character (header injection) and an over-long value, and admits an ordinary address", async () => {
    const ws = await workspace();
    await theme(ws, "team@acme.example");
    await expect(theme(ws, "a@acme.example\r\nBcc: x@evil.example")).rejects.toThrow(/violates check constraint/i);
    await expect(theme(ws, `${"a".repeat(250)}@x.io`)).rejects.toThrow(/violates check constraint/i);
  });

  it("the down drops the column and nothing else", async () => {
    const down = await readFile(path.join(MIGRATIONS_DIR, `${NAME}.down.sql`), "utf8");
    await client.query(down);
    const cols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'brand_themes'");
    const names = cols.rows.map((r: { column_name: string }) => r.column_name);
    expect(names).not.toContain("email_reply_to");
    expect(names).toContain("email_from_name");
  });
});
