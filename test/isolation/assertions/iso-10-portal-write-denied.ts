import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { discoverTenantTables } from "../support/discovery.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-10 / STORY-012 T16 — nominara_portal
// receives 42501 on INSERT, UPDATE, AND DELETE, on EVERY tenant table — this
// is a GRANT-level denial (the role has no INSERT/UPDATE/DELETE privilege at
// all), so it fires even with no context set.
export async function assertIso10PortalWriteDenied(ctx: AssertionContext): Promise<void> {
  const discoveryClient = await connectSuperuser(ctx);
  let tables: Awaited<ReturnType<typeof discoverTenantTables>>;
  try {
    tables = await discoverTenantTables(discoveryClient);
  } finally {
    await discoveryClient.end();
  }

  const portal = await connectAsRole(ctx.target, "nominara_portal");
  try {
    for (const table of tables) {
      await assertRaises42501(portal, `INSERT INTO ${table.name} DEFAULT VALUES`, `INSERT on ${table.name}`);
      // Uses the table's OWN scope column (e.g. workspaces is scoped by
      // `id`, not `workspace_id`) — a hardcoded column name would raise
      // 42703 (undefined column) on that table instead of the grant denial
      // this assertion is actually testing.
      await assertRaises42501(
        portal,
        `UPDATE ${table.name} SET ${table.scopeColumn} = ${table.scopeColumn}`,
        `UPDATE on ${table.name}`,
      );
      await assertRaises42501(portal, `DELETE FROM ${table.name}`, `DELETE on ${table.name}`);
    }
  } finally {
    await portal.end();
  }
}

// Every probe runs inside its own explicit transaction, rolled back
// unconditionally — if a grant mistake ever let one of these DML statements
// through for real (exactly the failure this assertion exists to catch),
// autocommitting it across 59 tables would be real data loss, not just a
// failed test.
async function assertRaises42501(client: import("pg").Client, sql: string, label: string): Promise<void> {
  await client.query("BEGIN");
  try {
    try {
      await client.query(sql);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "42501") return;
      // A statement-shape error (e.g. DEFAULT VALUES failing a NOT NULL
      // constraint before the grant is even checked) is not what this
      // assertion is testing — the grant is what should fire first, and does
      // for every one of these tables in practice, but ANY error code other
      // than the grant denial is treated as a genuine failure here, never
      // silently accepted.
      throw new Error(`ISO-10: ${label} raised ${code ?? "an error"}, not 42501`, { cause: error });
    }
    throw new Error(`ISO-10: ${label} did not raise at all`);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}

export const iso10Breaker: Breaker = {
  id: "ISO-10",
  description: "grants INSERT/UPDATE/DELETE to nominara_portal on a tenant table (a grant mistake)",
  apply: async (client) => {
    await client.query("GRANT INSERT, UPDATE, DELETE ON competitors TO nominara_portal");
  },
  revert: NOOP_REVERT,
};
