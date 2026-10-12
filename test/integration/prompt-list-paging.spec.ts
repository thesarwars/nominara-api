import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Page } from "../../src/api/pagination/page.js";
import { encodeCursor } from "../../src/api/pagination/cursor.js";
import { RUNTIME_ROLES, BREAKGLASS_ROLE } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import { PromptListService } from "../../src/modules/prompts/prompt-list.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-134 AC1 / scenarios 1, 4, 8 — real SQL as `nominara_app` (RLS in force). `cursor` used to be accepted and
// ignored, so a project over one page could not be read. The tie case is the one that matters: 60 rows inserted in ONE
// statement share created_at exactly, so only the id tie-break keeps a page boundary from skipping or repeating a row.
describe("STORY-134 · GET /projects/{id}/prompts keyset paging — real SQL", () => {
  let container: StartedPostgreSqlContainer;
  let admin: Client;
  const resolver = {
    resolveForWorkspace: vi.fn(async () => ({ entitlements: { "prompts.max_per_project": { value: 500 } } })),
  } as unknown as EntitlementResolver;
  const service = new PromptListService(resolver);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
  }, 120_000);
  afterAll(async () => { await container.stop(); });

  beforeEach(async () => {
    admin = new Client({ connectionString: container.getConnectionUri() });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS app CASCADE");
    await admin.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await admin.query("DROP SCHEMA public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await migrateUp(admin);
    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      await admin.query(`ALTER ROLE ${role} PASSWORD ${admin.escapeLiteral(resolvePassword(role, {}))}`);
    }
  });
  afterEach(async () => { await admin.end(); });

  async function inTenant<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
    const app = new Client({
      host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(),
      user: "nominara_app", password: resolvePassword("nominara_app", {}),
    });
    await app.connect();
    try { return await withTenantContext(app, context, fn); } finally { await app.end(); }
  }

  async function workspaceWithProject(): Promise<{ ws: string; actor: string; project: string }> {
    const ws = (await admin.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ('W', $1, 'business') RETURNING id", [`w-${randomUUID()}`])).rows[0]!.id;
    const actor = (await admin.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${randomUUID()}@example.com`])).rows[0]!.id;
    await admin.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'manager', 'active')", [ws, actor]);
    const project = (await admin.query<{ id: string }>(
      "INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1, 'P', $2, 'https://p.com', 'p.com') RETURNING id",
      [ws, `p-${randomUUID()}`])).rows[0]!.id;
    return { ws, actor, project };
  }

  /** `count` prompts in ONE statement: every created_at is identical (now() is transaction-stable). */
  async function seedTied(ws: string, project: string, count: number, tag = "t"): Promise<void> {
    await admin.query(
      `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       SELECT $1, $2, $4 || ' ' || g, sha256(($4 || ' ' || g)::bytea), 'recommendation', 'consideration', false, 'active'
         FROM generate_series(1, $3::int) g`,
      [ws, project, count, tag],
    );
  }

  const ctx = (ws: string, actor: string): TenantContext => ({ workspaceId: ws, actorId: actor });
  const page = (c: TenantContext, project: string, query: { limit: number; cursor?: string }) =>
    inTenant(c, async () => (await service.list(project, query)) as unknown as Page<{ id: string }>);

  async function drain(c: TenantContext, project: string, limit: number): Promise<{ ids: string[]; requests: number }> {
    const ids: string[] = [];
    let cursor: string | undefined;
    let requests = 0;
    do {
      const result = await page(c, project, cursor === undefined ? { limit } : { limit, cursor });
      requests += 1;
      ids.push(...result.items.map((item) => item.id));
      cursor = result.pagination.cursor_next ?? undefined;
      if (requests > 100) throw new Error("paging did not terminate");
    } while (cursor !== undefined);
    return { ids, requests };
  }

  it("[STORY-134 #8] pages concatenate to the FULL set with no duplicate and no skip, even when every created_at ties", async () => {
    const { ws, actor, project } = await workspaceWithProject();
    await seedTied(ws, project, 60);
    const distinct = await admin.query("SELECT count(DISTINCT created_at)::int AS n FROM tracked_prompts WHERE project_id = $1", [project]);
    expect(distinct.rows[0]!.n).toBe(1); // the premise: a pure tie

    const all = await admin.query<{ id: string }>("SELECT id FROM tracked_prompts WHERE project_id = $1 ORDER BY created_at ASC, id ASC", [project]);
    const { ids, requests } = await drain(ctx(ws, actor), project, 7);
    expect(requests).toBe(9);
    expect(new Set(ids).size).toBe(60);
    expect(ids).toEqual(all.rows.map((row) => row.id));
  });

  it("[STORY-134 #8] a page exactly the size of the remaining rows has has_more=false and cursor_next=null", async () => {
    const { ws, actor, project } = await workspaceWithProject();
    await seedTied(ws, project, 10);
    const first = await page(ctx(ws, actor), project, { limit: 5 });
    expect(first.pagination).toMatchObject({ has_more: true, limit: 5 });
    const second = await page(ctx(ws, actor), project, { limit: 5, cursor: first.pagination.cursor_next! });
    expect(second.items).toHaveLength(5);
    expect(second.pagination).toEqual({ cursor_next: null, has_more: false, limit: 5 });
  });

  it("[STORY-134 #8] a prompt inserted between pages neither repeats nor skips an earlier row", async () => {
    const { ws, actor, project } = await workspaceWithProject();
    await seedTied(ws, project, 6);
    const first = await page(ctx(ws, actor), project, { limit: 3 });
    await seedTied(ws, project, 2, "later"); // strictly later created_at
    const rest = await drain(ctx(ws, actor), project, 3);
    const seen = [...first.items.map((item) => item.id)];
    let cursor = first.pagination.cursor_next!;
    for (;;) {
      const next = await page(ctx(ws, actor), project, { limit: 3, cursor });
      seen.push(...next.items.map((item) => item.id));
      if (next.pagination.cursor_next === null) break;
      cursor = next.pagination.cursor_next;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(8);
    expect(rest.ids).toHaveLength(8);
  });

  it("[STORY-134 #8] garbage, wrong-arity and wrong-type cursors are 400s, never a first page", async () => {
    const { ws, actor, project } = await workspaceWithProject();
    await seedTied(ws, project, 4);
    const at = "2026-09-07T00:00:00.123456Z";
    for (const cursor of ["not a cursor!!", encodeCursor([at, randomUUID(), at, randomUUID(), randomUUID()]), encodeCursor([1, 2])]) {
      await expect(page(ctx(ws, actor), project, { limit: 2, cursor })).rejects.toMatchObject({ code: "validation_failed" });
    }
  });

  it("[STORY-134 #4] tenant isolation — another workspace's prompts never appear, and a foreign cursor pages only MY rows", async () => {
    const mine = await workspaceWithProject();
    const theirs = await workspaceWithProject();
    await seedTied(mine.ws, mine.project, 5, "mine");
    await seedTied(theirs.ws, theirs.project, 5, "theirs");

    const theirFirst = await page(ctx(theirs.ws, theirs.actor), theirs.project, { limit: 2 });
    // Their cursor, my context: RLS + the project predicate still bound the rows.
    const crossed = await page(ctx(mine.ws, mine.actor), mine.project, { limit: 50, cursor: theirFirst.pagination.cursor_next! });
    const mineIds = new Set((await admin.query<{ id: string }>("SELECT id FROM tracked_prompts WHERE workspace_id = $1", [mine.ws])).rows.map((r) => r.id));
    for (const item of crossed.items) expect(mineIds.has(item.id)).toBe(true);

    // And their project id from my context is a 404, not a leak.
    await expect(page(ctx(mine.ws, mine.actor), theirs.project, { limit: 50 })).rejects.toMatchObject({ code: "not_found" });
  });

  it("[STORY-134 #4] a sibling project in the SAME workspace never bleeds into the paged set", async () => {
    const { ws, actor, project } = await workspaceWithProject();
    const sibling = (await admin.query<{ id: string }>(
      "INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1, 'S', $2, 'https://s.com', 's.com') RETURNING id", [ws, `s-${randomUUID()}`])).rows[0]!.id;
    await seedTied(ws, project, 5, "mine");
    await seedTied(ws, sibling, 5, "sibling");
    const { ids } = await drain(ctx(ws, actor), project, 2);
    expect(ids).toHaveLength(5);
  });

  it("[STORY-134 #3] soft-deleted prompts are absent from every page", async () => {
    const { ws, actor, project } = await workspaceWithProject();
    await seedTied(ws, project, 6);
    await admin.query("UPDATE tracked_prompts SET deleted_at = now() WHERE id IN (SELECT id FROM tracked_prompts WHERE project_id = $1 LIMIT 2)", [project]);
    const { ids } = await drain(ctx(ws, actor), project, 2);
    expect(ids).toHaveLength(4);
  });
});
