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
// 83/64/19 as of STORY-077 (owner decision 2026-10-23): `downgrade_notices` (migration 0134) is a tenant table (workspace_id, own-migration policy, not portal-readable).
// 89/67/22 as of STORY-111: `legal_holds` and `purge_runs` (migration 0165) are global - owner-only platform state, no RLS, no runtime grant; tenant count unchanged.
// 87/67/20 as of STORY-067: `task_verifications` (migration 0163) is a tenant table (workspace_id, own-migration policy, not portal-readable).
// 86/66/20 as of STORY-178: `email_suppressions` (migration 0141) is global — an address's bounce is platform-wide; it holds the peppered hash only, no workspace, no RLS; tenant count unchanged.
//
// 85/66/19 as of STORY-068: `notification_reads` and `notification_emails` (migration 0135) are tenant tables (workspace_id, own-migration policies, not portal-readable).
//
// 82/63/19 as of STORY-072 AC13: `credit_hold_carries` (migration 0125) is a tenant table (workspace_id, own-migration policy, not portal-readable).
//
// 81/62/19 as of STORY-143 AC7: `audit_chain_marks` (migration 0123) is global — GRANT-protected, owner-only, no tenant policy; tenant count unchanged.
//
// 80/62/18 as of NEW-D-2 checkpoint-1: `stripe_subscription_syncs` (migration 0074) is a tenant table
// (workspace_id, own-migration policy, not portal-readable). Before it, 79/61/18 at the integration merge: `stripe_webhook_events` (NEW-D-2, migration 0048) is global —
// a delivery is deduplicated by event id before its workspace is known — and
// `scheduled_report_deliveries` (NEW-E-1, migration 0051) is a tenant table
// (workspace_id, own-migration policy, not portal-readable).
export async function assertIso06Census(ctx: AssertionContext): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    const census = await computeCensus(client);

    if (census.totalTables !== 89) {
      throw new Error(`ISO-06: expected 89 total base tables, discovered ${census.totalTables}`);
    }
    if (census.tenantTables.length !== 67) {
      throw new Error(`ISO-06: expected 67 tenant tables, discovered ${census.tenantTables.length}`);
    }
    if (census.globalTables.length !== 22) {
      throw new Error(`ISO-06: expected 22 global tables, discovered ${census.globalTables.length}`);
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
