import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgBouncerFixture, type PgBouncerFixture } from "../support/pgbouncer-fixture.js";
import { ensureGlobalCatalog, seedTenant } from "./support/three-tenant-fixture.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";

// STORY-012 T23 — the data-path subset (ISO-01/ISO-02's properties) run
// through a REAL pgBouncer in transaction-pooling mode at default_pool_size=1
// (reusing test/support/pgbouncer-fixture.ts, STORY-010's own fixture — the
// same image, same checked-in pgbouncer.ini/userlist.txt). This is a
// SEPARATE, dedicated Postgres+pgBouncer pair from the shared
// global-setup.ts container — pooling topology needs its own docker network,
// exactly like test/integration/pgbouncer-transaction-mode.spec.ts.
describe("STORY-012 T23 · data-path subset through a real pgBouncer (pool size 1)", () => {
  let fixture: PgBouncerFixture;
  let tenantA: Awaited<ReturnType<typeof seedTenant>>;
  let tenantB: Awaited<ReturnType<typeof seedTenant>>;

  beforeAll(async () => {
    fixture = await startPgBouncerFixture({ defaultPoolSize: 1 });

    const seedClient = new Client({ connectionString: fixture.postgres.getConnectionUri() });
    await seedClient.connect();
    await ensureGlobalCatalog(seedClient);
    tenantA = await seedTenant(seedClient, "PBA");
    tenantB = await seedTenant(seedClient, "PBB");
    await seedClient.end();
  }, 180_000);

  afterAll(async () => {
    await fixture.stop();
  });

  it("an interleaved two-tenant sequence over the SAME pooled server connection never bleeds context", async () => {
    const clientA1 = fixture.connectThroughPooler("nominara_app");
    const clientB = fixture.connectThroughPooler("nominara_app");
    const clientA2 = fixture.connectThroughPooler("nominara_app");
    await clientA1.connect();
    await clientB.connect();
    await clientA2.connect();

    try {
      // 1. Tenant A's context, tenant A's rows only.
      await withTenantContext(clientA1, { workspaceId: tenantA.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        const result = await tx.query<{ count: string }>("SELECT count(*) FROM projects");
        expect(Number(result.rows[0]!.count)).toBe(tenantA.projectIds.length);
      });

      // 2. Immediately after, tenant B's context on a DIFFERENT client — at
      // pool_size=1 this necessarily reuses the SAME underlying server
      // connection A's transaction just released.
      await withTenantContext(clientB, { workspaceId: tenantB.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        const result = await tx.query<{ count: string }>("SELECT count(*) FROM projects");
        expect(Number(result.rows[0]!.count)).toBe(tenantB.projectIds.length);
        const foreignRows = await tx.query<{ count: string }>("SELECT count(*) FROM projects WHERE id = ANY($1::uuid[])", [
          tenantA.projectIds,
        ]);
        expect(Number(foreignRows.rows[0]!.count), "tenant B's session must not see tenant A's rows").toBe(0);
      });

      // 3. Back to tenant A, on a THIRD client — proves B's context didn't
      // leak forward onto the connection either.
      await withTenantContext(clientA2, { workspaceId: tenantA.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        const result = await tx.query<{ count: string }>("SELECT count(*) FROM projects");
        expect(Number(result.rows[0]!.count)).toBe(tenantA.projectIds.length);
        const foreignRows = await tx.query<{ count: string }>("SELECT count(*) FROM projects WHERE id = ANY($1::uuid[])", [
          tenantB.projectIds,
        ]);
        expect(Number(foreignRows.rows[0]!.count), "tenant A's session must not see tenant B's rows").toBe(0);
      });
    } finally {
      await clientA1.end();
      await clientB.end();
      await clientA2.end();
    }
  }, 60_000);
});
