import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { discoverPartitionChildren, discoverTenantTables } from "../support/discovery.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-01 / STORY-012 T11 — zero rows with no
// context, for every tenant table AND partition child, queried by name.
// Connects as the REAL nominara_app runtime role — never the superuser used
// for discovery/seeding — because a superuser bypasses RLS through an
// entirely different mechanism and would pass this vacuously.
export async function assertIso01NoContextZeroRows(ctx: AssertionContext, role = "nominara_app"): Promise<void> {
  const discoveryClient = await connectSuperuser(ctx);
  let tables: string[];
  try {
    const tenantTables = await discoverTenantTables(discoveryClient);
    const partitionChildren = await discoverPartitionChildren(discoveryClient);
    tables = [...tenantTables.map((t) => t.name), ...partitionChildren.map((c) => c.name)];
  } finally {
    await discoveryClient.end();
  }

  const app = await connectAsRole(ctx.target, role);
  try {
    for (const table of tables) {
      const result = await app.query<{ count: string }>(`SELECT count(*) FROM ${table}`);
      const count = Number(result.rows[0]!.count);
      if (count !== 0) {
        throw new Error(`ISO-01: table ${table} returned ${count} row(s) with NO tenant context set (role=${role})`);
      }
    }
  } finally {
    await app.end();
  }
}

export const iso01Breaker: Breaker = {
  id: "ISO-01",
  description: "disables RLS entirely on a tenant table, reopening a no-context leak",
  apply: async (client) => {
    await client.query("ALTER TABLE competitors DISABLE ROW LEVEL SECURITY");
  },
  revert: NOOP_REVERT,
};
