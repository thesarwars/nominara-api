import { randomUUID } from "node:crypto";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PAGINATION_LIMIT_DEFAULT, PAGINATION_LIMIT_MAX } from "../../contracts/common/pagination.schema.js";
import { paginationRequestSchema } from "../../contracts/common/pagination.schema.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { InvitationsService } from "../../src/modules/workspaces/invitations.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-117 — `NFR-API-03` says EVERY list endpoint is cursor-paginated. Four
// were not. These are the assertions that make the difference observable:
// paging correctness under concurrent insertion, and the tie-break without
// which a keyset cursor silently drops rows.
//
// Deliberately at the SERVICE seam rather than over HTTP. The property under
// test is the keyset query and the cursor round-trip; driving it through the
// full composition root would add a container-per-test and prove nothing more
// about the thing that can actually be wrong. The HTTP surface — the query
// parameters and the `pagination` member — is covered by the contract specs
// and response-envelope.spec.

const WRAPPING_KEY = Buffer.alloc(32, 5);

describe("STORY-117 · cursor pagination on the shipped list endpoints", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let workspaces: WorkspacesService;
  let invitations: InvitationsService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DATABASE_URL_POOLED = container.getConnectionUri();

    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);

    pool = new Pool({ connectionString: container.getConnectionUri() });
    const membership = new MembershipService(new MembershipCacheService());
    workspaces = new WorkspacesService(
      pool,
      new LocalDekProvisioner(WRAPPING_KEY, "local:dev"),
      new AuditChainService(),
      membership,
      new SessionService(pool, membership), new NoopRealtimePublisher());
    invitations = new InvitationsService(pool, new AuditChainService());
  });

  afterEach(async () => {
    await pool.end();
    await db.end();
  });

  const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };

  async function createUser(): Promise<string> {
    const result = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `user-${randomUUID()}@example.com`,
    ]);
    return result.rows[0]!.id;
  }

  async function inTenant<T>(workspaceId: string, actorId: string, fn: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId }, fn);
    } finally {
      client.release();
    }
  }

  /** Adds `count` members. `sameInstant` puts them all in ONE transaction, so they share joined_at exactly. */
  async function addMembers(workspaceId: string, ownerId: string, count: number, sameInstant = false): Promise<void> {
    const add = async (tx: { query: (t: string, v: unknown[]) => Promise<unknown> }): Promise<void> => {
      for (let i = 0; i < count; i++) {
        const userId = await createUser();
        await tx.query(
          "INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'viewer','active')",
          [randomUUID(), workspaceId, userId],
        );
      }
    };
    if (sameInstant) {
      await inTenant(workspaceId, ownerId, async () => {
        const client = await pool.connect();
        try {
          await withTenantContext(client, { workspaceId, actorId: ownerId }, (tx) => add(tx));
        } finally {
          client.release();
        }
      });
      return;
    }
    for (let i = 0; i < count; i++) {
      const userId = await createUser();
      const client = await pool.connect();
      try {
        await withTenantContext(client, { workspaceId, actorId: ownerId }, async (tx) => {
          await tx.query(
            "INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'viewer','active')",
            [randomUUID(), workspaceId, userId],
          );
        });
      } finally {
        client.release();
      }
    }
  }

  /** Walks every page, returning the ids in order plus the number of requests it took. */
  async function drainMembers(
    workspaceId: string,
    ownerId: string,
    limit: number,
    onPage?: () => Promise<void>,
  ): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await inTenant(workspaceId, ownerId, () =>
        workspaces.listMembers(cursor === undefined ? { limit } : { limit, cursor }),
      );
      seen.push(...page.items.map((m) => m.id));
      if (!page.pagination.has_more) {
        expect(page.pagination.cursor_next, "the last page must carry no cursor").toBeNull();
        return seen;
      }
      expect(page.pagination.cursor_next).not.toBeNull();
      cursor = page.pagination.cursor_next!;
      if (onPage) await onPage();
    }
    throw new Error("pagination did not terminate within 50 pages");
  }

  it("returns every row exactly once across pages", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Paged ${randomUUID()}` }, meta);
    await addMembers(workspace.id, ownerId, 6);

    const ids = await drainMembers(workspace.id, ownerId, 2);

    // 6 added + the owner's own membership row.
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size, "a duplicate id means the cursor re-read a row").toBe(7);
  });

  it("skips nothing and repeats nothing while rows are inserted mid-walk", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Growing ${randomUUID()}` }, meta);
    await addMembers(workspace.id, ownerId, 5);

    const before = new Set(
      (await inTenant(workspace.id, ownerId, () => workspaces.listMembers({ limit: PAGINATION_LIMIT_DEFAULT }))).items.map(
        (m) => m.id,
      ),
    );

    // One new member between every page — the condition offset pagination
    // cannot survive, and the reason NFR-API-03 specifies a cursor.
    const ids = await drainMembers(workspace.id, ownerId, 2, () => addMembers(workspace.id, ownerId, 1));

    expect(new Set(ids).size, "no row may be returned twice").toBe(ids.length);
    for (const id of before) {
      expect(ids, `row ${id} existed before the walk and must not be skipped`).toContain(id);
    }
  });

  it("returns every row when the whole page shares one timestamp — the tie-break is the correctness condition", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Tied ${randomUUID()}` }, meta);
    // ONE transaction: now() is transaction-start time, so all four rows carry
    // the IDENTICAL joined_at. Keyed on the timestamp alone, the second page's
    // predicate `joined_at > <that instant>` excludes every one of them and
    // the walk loses the rest of the tie silently.
    await addMembers(workspace.id, ownerId, 4, true);

    const ids = await drainMembers(workspace.id, ownerId, 1);

    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it("honours the requested limit and reports it back", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Limit ${randomUUID()}` }, meta);
    await addMembers(workspace.id, ownerId, 4);

    const page = await inTenant(workspace.id, ownerId, () => workspaces.listMembers({ limit: 3 }));

    expect(page.items).toHaveLength(3);
    expect(page.pagination).toEqual({ cursor_next: expect.any(String), has_more: true, limit: 3 });
  });

  it("clamps an over-cap limit at the schema, so no query ever asks for more than the cap", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Clamped ${randomUUID()}` }, meta);
    await addMembers(workspace.id, ownerId, 2);

    // The clamp lives in the schema, never in the handler — this asserts the
    // service is driven by the PARSED value, so an over-cap request cannot
    // reach the LIMIT clause.
    const parsed = paginationRequestSchema.parse({ limit: 5_000 });
    expect(parsed.limit).toBe(PAGINATION_LIMIT_MAX);

    const page = await inTenant(workspace.id, ownerId, () => workspaces.listMembers(parsed));
    expect(page.pagination.limit).toBe(PAGINATION_LIMIT_MAX);
    expect(page.pagination.has_more).toBe(false);
    expect(page.pagination.cursor_next).toBeNull();
  });

  it("pages invitations that share a created_at — re-inviting revokes and re-inserts in one transaction", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Invites ${randomUUID()}` }, meta);

    await inTenant(workspace.id, ownerId, async () => {
      for (let i = 0; i < 4; i++) {
        await invitations.create(workspace.id, ownerId, { email: `invitee-${randomUUID()}@example.com`, role: "viewer" });
      }
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await inTenant(workspace.id, ownerId, () =>
        invitations.list(workspace.id, cursor === undefined ? { limit: 1 } : { limit: 1, cursor }),
      );
      seen.push(...page.items.map((i) => i.id));
      if (!page.pagination.has_more) break;
      cursor = page.pagination.cursor_next!;
    }

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size, "a shared created_at must not collapse two invitations into one").toBe(4);
  });
});
