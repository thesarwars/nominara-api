import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { computeCensus, crossCheckAgainstConventions } from "../support/discovery.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-06 / STORY-012 T7 — "the guard on the
// guard": tenant and global counts are each computed INDEPENDENTLY (never by
// subtracting one from a grand total), then cross-checked against the fixed
// numbers AND against src/db/conventions.ts / the generated TENANT_TABLES set.
//
// 71/59/12 as of STORY-014: `webauthn_challenges` (global — WebAuthn
// ceremony state, GRANT-protected like user_credentials) is the one new
// table migration 0008 adds. Tenant count (59) is unchanged.
export async function assertIso06Census(ctx: AssertionContext): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    const census = await computeCensus(client);

    if (census.totalTables !== 71) {
      throw new Error(`ISO-06: expected 71 total base tables, discovered ${census.totalTables}`);
    }
    if (census.tenantTables.length !== 59) {
      throw new Error(`ISO-06: expected 59 tenant tables, discovered ${census.tenantTables.length}`);
    }
    if (census.globalTables.length !== 12) {
      throw new Error(`ISO-06: expected 12 global tables, discovered ${census.globalTables.length}`);
    }
    // Each of the 59 resolves a REAL scope column (non-empty string) — not
    // just present in the list.
    for (const table of census.tenantTables) {
      if (!table.scopeColumn || table.scopeColumn.length === 0) {
        throw new Error(`ISO-06: tenant table ${table.name} resolved an empty scope column`);
      }
    }

    crossCheckAgainstConventions(census);
  } finally {
    await client.end();
  }
}

/** Renames a tenant table's scope column away, so it resolves neither workspace_id nor a TENANT_SCOPE_COLUMN entry — the census must catch this, not silently shrink to 58. */
export const iso06Breaker: Breaker = {
  id: "ISO-06",
  description: "renames competitors.workspace_id away so the table becomes unclassifiable",
  apply: async (client) => {
    await client.query("ALTER TABLE competitors RENAME COLUMN workspace_id TO workspace_id_broken");
  },
  revert: NOOP_REVERT,
};
