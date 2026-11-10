import { randomUUID } from "node:crypto";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { NotFoundException } from "@nestjs/common";
import { ConflictError } from "../../src/api/errors/domain-errors.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import type { DekProvisioner } from "../../src/modules/workspaces/ports/dek-provisioner.js";
import { WorkspaceLimitReachedException } from "../../src/tenancy/errors.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-021 — Test Scenarios 1, 2, 3 plus the immutable-region behaviour
// (AC "the region choice is immutable after creation"). Real Postgres
// (testcontainers): the one-owned invariant is enforced by a unique index
// (ux_one_owned_workspace_per_user, migration 0002), so its refusal shape
// can only be proven honestly against the real constraint, never a mocked
// pg client. Dangerous area disclosure: this file exercises workspace
// creation (four-table atomic write) and the credit/tenancy-adjacent
// ux_one_owned_workspace_per_user invariant — a second engineer should read
// it alongside workspaces.service.ts.

const WRAPPING_KEY = Buffer.alloc(32, 9);

function throwingDekProvisioner(): DekProvisioner {
  return {
    provision: () => {
      throw new Error("simulated DEK provisioning failure");
    },
  };
}

describe("STORY-021 · workspace creation and the one-owned invariant", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let membership: MembershipService;

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

    // max: 25 — scenario 3 below fires 20 concurrent service.create() calls,
    // each needing its own connection/transaction; the default pool size
    // (10) would just serialize half of them behind a connection wait
    // rather than genuinely racing the unique-index enforcement.
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 25 });
    membership = new MembershipService(new MembershipCacheService());
  });

  afterEach(async () => {
    await pool.end();
    await db.end();
  });

  function makeService(dekProvisioner: DekProvisioner = new LocalDekProvisioner(WRAPPING_KEY, "local:dev")): WorkspacesService {
    return new WorkspacesService(pool, dekProvisioner, new AuditChainService(), membership, new SessionService(pool, membership, new InMemoryCacheAdapter()), new NoopRealtimePublisher());
  }

  async function createUser(email = `owner-${randomUUID()}@example.com`): Promise<string> {
    const result = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [email]);
    return result.rows[0]!.id;
  }

  const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };

  async function countRows(table: string, workspaceId: string, column = "workspace_id"): Promise<number> {
    const result = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${column} = $1`,
      [workspaceId],
    );
    return Number(result.rows[0]!.count);
  }

  // ---- scenario 1 ---------------------------------------------------------

  it("scenario 1 — creates the workspace, its key, the owner membership, and a starting subscription in one transaction", async () => {
    const userId = await createUser();
    const service = makeService();

    const response = await service.create(userId, { name: "Acme Corp" }, meta);

    expect(response.name).toBe("Acme Corp");
    expect(response.plan_key).toBe("free");
    expect(response.status).toBe("active");
    expect(await countRows("workspaces", response.id, "id")).toBe(1);
    expect(await countRows("workspace_keys", response.id)).toBe(1);
    expect(await countRows("workspace_members", response.id)).toBe(1);
    expect(await countRows("subscriptions", response.id)).toBe(1);

    const member = await db.query<{ role: string; status: string; user_id: string }>(
      "SELECT role, status, user_id FROM workspace_members WHERE workspace_id = $1",
      [response.id],
    );
    expect(member.rows[0]).toEqual({ role: "owner", status: "active", user_id: userId });

    const subscription = await db.query<{ plan_key: string; status: string; billing_interval: string; trial_ends_at: Date | null }>(
      "SELECT plan_key, status, billing_interval, trial_ends_at FROM subscriptions WHERE workspace_id = $1",
      [response.id],
    );
    expect(subscription.rows[0]).toEqual({
      plan_key: "free",
      status: "active",
      billing_interval: "monthly",
      trial_ends_at: null,
    });

    const auditRow = await db.query<{ action: string; actor_id: string; resource_id: string }>(
      "SELECT action, actor_id, resource_id FROM audit_log WHERE workspace_id = $1 AND action = 'workspace.created'",
      [response.id],
    );
    expect(auditRow.rows[0]).toEqual({ action: "workspace.created", actor_id: userId, resource_id: response.id });
  });

  it("rollback on DEK-provisioning failure leaves zero rows in all four tables", async () => {
    const userId = await createUser();
    const service = makeService(throwingDekProvisioner());

    await expect(service.create(userId, { name: "Doomed Co" }, meta)).rejects.toThrow(
      "simulated DEK provisioning failure",
    );

    const workspaceCount = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workspaces WHERE name = 'Doomed Co'",
    );
    expect(Number(workspaceCount.rows[0]!.count)).toBe(0);

    const keyCount = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM workspace_keys");
    expect(Number(keyCount.rows[0]!.count)).toBe(0);
    const memberCount = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM workspace_members");
    expect(Number(memberCount.rows[0]!.count)).toBe(0);
    const subCount = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM subscriptions");
    expect(Number(subCount.rows[0]!.count)).toBe(0);
    const auditCount = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM audit_log");
    expect(Number(auditCount.rows[0]!.count)).toBe(0);
  });

  // ---- scenario 2 ---------------------------------------------------------

  it("scenario 2 — a second owned workspace fails with a conflict naming the existing workspace and the transfer path", async () => {
    const userId = await createUser();
    const service = makeService();
    const first = await service.create(userId, { name: "First Co" }, meta);

    await expect(service.create(userId, { name: "Second Co" }, meta)).rejects.toMatchObject({
      response: {
        code: "workspace_limit_reached",
        details: {
          existing_workspace_id: first.id,
          existing_workspace_name: "First Co",
          existing_workspace_slug: first.slug,
          transfer_path: "POST /workspaces/{id}/transfer-ownership",
        },
      },
    });

    // The second attempt left no partial rows behind either.
    expect(await countRows("workspaces", "Second Co", "name")).toBe(0);
  });

  it("a slug collision between two different owners is retried transparently, never surfaced as workspace_limit_reached", async () => {
    const service = makeService();
    const ownerA = await createUser();
    const ownerB = await createUser();

    const first = await service.create(ownerA, { name: "Shared Name" }, meta);
    const second = await service.create(ownerB, { name: "Shared Name" }, meta);

    expect(second.slug).not.toBe(first.slug);
    expect(await countRows("workspaces", second.id, "id")).toBe(1);
  });

  it("STORY-195-AC2 a supplied slug is stored as given, and a taken one is refused with slug_taken and creates nothing", async () => {
    const service = makeService();
    const ownerA = await createUser();
    const ownerB = await createUser();

    const first = await service.create(ownerA, { name: "Anything", slug: "my-chosen-slug" }, meta);
    expect(first.slug).toBe("my-chosen-slug");

    const refusal = await service.create(ownerB, { name: "Other", slug: "my-chosen-slug" }, meta).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ConflictError);
    expect((refusal as { details: unknown }).details).toEqual({ reason: "slug_taken" });

    const owned = await db.query("SELECT 1 FROM workspace_members WHERE user_id = $1", [ownerB]);
    expect(owned.rowCount).toBe(0);
    // The refusal did not trip the one-owned invariant: ownerB can still create.
    const retry = await service.create(ownerB, { name: "Other", slug: "other-slug" }, meta);
    expect(retry.slug).toBe("other-slug");
  });

  it("STORY-195-AC2 a taken slug is refused for a second caller too (the unique index, not a pre-check, decides)", async () => {
    const service = makeService();
    const ownerA = await createUser();
    const ownerB = await createUser();
    await service.create(ownerA, { name: "A", slug: "acme" }, meta);
    await expect(service.create(ownerB, { name: "B", slug: "acme" }, meta)).rejects.toBeInstanceOf(ConflictError);
  });

  it.each(["admin", "api", "www", "app", "support", "help", "billing", "status", "auth", "onboarding"])(
    "[decision 96c] a supplied reserved slug %s is refused 409 slug_reserved and creates nothing",
    async (reserved) => {
      const service = makeService();
      const owner = await createUser();
      const refusal = await service.create(owner, { name: "Acme", slug: reserved }, meta).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ConflictError);
      expect((refusal as { details: unknown }).details).toEqual({ reason: "slug_reserved" });
      expect((await db.query("SELECT 1 FROM workspace_members WHERE user_id = $1", [owner])).rowCount).toBe(0);
    },
  );

  it("[decision 96c] a server-derived slug that would be reserved takes a suffix instead", async () => {
    const service = makeService();
    const created = await service.create(await createUser(), { name: "Admin" }, meta);
    expect(created.slug).toMatch(/^admin-[0-9a-f]{6}$/);
  });

  it("[decision 96c] a slug that merely contains a reserved word is not reserved", async () => {
    const created = await makeService().create(await createUser(), { name: "Admin Co", slug: "admin-co" }, meta);
    expect(created.slug).toBe("admin-co");
  });

  // ---- scenario 3 ---------------------------------------------------------

  it(
    "scenario 3 — twenty concurrent creation attempts by one user yield exactly one success and nineteen identical conflicts",
    async () => {
      for (let iteration = 0; iteration < 3; iteration++) {
        const userId = await createUser();
        const service = makeService();

        const results = await Promise.allSettled(
          Array.from({ length: 20 }, (_, i) => service.create(userId, { name: `Race Co ${iteration}-${i}` }, meta)),
        );

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(19);
        for (const r of rejected) {
          expect(r.reason).toBeInstanceOf(WorkspaceLimitReachedException);
          expect((r.reason as WorkspaceLimitReachedException).getResponse()).toMatchObject({
            code: "workspace_limit_reached",
          });
        }

        const ownedCount = await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM workspace_members WHERE user_id = $1 AND role = 'owner' AND status = 'active'",
          [userId],
        );
        expect(Number(ownedCount.rows[0]!.count)).toBe(1);
      }
    },
    60_000,
  );

  // ---- region immutability (AC "region choice is immutable") --------------

  it("region change is refused with an explanation, and the stored region is unchanged", async () => {
    const userId = await createUser();
    const service = makeService();
    const created = await service.create(userId, { name: "Region Co", region: "us-east-1" }, meta);

    const client = await pool.connect();
    try {
      await expect(
        withTenantContext(client, { workspaceId: created.id, actorId: userId }, () =>
          // STORY-024 T11 — `"*"` is RFC 9110's "any current representation":
          // these three cases are about region immutability and the 404, not
          // about optimistic concurrency, so the precondition is satisfied
          // unconditionally rather than being the thing under test.
          service.update(created.id, { region: "eu-central-1" }, "*"),
        ),
      ).rejects.toMatchObject({
        response: {
          code: "conflict",
          details: { field: "region", current: "us-east-1", reason: "region_immutable" },
        },
      });
    } finally {
      client.release();
    }

    const row = await db.query<{ region: string }>("SELECT region FROM workspaces WHERE id = $1", [created.id]);
    expect(row.rows[0]!.region).toBe("us-east-1");
  });

  it("name/timezone update succeeds, and a region matching the current value is a no-op, not a refusal", async () => {
    const userId = await createUser();
    const service = makeService();
    const created = await service.create(userId, { name: "Mutable Co", region: "us-east-1" }, meta);

    const client = await pool.connect();
    try {
      const updated = await withTenantContext(client, { workspaceId: created.id, actorId: userId }, () =>
        service.update(created.id, { name: "Renamed Co", timezone: "Europe/Berlin", region: "us-east-1" }, "*"),
      );
      expect(updated.name).toBe("Renamed Co");
      expect(updated.timezone).toBe("Europe/Berlin");
      expect(updated.region).toBe("us-east-1");
    } finally {
      client.release();
    }
  });

  it("updating an id with no workspace row is a 404, not a leak of whether the id ever existed", async () => {
    const service = makeService();
    const client = await pool.connect();
    try {
      const missingId = randomUUID();
      await expect(
        withTenantContext(client, { workspaceId: missingId, actorId: randomUUID() }, () =>
          service.update(missingId, { name: "Nope" }, "*"),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      client.release();
    }
  });
});
