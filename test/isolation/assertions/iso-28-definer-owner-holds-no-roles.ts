import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { DEFINER_OWNER_ROLES } from "../../../src/db/conventions.js";
import { type Breaker } from "../support/breakers.js";

// STORY-013 r3 / ADR-0004 — the CONVERSE of ISO-24. ISO-24 says nobody can assume a definer-owner role; this says a definer-owner role
// can assume nobody. A definer-owner role is NOINHERIT, but PG16+ decides INHERIT per GRANT, so a grant `GRANT x TO nominara_maintenance
// WITH INHERIT TRUE` would hand a SECURITY DEFINER body the rights of x whatever the role attribute says. Two checks: the raw catalog
// (pg_auth_members, member side) and the effective reach (pg_has_role for every other role).
export async function assertIso28DefinerOwnerHoldsNoRoles(ctx: AssertionContext): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    const owners = Object.keys(DEFINER_OWNER_ROLES);
    const held = await client.query<{ member: string; role: string }>(
      `SELECT m.rolname AS member, r.rolname AS role
         FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member JOIN pg_roles r ON r.oid = am.roleid
        WHERE m.rolname = ANY($1::text[])`,
      [owners],
    );
    if (held.rowCount !== 0) {
      throw new Error(`ISO-28: definer-owner role is a member of other role(s): ${held.rows.map((r) => `${r.member} in ${r.role}`).join(", ")}`);
    }
    const reach = await client.query<{ owner: string; role: string; kind: string }>(
      `SELECT o.rolname AS owner, r.rolname AS role, k.kind
         FROM pg_roles o CROSS JOIN pg_roles r CROSS JOIN (VALUES ('MEMBER'), ('USAGE'), ('SET')) AS k(kind)
        WHERE o.rolname = ANY($1::text[]) AND r.oid <> o.oid AND pg_has_role(o.oid, r.oid, k.kind)`,
      [owners],
    );
    if (reach.rowCount !== 0) {
      throw new Error(`ISO-28: definer-owner role can assume other role(s): ${reach.rows.map((r) => `${r.owner} ${r.kind} ${r.role}`).join(", ")}`);
    }
  } finally {
    await client.end();
  }
}

// Role membership is CLUSTER-WIDE, so `revert` does real work and must run before the disposable database is dropped.
export const iso28Breaker: Breaker = {
  id: "ISO-28",
  description: "grants nominara_worker to nominara_maintenance WITH INHERIT TRUE (the owner holds a runtime role's rights) and revokes it",
  apply: async (client) => {
    await client.query("GRANT nominara_worker TO nominara_maintenance WITH INHERIT TRUE");
  },
  revert: async (client) => {
    await client.query("REVOKE nominara_worker FROM nominara_maintenance");
  },
};
