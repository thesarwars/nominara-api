import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { type Breaker } from "../support/breakers.js";

// STORY-013 round 2 / ADR-0004 — the three count-only maintenance functions. A definer function runs with its owner's rights, so its
// owner, who may EXECUTE it, the search_path it resolves names on, and WHAT IT RETURNS are the whole control. The owner role is covered
// by ISO-24 (DEFINER_OWNER_ROLES); this holds the functions' shape.
const ALLOWED_OUTPUT_TYPES = new Set(["text", "bigint", "integer"]);

export async function assertIso27MaintenanceDefinerShape(ctx: AssertionContext): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    const r = await client.query<{ proname: string; secdef: boolean; config: string[] | null; owner: string; super: boolean; login: boolean; bypass: boolean; pub: boolean; roles: string[]; outtypes: string[] | null; rettype: string }>(
      `SELECT p.proname::text, p.prosecdef AS secdef, p.proconfig AS config, o.rolname::text AS owner, o.rolsuper AS super, o.rolcanlogin AS login,
              o.rolbypassrls AS bypass, has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
              -- The ACL itself, every grantee, whatever it is named: 0 is PUBLIC. A NULL proacl is the default (PUBLIC may execute).
              coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)
                          FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), ARRAY['PUBLIC']) AS roles,
              (SELECT array_agg(format_type(t, NULL) ORDER BY ord) FROM unnest(p.proallargtypes, p.proargmodes) WITH ORDINALITY AS u(t, m, ord) WHERE m IN ('t', 'o')) AS outtypes,
              format_type(p.prorettype, NULL) AS rettype
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles o ON o.oid = p.proowner
        WHERE n.nspname = 'app' AND p.proname LIKE 'maintenance\\_%' ORDER BY p.proname`,
    );
    if (r.rowCount !== 3) throw new Error(`ISO-27: expected exactly three app.maintenance_* functions, found ${r.rowCount}`);
    for (const row of r.rows) {
      if (!row.secdef) throw new Error(`ISO-27: app.${row.proname} is not SECURITY DEFINER`);
      for (const pin of ["TimeZone=UTC", "DateStyle=ISO, MDY"]) {
        if (!(row.config ?? []).includes(pin)) throw new Error(`ISO-27: app.${row.proname} does not pin ${pin}`);
      }
      if (!(row.config ?? []).includes("search_path=pg_catalog, pg_temp")) throw new Error(`ISO-27: app.${row.proname} search_path is not pinned to 'pg_catalog, pg_temp'`);
      if (row.owner !== "nominara_maintenance" || row.super || row.login || row.bypass) {
        throw new Error(`ISO-27: app.${row.proname} owner must be nominara_maintenance, NOSUPERUSER NOLOGIN NOBYPASSRLS (got ${JSON.stringify({ owner: row.owner, super: row.super, login: row.login, bypass: row.bypass })})`);
      }
      if (row.pub) throw new Error(`ISO-27: EXECUTE on app.${row.proname} is granted to PUBLIC`);
      if ([...row.roles].sort().join(",") !== ["nominara_maintenance", "nominara_owner"].join(",")) {
        throw new Error(`ISO-27: the EXECUTE ACL of app.${row.proname} must be exactly its owner and nominara_owner, with no PUBLIC grantee (got ${JSON.stringify(row.roles)})`);
      }
      for (const type of row.outtypes ?? [row.rettype]) {
        if (!ALLOWED_OUTPUT_TYPES.has(type)) throw new Error(`ISO-27: app.${row.proname} returns a ${type} column; maintenance functions return counts only`);
      }
    }
  } finally {
    await client.end();
  }
}

// The grantee is deliberately NOT nominara_-prefixed: the first cut of the assertion filtered roles by that prefix and so could not see
// it. The role is CLUSTER-WIDE, so `revert` does real work and must run before the disposable database is dropped.
const ISO27_BREAKER_ROLE = "iso27_plain_reader";
export const iso27Breaker: Breaker = {
  id: "ISO-27",
  description: "grants EXECUTE on app.maintenance_orphan_counts() to a role WITHOUT the nominara_ prefix",
  apply: async (client) => {
    await client.query(`DROP ROLE IF EXISTS ${ISO27_BREAKER_ROLE}`);
    await client.query(`CREATE ROLE ${ISO27_BREAKER_ROLE} NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA app TO ${ISO27_BREAKER_ROLE}`);
    await client.query(`GRANT EXECUTE ON FUNCTION app.maintenance_orphan_counts() TO ${ISO27_BREAKER_ROLE}`);
  },
  revert: async (client) => {
    await client.query(`REVOKE EXECUTE ON FUNCTION app.maintenance_orphan_counts() FROM ${ISO27_BREAKER_ROLE}`);
    await client.query(`REVOKE USAGE ON SCHEMA app FROM ${ISO27_BREAKER_ROLE}`);
    await client.query(`DROP ROLE IF EXISTS ${ISO27_BREAKER_ROLE}`);
  },
};
