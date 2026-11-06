import type { Client } from "pg";
import { BREAKGLASS_ROLE, RUNTIME_ROLES, SHARE_LOOKUP_ROLE } from "../../../src/db/conventions.js";
import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { type Breaker } from "../support/breakers.js";

// STORY-013 r4 / ADR-0004 — EFFECTIVE execute. ISO-27 holds the function ACL exactly (owner + nominara_owner, no PUBLIC), but an ACL lists
// grantees, not who can act as them: a role that is a MEMBER of nominara_owner executes the functions through it, and the ACL does not move.
// The roles that must be refused are NAMED, never selected by a name prefix: the G-4 maintenance login is a legitimate member of
// nominara_owner and must not be flagged. For each refused role r, r itself and every role Y it is a MEMBER of (pg_has_role(r, Y, 'MEMBER'): INHERIT, SET-only,
// ADMIN-only, any chain) is checked with has_function_privilege; one that may EXECUTE fails the assertion.
export interface ExecuteHolder {
  readonly role: string;
  readonly reason: string;
}

/** Runtime roles, the share-lookup role, and the break-glass role unless it is BYPASSRLS (it reads rows directly and is covered by ISO-07). */
async function refusedRoles(client: Client): Promise<string[]> {
  const bg = await client.query<{ rolbypassrls: boolean }>("SELECT rolbypassrls FROM pg_roles WHERE rolname = $1", [BREAKGLASS_ROLE]);
  const breakglassBypasses = bg.rows[0]?.rolbypassrls ?? false;
  return [...RUNTIME_ROLES, SHARE_LOOKUP_ROLE, ...(breakglassBypasses ? [] : [BREAKGLASS_ROLE])];
}

export async function effectiveExecuteHolders(client: Client): Promise<ExecuteHolder[]> {
  const refused = await refusedRoles(client);
  const present = await client.query<{ rolname: string }>("SELECT rolname::text FROM pg_roles WHERE rolname = ANY($1::text[])", [refused]);
  const missing = refused.filter((name) => !present.rows.some((row) => row.rolname === name));
  // Fail closed: a role that is not there cannot be shown to be refused, and has_function_privilege would raise on it.
  if (missing.length > 0) throw new Error(`ISO-29: cannot check role(s) that do not exist: ${missing.join(", ")}`);

  // For each refused role r: r itself plus EVERY role Y with pg_has_role(r, Y, 'MEMBER'). MEMBER follows every grant, whatever its INHERIT / SET /
  // ADMIN options, and any depth, so an INHERIT-only chain, a SET-only grant and an ADMIN-only grant (the holder can grant itself the rest) are all seen.
  const r = await client.query<{ role: string; fn: string; via: string[] | null }>(
    `SELECT r.rolname::text AS role, p.proname::text AS fn,
            (SELECT array_agg(y.rolname::text ORDER BY y.rolname) FROM pg_roles y
              WHERE (y.oid = r.oid OR pg_has_role(r.oid, y.oid, 'MEMBER')) AND has_function_privilege(y.oid, p.oid, 'EXECUTE')) AS via
       FROM pg_roles r CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE r.rolname = ANY($1::text[]) AND n.nspname = 'app' AND p.proname LIKE 'maintenance\\_%'
      ORDER BY r.rolname, p.proname`,
    [refused],
  );
  if (r.rowCount !== refused.length * 3) throw new Error(`ISO-29: expected ${refused.length} roles x 3 maintenance functions, found ${r.rowCount} pairs`);
  const found = new Map<string, ExecuteHolder>();
  for (const row of r.rows) {
    if (found.has(row.role) || (row.via ?? []).length === 0) continue;
    const via = row.via!;
    found.set(row.role, { role: row.role, reason: `EXECUTE on app.${row.fn} through ${via.map((y) => (y === row.role ? "itself" : `membership of ${y}`)).join(", ")}` });
  }
  return [...found.values()];
}

export async function assertNoEffectiveExecute(ctx: AssertionContext, id: string): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    const holders = await effectiveExecuteHolders(client);
    if (holders.length > 0) throw new Error(`${id}: role(s) that must be refused can execute a maintenance function: ${holders.map((h) => `${h.role} (${h.reason})`).join("; ")}`);
  } finally {
    await client.end();
  }
}

export const assertIso29MaintenanceExecuteEffective = (ctx: AssertionContext): Promise<void> => assertNoEffectiveExecute(ctx, "ISO-29");

export const iso29Breaker: Breaker = {
  id: "ISO-29",
  description: "grants nominara_owner to nominara_worker WITH INHERIT TRUE (a runtime role effectively executes the maintenance functions) and revokes it",
  apply: async (client) => {
    await client.query("GRANT nominara_owner TO nominara_worker WITH INHERIT TRUE");
  },
  revert: async (client) => {
    await client.query("REVOKE nominara_owner FROM nominara_worker");
  },
};
