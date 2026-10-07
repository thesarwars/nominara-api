import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// CP1 audit (e-reports MAJOR) — share_token_views gained its first runtime writer (ShareTokensService.consumeView).
// Postgres checks FKs without RLS, so a single-column FK accepted a view row naming ANOTHER tenant's token (an
// existence oracle) and let that tenant's deletion of its token cascade into this one's rows. Same hazard class as
// scheduled_report_deliveries (0079). share_tokens.theme_id -> brand_themes is bound the same way.
describe("CP1 e-reports · share_token_views and share_tokens.theme_id foreign keys are tenant-consistent", () => {
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

  interface Tenant { workspaceId: string; userId: string; tokenId: string; themeId: string }
  async function tenant(label: string): Promise<Tenant> {
    const ws = await client.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'free') RETURNING id", [
      `WS ${label}`,
      `ws-${label}-${Math.random().toString(36).slice(2, 8)}`,
    ]);
    const workspaceId = ws.rows[0]!.id;
    const user = await client.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${label}-${Math.random().toString(36).slice(2)}@example.com`]);
    const userId = user.rows[0]!.id;
    const theme = await client.query<{ id: string }>("INSERT INTO brand_themes (workspace_id) VALUES ($1) RETURNING id", [workspaceId]);
    const token = await client.query<{ id: string }>(
      `INSERT INTO share_tokens (workspace_id, label, token_hash, token_prefix, scope_project_ids, created_by)
       VALUES ($1, 'L', gen_random_bytes(32), 'abcdefgh', ARRAY[gen_random_uuid()], $2) RETURNING id`,
      [workspaceId, userId],
    );
    return { workspaceId, userId, tokenId: token.rows[0]!.id, themeId: theme.rows[0]!.id };
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
  const insertView = (workspaceId: string, tokenId: string): Promise<unknown> =>
    client.query("INSERT INTO share_token_views (workspace_id, share_token_id) VALUES ($1, $2)", [workspaceId, tokenId]);

  it("CP1-E-FK-7 · tenant A cannot insert a view row that names tenant B's share token", async () => {
    const a = await tenant("a");
    const b = await tenant("b");
    await asTenant(a.workspaceId, async () => {
      await expect(insertView(a.workspaceId, b.tokenId)).rejects.toThrow(/foreign key/i);
    });
  });

  it("CP1-E-FK-8 · a same-tenant view row for its own token is accepted", async () => {
    const a = await tenant("a");
    await asTenant(a.workspaceId, async () => {
      await expect(insertView(a.workspaceId, a.tokenId)).resolves.toBeDefined();
    });
  });

  it("CP1-E-FK-9 · deleting a token cascades to its own view rows only", async () => {
    const a = await tenant("a");
    const b = await tenant("b");
    await insertView(a.workspaceId, a.tokenId);
    await insertView(b.workspaceId, b.tokenId);
    await client.query("DELETE FROM share_tokens WHERE id = $1", [b.tokenId]);
    const left = await client.query<{ workspace_id: string }>("SELECT workspace_id FROM share_token_views");
    expect(left.rows).toEqual([{ workspace_id: a.workspaceId }]);
  });

  it("CP1-E-FK-10 · tenant A cannot point a share token at tenant B's brand theme", async () => {
    const a = await tenant("a");
    const b = await tenant("b");
    await asTenant(a.workspaceId, async () => {
      await expect(client.query("UPDATE share_tokens SET theme_id = $1 WHERE id = $2", [b.themeId, a.tokenId])).rejects.toThrow(/foreign key/i);
    });
  });

  it("CP1-E-FK-11 · a share token may use its own tenant's theme, and deleting that theme nulls theme_id and keeps workspace_id", async () => {
    const a = await tenant("a");
    await client.query("UPDATE share_tokens SET theme_id = $1 WHERE id = $2", [a.themeId, a.tokenId]);
    await client.query("DELETE FROM brand_themes WHERE id = $1", [a.themeId]);
    const row = await client.query<{ workspace_id: string; theme_id: string | null }>("SELECT workspace_id, theme_id FROM share_tokens WHERE id = $1", [a.tokenId]);
    expect(row.rows).toEqual([{ workspace_id: a.workspaceId, theme_id: null }]);
  });

  it("CP1-E-FK-12 · the new migration rolls back and re-applies cleanly", async () => {
    expect(await rollbackLast(client, MIGRATIONS_DIR)).toBe("0081_share_token_tenant_fk");
    const a = await tenant("a");
    const b = await tenant("b");
    // single-column FKs are back: the cross-tenant row is accepted again
    await expect(insertView(a.workspaceId, b.tokenId)).resolves.toBeDefined();
    await client.query("DELETE FROM share_token_views");
    await migrateUp(client, MIGRATIONS_DIR);
    await expect(insertView(a.workspaceId, b.tokenId)).rejects.toThrow(/foreign key/i);
  });
});
