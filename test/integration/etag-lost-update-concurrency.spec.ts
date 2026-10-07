import { randomUUID } from "node:crypto";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { entityTagFor } from "../../src/api/etag/entity-tag.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-024 T12 — the test the dangerous-area auditor required.
//
// *** WHY THIS FILE EXISTS, STATED EXACTLY ***
// T11 shipped `SELECT … FOR UPDATE` in WorkspacesService.update() and the
// commit claimed the read-check-write is atomic. The claim was TRUE. The
// problem was that nothing could tell it apart from the broken version:
// deleting `FOR UPDATE` from workspaces.service.ts left lint, typecheck,
// test:unit, test:integration, test:isolation and contracts:check all green.
// AC8's whole purpose is to prevent a lost update, and the suite could not
// detect one. An unprotected correct implementation is one refactor away
// from an undetected incorrect one.
//
// *** WHY IT IS NOT DRIVEN OVER HTTP ***
// Every ETag case in workspace-mutations-audit.spec.ts awaits its first
// app.inject() before issuing the second, so the two requests never overlap.
// `Promise.all` of two injections does not reliably overlap them either —
// this codebase already knows that and says so at
// identity-passkey-webauthn.spec.ts:509 and identity-oauth-pkce.spec.ts:868.
// The window has to be forced, not hoped for.
//
// *** HOW THE WINDOW IS FORCED ***
// A third connection opens its own transaction and takes `FOR UPDATE` on the
// workspace row, then holds it. Both racers are started and both block —
// but at DIFFERENT statements, and that difference is the whole test:
//
//   WITH `FOR UPDATE`     both block on their own SELECT. When the barrier
//                         commits, one acquires the lock, re-reads, matches,
//                         writes. The other then acquires it, and Postgres's
//                         EPQ recheck hands it the NEW row version, so its
//                         tag no longer matches and it is refused: 409.
//
//   WITHOUT `FOR UPDATE`  neither SELECT blocks; both read the pre-barrier
//                         snapshot under MVCC, both compute the SAME tag,
//                         and both pass the precondition. They then block on
//                         their UPDATE instead, and when the barrier commits
//                         both writes land: two 200s and one write silently
//                         gone.
//
// The assertion is order-independent — it never says WHICH racer wins, only
// that exactly one does, which is the actual invariant.
const WRAPPING_KEY = Buffer.alloc(32, 9);

describe("STORY-024 · AC8 — two overlapping PATCHes cannot both win", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;

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

    pool = new Pool({ connectionString: container.getConnectionUri(), max: 10 });
  });

  afterEach(async () => {
    await pool.end();
    await db.end();
  });

  function makeService(): WorkspacesService {
    const membership = new MembershipService(new MembershipCacheService());
    return new WorkspacesService(
      pool,
      new LocalDekProvisioner(WRAPPING_KEY, "local:dev"),
      new AuditChainService(),
      membership,
      new SessionService(pool, membership, new InMemoryCacheAdapter()), new NoopRealtimePublisher());
  }

  async function createUser(): Promise<string> {
    const result = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `owner-${randomUUID()}@example.com`,
    ]);
    return result.rows[0]!.id;
  }

  /** Runs one PATCH on its own pooled connection, inside its own tenant transaction. */
  async function patch(
    service: WorkspacesService,
    workspaceId: string,
    actorId: string,
    name: string,
    ifMatch: string,
  ): Promise<{ status: number; code?: string | undefined }> {
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId }, () => service.update(workspaceId, { name }, [ifMatch]));
      return { status: 200 };
    } catch (error) {
      const status = (error as { getStatus?: () => number }).getStatus?.() ?? 500;
      return { status, code: (error as { code?: string }).code };
    } finally {
      client.release();
    }
  }

  it("exactly one of two overlapping PATCHes holding the SAME tag succeeds; the other is refused 409", async () => {
    const userId = await createUser();
    const service = makeService();
    const created = await service.create(userId, { name: "Contended Co" }, {
      ip: "127.0.0.1",
      ua: "vitest",
      requestId: randomUUID(),
    });
    const sharedTag = entityTagFor(created);

    // ---- the barrier: hold a row lock so both racers pile up behind it ----
    const barrier = await pool.connect();
    await barrier.query("BEGIN");
    await barrier.query("SELECT set_config('app.workspace_id', $1, true)", [created.id]);
    await barrier.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [created.id]);

    const raceA = patch(service, created.id, userId, "Racer A", sharedTag);
    const raceB = patch(service, created.id, userId, "Racer B", sharedTag);

    // Both are now blocked. Releasing the barrier starts the race for real.
    await barrier.query("COMMIT");
    barrier.release();

    const [a, b] = await Promise.all([raceA, raceB]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(
      statuses,
      `exactly one PATCH may win — got ${JSON.stringify([a, b])}. Two 200s means a lost update: ` +
        "both racers passed the precondition against the same pre-race representation and both wrote.",
    ).toEqual([200, 409]);

    const conflicted = a.status === 409 ? a : b;
    expect(conflicted.code, "the loser must be refused with the taxonomy's conflict code").toBe("conflict");

    // The winner's write is the one that survives, and it is one of the two —
    // never a torn mix, never the pre-race value.
    const row = await db.query<{ name: string }>("SELECT name FROM workspaces WHERE id = $1", [created.id]);
    const winnerName = a.status === 200 ? "Racer A" : "Racer B";
    expect(row.rows[0]!.name).toBe(winnerName);
  }, 60_000);

  // The positive control. Without it, the test above could pass because the
  // service refuses everything, and "exactly one 200" would be unreachable
  // for a reason that has nothing to do with locking.
  it("a single PATCH with a current tag still succeeds — the refusal above is contention, not breakage", async () => {
    const userId = await createUser();
    const service = makeService();
    const created = await service.create(userId, { name: "Uncontended Co" }, {
      ip: "127.0.0.1",
      ua: "vitest",
      requestId: randomUUID(),
    });

    const result = await patch(service, created.id, userId, "Renamed", entityTagFor(created));

    expect(result.status).toBe(200);
    const row = await db.query<{ name: string }>("SELECT name FROM workspaces WHERE id = $1", [created.id]);
    expect(row.rows[0]!.name).toBe("Renamed");
  }, 60_000);
});
