import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { discoverSingleRowPerTenantTables, discoverTenantTables } from "../support/discovery.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { withTenantContext } from "../../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../../src/tenancy/constants.js";
import { ROW_COUNT } from "../support/three-tenant-fixture.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-02 / STORY-012 T12 — under A's context,
// count == A's seeded count (a POSITIVE assertion, not just "zero foreign
// rows" — a policy denying EVERYONE, including the tenant that owns the
// data, would pass a zero-foreign-rows-only check vacuously), and zero rows
// carry a foreign tenant's scope value.
export async function assertIso02TenantIsolation(ctx: AssertionContext, role = "nominara_app"): Promise<void> {
  const discoveryClient = await connectSuperuser(ctx);
  let tenantTables: Awaited<ReturnType<typeof discoverTenantTables>>;
  let singleRow: Set<string>;
  try {
    tenantTables = await discoverTenantTables(discoveryClient);
    singleRow = await discoverSingleRowPerTenantTables(discoveryClient, tenantTables);
  } finally {
    await discoveryClient.end();
  }

  const tenants = [ctx.fixture.a, ctx.fixture.b, ctx.fixture.c];
  const app = await connectAsRole(ctx.target, role);
  try {
    for (const self of tenants) {
      await withTenantContext(app, { workspaceId: self.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        for (const table of tenantTables) {
          const expected = singleRow.has(table.name) ? 1 : ROW_COUNT;
          const countResult = await tx.query<{ count: string }>(`SELECT count(*) FROM ${table.name}`);
          const count = Number(countResult.rows[0]!.count);
          if (count < expected) {
            throw new Error(`ISO-02: ${table.name} under ${self.label}'s context (role=${role}) returned ${count}, expected >= ${expected}`);
          }

          const foreignResult = await tx.query<{ count: string }>(
            `SELECT count(*) FROM ${table.name} WHERE ${table.scopeColumn} <> $1`,
            [self.workspaceId],
          );
          const foreignCount = Number(foreignResult.rows[0]!.count);
          if (foreignCount !== 0) {
            throw new Error(`ISO-02: ${table.name} under ${self.label}'s context (role=${role}) returned ${foreignCount} row(s) NOT belonging to ${self.label}`);
          }
        }
      });
    }
  } finally {
    await app.end();
  }
}

export const iso02Breaker: Breaker = {
  id: "ISO-02",
  description: "widens the ws_isolation policy predicate on a tenant table to match every workspace",
  apply: async (client) => {
    await client.query("ALTER POLICY ws_isolation_competitors ON competitors USING (true)");
  },
  revert: NOOP_REVERT,
};
