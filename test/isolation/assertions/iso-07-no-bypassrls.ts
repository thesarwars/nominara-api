import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../../src/db/conventions.js";
import { type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-07 / STORY-012 T9 — no runtime role holds
// rolbypassrls except nominara_breakglass.
export async function assertIso07NoBypassRls(ctx: AssertionContext): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    const result = await client.query<{ rolname: string; rolbypassrls: boolean }>(
      "SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = ANY($1::text[])",
      [[...RUNTIME_ROLES, BREAKGLASS_ROLE]],
    );
    if (result.rowCount !== RUNTIME_ROLES.length + 1) {
      throw new Error(`ISO-07: expected ${RUNTIME_ROLES.length + 1} roles, found ${result.rowCount}`);
    }
    for (const row of result.rows) {
      const shouldBypass = row.rolname === BREAKGLASS_ROLE;
      if (row.rolbypassrls !== shouldBypass) {
        throw new Error(`ISO-07: ${row.rolname} rolbypassrls=${row.rolbypassrls}, expected ${shouldBypass}`);
      }
    }
  } finally {
    await client.end();
  }
}

// This is the one breaker in the whole suite that mutates a CLUSTER-WIDE
// object (role attributes are shared across every database in the Postgres
// instance, not scoped to the disposable database) — `revert` therefore does
// real work, not a no-op, and MUST run before the disposable database is
// dropped (broken-database.ts's createBrokenDatabase guarantees this order).
export const iso07Breaker: Breaker = {
  id: "ISO-07",
  description: "grants BYPASSRLS to nominara_app (a grant mistake) and reverts it",
  apply: async (client) => {
    await client.query("ALTER ROLE nominara_app BYPASSRLS");
  },
  revert: async (client) => {
    await client.query("ALTER ROLE nominara_app NOBYPASSRLS");
  },
};
