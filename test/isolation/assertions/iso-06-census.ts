import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { computeCensus, crossCheckAgainstConventions } from "../support/discovery.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-06 / STORY-012 T7 — "the guard on the
// guard": tenant and global counts are each computed INDEPENDENTLY (never by
// subtracting one from a grand total), then cross-checked against the fixed
// numbers AND against src/db/conventions.ts / the generated TENANT_TABLES set.
//
// 73/59/14 as of STORY-017: `sessions` and `refresh_tokens` (global — session
// identity state, GRANT-protected like user_credentials) are the two new
// tables migration 0009 adds. Tenant count (59) is unchanged.
//
// 74/59/15 as of STORY-015: `oauth_authorization_requests` (global — the
// OAuth state parameter's server-held payload, GRANT-protected the same way)
// is the one new table migration 0013 adds. Tenant count (59) is unchanged.
//
// 76/59/17 as of STORY-016: `email_otp_codes` and `email_otp_requests`
// (both global — pre-tenant auth-path state, GRANT-protected the same way)
// are the two new tables migration 0014 adds. Tenant count (59) is
// unchanged.
//
// 77/60/17 as of STORY-070: `usage_reservations` (migration 0019) is the
// first TENANT table added since 0004, and therefore the first entry here
// that moves the tenant count rather than the global one. Its policy ships in
// its own migration — see POLICY_IN_OWN_MIGRATION in src/db/conventions.ts
// for why 0006 must not carry it.
//
// 78/60/18 as of NEW-D-2: `stripe_webhook_events` (migration 0048) is global —
// a delivery is deduplicated by event id before its workspace is known.
export async function assertIso06Census(ctx: AssertionContext): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    const census = await computeCensus(client);

    if (census.totalTables !== 78) {
      throw new Error(`ISO-06: expected 78 total base tables, discovered ${census.totalTables}`);
    }
    if (census.tenantTables.length !== 60) {
      throw new Error(`ISO-06: expected 60 tenant tables, discovered ${census.tenantTables.length}`);
    }
    if (census.globalTables.length !== 18) {
      throw new Error(`ISO-06: expected 18 global tables, discovered ${census.globalTables.length}`);
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
