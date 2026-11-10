import { PLATFORM_AGGREGATE_ROLE } from "../../../src/db/conventions.js";
import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { type Breaker } from "../support/breakers.js";
import { maintenanceOutputTypes } from "./iso-27-maintenance-definer-shape.js";

// STORY-176 round 2 / ADR-0005 — the two platform-aggregate functions (migration 0190): app.refresh_platform_metrics (writes platform_metrics) and
// app.apply_benchmark_membership (moves a project's benchmark category). Same control as ISO-27: a definer function runs with its owner's rights, so its
// owner, who may EXECUTE it, the search_path it resolves names on, and WHAT IT RETURNS are the whole control. The owner role is covered by ISO-24 / ISO-28
// (DEFINER_OWNER_ROLES); the k >= 20 rule they enforce is held by ISO-33.
const EXPECTED_FUNCTIONS = ["apply_benchmark_membership", "refresh_platform_metrics"];
const EXPECTED_EXECUTORS = ["nominara_app", "nominara_owner", "nominara_platform_agg", "nominara_worker"];

export async function assertIso32PlatformAggregateDefinerShape(ctx: AssertionContext): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    const r = await client.query<{ proname: string; secdef: boolean; config: string[] | null; owner: string; super: boolean; login: boolean; bypass: boolean; pub: boolean; roles: string[] }>(
      `SELECT p.proname::text, p.prosecdef AS secdef, p.proconfig AS config, o.rolname::text AS owner, o.rolsuper AS super, o.rolcanlogin AS login,
              o.rolbypassrls AS bypass, has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
              -- The ACL itself, every grantee, whatever it is named: 0 is PUBLIC. A NULL proacl is the default (PUBLIC may execute).
              coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)
                          FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), ARRAY['PUBLIC']) AS roles
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles o ON o.oid = p.proowner
        WHERE n.nspname = 'app' AND (o.rolname = $1 OR p.proname = ANY($2::text[])) ORDER BY p.proname`,
      [PLATFORM_AGGREGATE_ROLE, EXPECTED_FUNCTIONS],
    );
    // Exactly the two, and nothing else owned by the role: a third function would be a third reach into the tenant tables nobody reviewed.
    if (r.rows.map((row) => row.proname).join(",") !== EXPECTED_FUNCTIONS.join(",")) {
      throw new Error(`ISO-32: expected exactly app.${EXPECTED_FUNCTIONS.join(" and app.")} (owned by ${PLATFORM_AGGREGATE_ROLE}), found ${JSON.stringify(r.rows.map((row) => row.proname))}`);
    }
    const outputTypes = await maintenanceOutputTypes(client, "%");
    for (const row of r.rows) {
      if (!row.secdef) throw new Error(`ISO-32: app.${row.proname} is not SECURITY DEFINER`);
      for (const pin of ["TimeZone=UTC", "DateStyle=ISO, MDY"]) {
        if (!(row.config ?? []).includes(pin)) throw new Error(`ISO-32: app.${row.proname} does not pin ${pin}`);
      }
      if (!(row.config ?? []).includes("search_path=pg_catalog, pg_temp")) throw new Error(`ISO-32: app.${row.proname} search_path is not pinned to 'pg_catalog, pg_temp'`);
      if (row.owner !== PLATFORM_AGGREGATE_ROLE || row.super || row.login || row.bypass) {
        throw new Error(`ISO-32: app.${row.proname} owner must be ${PLATFORM_AGGREGATE_ROLE}, NOSUPERUSER NOLOGIN NOBYPASSRLS (got ${JSON.stringify({ owner: row.owner, super: row.super, login: row.login, bypass: row.bypass })})`);
      }
      if (row.pub) throw new Error(`ISO-32: EXECUTE on app.${row.proname} is granted to PUBLIC`);
      if ([...row.roles].sort().join(",") !== EXPECTED_EXECUTORS.join(",")) {
        throw new Error(`ISO-32: the EXECUTE ACL of app.${row.proname} must be exactly ${EXPECTED_EXECUTORS.join(", ")}, with no PUBLIC grantee (got ${JSON.stringify(row.roles)})`);
      }
      // Counts only: no workspace id, project id, domain or score may be handed back.
      const types = outputTypes.get(row.proname);
      if (types === undefined) throw new Error(`ISO-32: app.${row.proname} has no readable output types`);
      for (const type of types) {
        if (type !== "integer") throw new Error(`ISO-32: app.${row.proname} returns a ${type} column; the platform-aggregate functions return integer counts only`);
      }
    }
    // The cooldown and the minimum are constants inside the functions, not arguments a caller could lower.
    const args = await client.query<{ proname: string; pronargs: number }>(
      "SELECT p.proname::text, p.pronargs::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'apply_benchmark_membership'",
    );
    if (args.rows[0]?.pronargs !== 0) throw new Error("ISO-32: app.apply_benchmark_membership takes an argument; the 7-day cooldown must not be caller-supplied");
  } finally {
    await client.end();
  }
}

export const iso32Breaker: Breaker = {
  id: "ISO-32",
  description: "grants EXECUTE on app.apply_benchmark_membership() to PUBLIC, so any role may move a project's benchmark category",
  apply: async (client) => {
    await client.query("GRANT EXECUTE ON FUNCTION app.apply_benchmark_membership() TO PUBLIC");
  },
  revert: async (client) => {
    await client.query("REVOKE EXECUTE ON FUNCTION app.apply_benchmark_membership() FROM PUBLIC");
  },
};
