import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { discoverEncryptedColumns, discoverGlobalTables, discoverPartitionChildren, discoverTenantTables } from "../support/discovery.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// STORY-012 T3 — ISO-00, THIS REPO'S OWN ADDITION (named as such — not one
// of the sixteen assertions in security-and-tenancy.md §10). The guard on
// every other assertion in the suite: (1) the connection under test is a
// REAL runtime role, never a superuser or a bypassrls-holding role, (2)
// every discovered set this suite iterates is non-empty, (3) the fixture
// this suite reads actually contains rows. Without this, a broken discovery
// query, an accidentally-superuser connection, or an empty fixture would
// make every other assertion pass VACUOUSLY.
export async function assertIso00AntiVacuity(ctx: AssertionContext): Promise<void> {
  const app = await connectAsRole(ctx.target, "nominara_app");
  try {
    const result = await app.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    const row = result.rows[0];
    if (!row) throw new Error("ISO-00: could not resolve pg_roles row for the connected role");
    if (row.rolsuper) throw new Error(`ISO-00: connection is a SUPERUSER (${row.rolname}) — every other assertion would pass vacuously`);
    if (row.rolbypassrls) throw new Error(`ISO-00: connection has BYPASSRLS (${row.rolname})`);
  } finally {
    await app.end();
  }

  const superuser = await connectSuperuser(ctx);
  try {
    const tenantTables = await discoverTenantTables(superuser);
    if (tenantTables.length === 0) throw new Error("ISO-00: discoverTenantTables returned an empty set");
    const globalTables = await discoverGlobalTables(superuser);
    if (globalTables.length === 0) throw new Error("ISO-00: discoverGlobalTables returned an empty set");
    const partitionChildren = await discoverPartitionChildren(superuser);
    if (partitionChildren.length === 0) throw new Error("ISO-00: discoverPartitionChildren returned an empty set");
    const encColumns = await discoverEncryptedColumns(superuser);
    if (encColumns.length === 0) throw new Error("ISO-00: discoverEncryptedColumns returned an empty set");
  } finally {
    await superuser.end();
  }

  for (const tenant of [ctx.fixture.a, ctx.fixture.b, ctx.fixture.c]) {
    if (tenant.projectIds.length === 0) throw new Error(`ISO-00: tenant ${tenant.label}'s fixture has zero projects`);
    if (tenant.userIds.length === 0) throw new Error(`ISO-00: tenant ${tenant.label}'s fixture has zero users`);
    if (tenant.resultIds.length === 0) throw new Error(`ISO-00: tenant ${tenant.label}'s fixture has zero answer_captures rows`);
  }
}

export const iso00Breaker: Breaker = {
  id: "ISO-00",
  description: "drops every partition child table, reopening the empty-collection trap discovery must catch",
  apply: async (client) => {
    const children = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
        WHERE c.relkind = 'r' AND p.relkind = 'p'`,
    );
    for (const row of children.rows) {
      await client.query(`DROP TABLE IF EXISTS ${row.relname} CASCADE`);
    }
  },
  revert: NOOP_REVERT,
};
