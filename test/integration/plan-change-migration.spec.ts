import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// STORY-184 T2 · migration 0128 — subscriptions.pending_plan_change (jsonb, nullable, object-only).
describe("STORY-184 · migration 0128 — subscriptions.pending_plan_change", () => {
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

  async function subscription(): Promise<string> {
    const ws = await client.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ('W', $1, 'growth') RETURNING id", [`w-${Math.random().toString(36).slice(2, 8)}`]);
    const r = await client.query<{ id: string }>(
      `INSERT INTO subscriptions (workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id, status, current_period_start, current_period_end)
       VALUES ($1,'growth','monthly','cus_1',$2,'active', now(), now() + interval '30 days') RETURNING id`,
      [ws.rows[0]!.id, `sub_${Math.random().toString(36).slice(2, 10)}`],
    );
    return r.rows[0]!.id;
  }

  it("the column exists, is jsonb and nullable, and is NULL on an existing row", async () => {
    const col = await client.query("SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'subscriptions' AND column_name = 'pending_plan_change'");
    expect(col.rows).toEqual([{ data_type: "jsonb", is_nullable: "YES" }]);
    const id = await subscription();
    expect((await client.query("SELECT pending_plan_change FROM subscriptions WHERE id = $1", [id])).rows[0]!.pending_plan_change).toBeNull();
  });

  it("an object is accepted; an array or a scalar is rejected by the CHECK", async () => {
    const id = await subscription();
    await client.query("UPDATE subscriptions SET pending_plan_change = '{\"id\":\"x\"}'::jsonb WHERE id = $1", [id]);
    await expect(client.query("UPDATE subscriptions SET pending_plan_change = '[1]'::jsonb WHERE id = $1", [id])).rejects.toThrow(/violates check constraint/i);
    await expect(client.query("UPDATE subscriptions SET pending_plan_change = '\"x\"'::jsonb WHERE id = $1", [id])).rejects.toThrow(/violates check constraint/i);
  });

  it("the down removes the column", async () => {
    await rollbackLast(client, MIGRATIONS_DIR);
    const col = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'subscriptions' AND column_name = 'pending_plan_change'");
    expect(col.rowCount).toBe(0);
  });
});
