import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { DEFINER_OWNER_ROLES } from "../../../src/db/conventions.js";
import { type Breaker } from "../support/breakers.js";

// ADR-0002 Decision 1 / checkpoint-4 finding 1 — nobody is a member of a definer-owner role.
//
// WHY THIS IS AN ISOLATION ASSERTION. share_token_gate_lookup is `FOR SELECT TO nominara_share_lookup USING (true)`: it
// admits EVERY share_tokens row, every workspace's password_hash included, to anyone holding the role's privileges. The
// only thing keeping that inert is that nobody can assume the role. Granting it to nominara_worker let the worker run
// SET ROLE and read two workspaces' hashes with no tenant context, and no test noticed.
//
// Two independent checks: the raw catalog (pg_auth_members) and the effective reach (pg_has_role MEMBER/USAGE/SET for
// every non-superuser role). Superusers are excluded from the second because they can assume any role by definition.
export async function assertIso24DefinerOwnerNoMembers(ctx: AssertionContext): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    const owners = Object.keys(DEFINER_OWNER_ROLES);
    const exist = await client.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])", [owners]);
    if (exist.rowCount !== owners.length) {
      throw new Error(`ISO-24: expected definer-owner role(s) ${owners.join(", ")}, found ${exist.rows.map((r) => r.rolname).join(", ") || "none"}`);
    }
    const members = await client.query<{ role: string; member: string }>(
      `SELECT r.rolname AS role, m.rolname AS member
         FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
        WHERE r.rolname = ANY($1::text[])`,
      [owners],
    );
    if (members.rowCount !== 0) {
      throw new Error(`ISO-24: definer-owner role has member(s): ${members.rows.map((r) => `${r.member} in ${r.role}`).join(", ")}`);
    }
    const reach = await client.query<{ role: string; owner: string; kind: string }>(
      `SELECT r.rolname AS role, o.rolname AS owner, k.kind
         FROM pg_roles r CROSS JOIN pg_roles o CROSS JOIN (VALUES ('MEMBER'), ('USAGE'), ('SET')) AS k(kind)
        WHERE o.rolname = ANY($1::text[]) AND r.oid <> o.oid AND NOT r.rolsuper AND pg_has_role(r.oid, o.oid, k.kind)`,
      [owners],
    );
    if (reach.rowCount !== 0) {
      throw new Error(`ISO-24: non-superuser role(s) can assume a definer-owner role: ${reach.rows.map((r) => `${r.role} ${r.kind} ${r.owner}`).join(", ")}`);
    }
  } finally {
    await client.end();
  }
}

// Role membership is CLUSTER-WIDE (pg_auth_members is shared), so — like ISO-07 — `revert` does real work and must run
// before the disposable database is dropped. This is exactly mutation D2 from the finding.
export const iso24Breaker: Breaker = {
  id: "ISO-24",
  description: "grants nominara_share_lookup to nominara_worker (mutation D2) and revokes it",
  apply: async (client) => {
    await client.query("GRANT nominara_share_lookup TO nominara_worker");
  },
  revert: async (client) => {
    await client.query("REVOKE nominara_share_lookup FROM nominara_worker");
  },
};
