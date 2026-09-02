import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createPgPool } from "../../src/db/pg-pool.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { TenantContextMissingError } from "../../src/tenancy/errors.js";

// STORY-118 — the guard, installed, against a REAL Postgres, AS THE ROLE
// THAT ACTUALLY RUNS IN PRODUCTION.
//
// Both halves of that sentence matter, and STORY-120 already paid for
// learning why: a check whose SUBJECT differs from the thing that runs in
// production proves nothing. The container superuser bypasses RLS entirely,
// so a context-free tenant query run as `nominara` succeeds and looks fine.
// Run the same query as `nominara_app` — NOBYPASSRLS, `FORCE ROW LEVEL
// SECURITY` on every tenant table — and it silently returns zero rows.
//
// That silence is the whole point of this story. `getLiveMembership`
// returning `null` is indistinguishable from "this user is not a member".
// The guard's job is to turn that into an exception, and the first test
// below asserts BOTH sides of the trade: the unguarded pool's silence, and
// the guarded pool's noise, on the same row.

// Toggled per-test. Hoisted so the vi.mock factory below — which is itself
// hoisted above every import — can close over it safely.
const state = vi.hoisted(() => ({ contextRemoved: false }));

// AC 3 — "the enforcement is asserted BY REMOVING THE CONTEXT FROM A REAL
// CODE PATH and observing the request fail — never by testing the guard
// function in isolation". This is that removal: withTenantContext degrades
// to a bare pass-through, exactly as if a future service had forgotten to
// open the transaction, while MembershipService below stays untouched.
// query-guard.ts reads `currentTenantStore` from this same module, and the
// spread keeps that the real one — so the store it consults is genuinely
// empty, not merely mocked away.
vi.mock("../../src/tenancy/tenant-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tenancy/tenant-context.js")>();
  return {
    ...actual,
    withTenantContext: async <T>(
      client: Parameters<typeof actual.withTenantContext<T>>[0],
      context: Parameters<typeof actual.withTenantContext<T>>[1],
      fn: Parameters<typeof actual.withTenantContext<T>>[2],
    ): Promise<T> => (state.contextRemoved ? fn(client) : actual.withTenantContext(client, context, fn)),
  };
});

const { withActorContext, withTenantContext } = await import("../../src/tenancy/tenant-context.js");

describe("STORY-118 · the tenant query guard, installed on the pool", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let guardedPool: Pool;
  let unguardedPool: Pool;
  let membership: MembershipService;
  let seq = 0;

  /** The pooled connection as deployed: nominara_app, never the migration owner. */
  function runtimeRoleUri(): string {
    const password = encodeURIComponent(resolvePassword("nominara_app", {}));
    return `postgres://nominara_app:${password}@${container.getHost()}:${container.getMappedPort(5432)}/${container.getDatabase()}`;
  }

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
    state.contextRemoved = false;

    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);
    // Migration 0005 deliberately sets no passwords (see its header).
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);

    guardedPool = createPgPool(runtimeRoleUri());
    // The same connection, built the way the pool was built BEFORE this
    // story: bare. Only used to demonstrate what the guard replaces.
    unguardedPool = new Pool({ connectionString: runtimeRoleUri() });
    membership = new MembershipService(new MembershipCacheService());
  });

  afterEach(async () => {
    await guardedPool.end().catch(() => undefined);
    await unguardedPool.end().catch(() => undefined);
    await db.end();
  });

  // ---- fixtures ---------------------------------------------------------

  async function createUser(): Promise<string> {
    seq += 1;
    const result = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `story-118-${seq}@example.com`,
    ]);
    return result.rows[0]!.id;
  }

  async function createWorkspace(): Promise<string> {
    seq += 1;
    const result = await db.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'free') RETURNING id",
      [`Workspace ${seq}`, `story-118-workspace-${seq}`],
    );
    return result.rows[0]!.id;
  }

  async function addMember(workspaceId: string, userId: string): Promise<void> {
    await db.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
      [workspaceId, userId],
    );
  }

  // ---- scenario 1 · a real code path with its context removed -----------

  it("scenario 1 — a service reading a tenant table with the context removed FAILS, where it used to return zero rows", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId);

    state.contextRemoved = true;

    // What the bare pool did, and what makes this story worth doing: the
    // membership row exists, the caller is a member, and the answer is
    // `null`. Nothing throws. Nothing logs. The request 403s on a row that
    // is right there.
    const silent = await unguardedPool.query(
      "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    expect(silent.rowCount, "as nominara_app with no context, RLS answers with silence").toBe(0);

    // The same read, through the real service, on the guarded pool.
    await expect(membership.getLiveMembership(guardedPool, userId, workspaceId)).rejects.toThrow(
      TenantContextMissingError,
    );
  });

  // ---- scenario 2 · the same query, context intact -----------------------

  it("scenario 2 — the same call inside a context-carrying transaction succeeds, unchanged", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId);

    const result = await membership.getLiveMembership(guardedPool, userId, workspaceId);
    expect(result).toEqual({ role: "owner", status: "active", projectScope: null });
  });

  // ---- scenario 3 · global tables are never touched ----------------------

  it("scenario 3 — a query against a global table with no context at all succeeds", async () => {
    const userId = await createUser();
    const client = await guardedPool.connect();
    try {
      const result = await client.query("SELECT id FROM users WHERE id = $1", [userId]);
      expect(result.rowCount).toBe(1);
    } finally {
      client.release();
    }
  });

  // ---- scenario 4 · the pool itself --------------------------------------

  it("scenario 4 — a tenant-table query issued on the pool rather than a checked-out client is refused", () => {
    expect(() => guardedPool.query("SELECT 1 FROM projects WHERE id = $1", [crypto.randomUUID()])).toThrow(
      TenantContextMissingError,
    );
  });

  // ---- scenario 5 · the actor-only allow-list ----------------------------

  it("scenario 5 — the actor-only helper reaching outside ACTOR_SELF_SCOPED_TABLES is refused, naming the table", async () => {
    const userId = await createUser();
    const client = await guardedPool.connect();
    try {
      await withActorContext(client, { actorId: userId }, async (tx) => {
        // Allow-listed: ADR-0001's two tables.
        await expect(tx.query("SELECT id FROM workspaces WHERE id = $1", [userId])).resolves.toBeDefined();
        // Not allow-listed, and the allow-list is not widened to admit it.
        expect(() => tx.query("SELECT id FROM projects")).toThrow(/projects/);
        expect(() => tx.query("SELECT id FROM projects")).toThrow(TenantContextMissingError);
      });
    } finally {
      client.release();
    }
  });

  // ---- scenario 6 · two contexts, two connections ------------------------

  it("scenario 6 — two contexts open on two different clients never authorise each other's queries", async () => {
    const a = await guardedPool.connect();
    const b = await guardedPool.connect();
    try {
      // CONCURRENT, not nested. Nesting would put both stores on one
      // AsyncLocalStorage chain where the inner one simply shadows the
      // outer — a different property, and not the one that matters. Two
      // requests in flight at once each carry their own chain, which is
      // what this reproduces.
      await Promise.all([
        withTenantContext(a, { workspaceId: crypto.randomUUID(), actorId: crypto.randomUUID() }, async (txA) => {
          await expect(txA.query("SELECT id FROM projects")).resolves.toBeDefined();
          // B's context is open right now, on another connection. It
          // authorises nothing here.
          expect(() => b.query("SELECT id FROM projects")).toThrow(TenantContextMissingError);
        }),
        withTenantContext(b, { workspaceId: crypto.randomUUID(), actorId: crypto.randomUUID() }, async (txB) => {
          await expect(txB.query("SELECT id FROM projects")).resolves.toBeDefined();
          expect(() => a.query("SELECT id FROM projects")).toThrow(TenantContextMissingError);
        }),
      ]);

      // And neither survives its own context ending.
      expect(() => a.query("SELECT id FROM projects")).toThrow(TenantContextMissingError);
      expect(() => b.query("SELECT id FROM projects")).toThrow(TenantContextMissingError);
    } finally {
      a.release();
      b.release();
    }
  });

  // ---- the subject of this file, asserted before anything else is --------

  it("the pool this file exercises is nominara_app, not the migration owner", async () => {
    const client = await guardedPool.connect();
    try {
      const result = await client.query<{ current_user: string }>("SELECT current_user");
      expect(result.rows[0]!.current_user, "the guard must be proven as the role that actually serves").toBe(
        "nominara_app",
      );
    } finally {
      client.release();
    }
  });
});
