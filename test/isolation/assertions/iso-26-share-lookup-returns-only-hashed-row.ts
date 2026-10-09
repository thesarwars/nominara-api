import { createHash } from "node:crypto";
import { type AssertionContext } from "../support/assertion-context.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { type Breaker } from "../support/breakers.js";

// ADR-0002 / checkpoint-5 finding 1 and 3 — app.share_token_by_hash is the only thing that reads share_tokens before the
// workspace is known, and it runs with a policy that admits EVERY row. Its whole safety is its equality-only WHERE: as
// nominara_app, with NO tenant context, a hash returns exactly that token's row (the gate columns, never token_hash,
// label, prefix or creator), a hash that matches nothing returns nothing, and the table itself stays unreadable.
//
// The fixture has three tenants x 50 tokens, hash = sha256("<label>:sharetoken-<i>"), so a lookup that lost its WHERE
// would return 150 rows and one that matched on workspace would return 50.
const GATE_COLUMNS = ["id", "workspace_id", "password_hash", "password_required", "scope_project_ids", "scope_tabs", "theme_id", "allowed_email_domains", "revoked_at", "expires_at", "max_views", "view_count", "locked_until"];

export async function assertIso26ShareLookupReturnsOnlyHashedRow(ctx: AssertionContext): Promise<void> {
  const app = await connectAsRole(ctx.target, "nominara_app");
  try {
    for (const tenant of [ctx.fixture.a, ctx.fixture.b, ctx.fixture.c]) {
      const hash = createHash("sha256").update(`${tenant.label}:sharetoken-0`).digest();
      const r = await app.query("SELECT * FROM app.share_token_by_hash($1)", [hash]);
      if (r.rowCount !== 1 || r.rows[0].id !== tenant.shareTokenIds[0] || r.rows[0].workspace_id !== tenant.workspaceId) {
        throw new Error(`ISO-26: lookup of tenant ${tenant.label}'s token returned ${r.rowCount} row(s) (${r.rows.map((x: { id: string }) => x.id).join(",")}); expected exactly its own`);
      }
      const columns = r.fields.map((f) => f.name);
      if (JSON.stringify(columns) !== JSON.stringify(GATE_COLUMNS)) {
        throw new Error(`ISO-26: lookup returned columns ${columns.join(",")}; expected exactly the gate columns`);
      }
    }
    const miss = await app.query("SELECT * FROM app.share_token_by_hash($1)", [createHash("sha256").update("no-such-token").digest()]);
    if (miss.rowCount !== 0) throw new Error(`ISO-26: an unknown hash returned ${miss.rowCount} row(s)`);
    const direct = await app.query("SELECT count(*)::int AS n FROM share_tokens");
    if (direct.rows[0].n !== 0) throw new Error(`ISO-26: nominara_app with no context read ${direct.rows[0].n} share_tokens row(s) directly`);
  } finally {
    await app.end();
  }
}

// The mutation: the lookup loses its equality predicate (the exact hole the definer's policy `USING (true)` would turn
// into a dump of every workspace's password_hash). CREATE OR REPLACE keeps the owner, so it still runs as the lookup role.
export const iso26Breaker: Breaker = {
  id: "ISO-26",
  description: "replaces app.share_token_by_hash with a body that drops WHERE token_hash = p_hash",
  apply: async (client) => {
    await client.query(`
      CREATE OR REPLACE FUNCTION app.share_token_by_hash(p_hash bytea)
      RETURNS TABLE (id uuid, workspace_id uuid, password_hash text, password_required boolean, scope_project_ids uuid[], scope_tabs text[], theme_id uuid,
                     allowed_email_domains text[], revoked_at timestamptz, expires_at timestamptz, max_views integer, view_count integer, locked_until timestamptz)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $$
        SELECT t.id, t.workspace_id, t.password_hash, t.password_required, t.scope_project_ids, t.scope_tabs, t.theme_id,
               COALESCE(t.allowed_email_domains::text[], ARRAY[]::text[]), t.revoked_at, t.expires_at, t.max_views, t.view_count, t.locked_until
          FROM public.share_tokens t
      $$`);
  },
  revert: async () => {
    // schema-local to the disposable database; dropped with it
  },
};
