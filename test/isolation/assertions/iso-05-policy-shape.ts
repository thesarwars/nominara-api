import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { discoverPartitionChildren, discoverTenantTables } from "../support/discovery.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-05 / STORY-012 T8 — every FOR ALL policy
// has a non-null with_check, and every tenant table AND partition child has
// relrowsecurity AND relforcerowsecurity both true.
export async function assertIso05PolicyShape(ctx: AssertionContext): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    const forAll = await client.query<{ tablename: string; policyname: string; with_check: string | null }>(
      "SELECT tablename, policyname, with_check FROM pg_policies WHERE schemaname = 'public' AND cmd = 'ALL'",
    );
    if (forAll.rowCount === 0) {
      throw new Error("ISO-05: zero FOR ALL policies found — the empty-collection trap forbids this passing vacuously");
    }
    for (const row of forAll.rows) {
      if (row.with_check === null) {
        throw new Error(`ISO-05: ${row.tablename}.${row.policyname} has a NULL with_check`);
      }
    }

    const tenantTables = await discoverTenantTables(client);
    const partitionChildren = await discoverPartitionChildren(client);
    const allNames = [...tenantTables.map((t) => t.name), ...partitionChildren.map((c) => c.name)];

    const flags = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[])",
      [allNames],
    );
    const byName = new Map(flags.rows.map((r) => [r.relname, r]));
    for (const name of allNames) {
      const row = byName.get(name);
      if (!row || !row.relrowsecurity || !row.relforcerowsecurity) {
        throw new Error(
          `ISO-05: ${name} relrowsecurity=${row?.relrowsecurity ?? "missing"} relforcerowsecurity=${row?.relforcerowsecurity ?? "missing"}`,
        );
      }
    }
  } finally {
    await client.end();
  }
}

export const iso05Breaker: Breaker = {
  id: "ISO-05",
  description: "strips FORCE ROW LEVEL SECURITY from a tenant table (owner-bypass reopened)",
  apply: async (client) => {
    await client.query("ALTER TABLE competitors NO FORCE ROW LEVEL SECURITY");
  },
  revert: NOOP_REVERT,
};
