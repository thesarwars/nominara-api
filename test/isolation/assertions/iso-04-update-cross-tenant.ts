import type { AssertionContext } from "../support/assertion-context.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { withTenantContext } from "../../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../../src/tenancy/constants.js";
import { connectSuperuser } from "../support/assertion-context.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-04 / STORY-012 T14 — UPDATE moving a row
// to another tenant, under the owning tenant's own context, either affects 0
// rows OR raises — the disjunction is asserted EXPLICITLY (both outcomes are
// acceptable; SILENTLY SUCCEEDING is the only failure).
export async function assertIso04UpdateCrossTenant(ctx: AssertionContext, role = "nominara_app"): Promise<void> {
  const { a, b } = ctx.fixture;
  const superuser = await connectSuperuser(ctx);
  const competitorId = a.competitorIds[0]!;
  const before = await superuser.query<{ workspace_id: string }>("SELECT workspace_id FROM competitors WHERE id = $1", [competitorId]);
  await superuser.end();
  if (before.rows[0]?.workspace_id !== a.workspaceId) {
    throw new Error("ISO-04: fixture precondition failed — probe row is not owned by tenant A");
  }

  const app = await connectAsRole(ctx.target, role);
  let raised: { code?: string } | undefined;
  let rowCount = -1;
  try {
    try {
      const result = await withTenantContext(app, { workspaceId: a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        return tx.query("UPDATE competitors SET workspace_id = $1 WHERE id = $2", [b.workspaceId, competitorId]);
      });
      rowCount = result.rowCount ?? -1;
    } catch (error) {
      raised = error as { code?: string };
    }
  } finally {
    await app.end();
  }

  if (raised === undefined && rowCount !== 0) {
    throw new Error(`ISO-04: cross-tenant UPDATE neither raised NOR affected 0 rows (affected ${rowCount})`);
  }
  if (raised !== undefined && raised.code !== "42501") {
    throw new Error(`ISO-04: cross-tenant UPDATE raised, but SQLSTATE was ${raised.code ?? "undefined"}, not 42501`);
  }
}

export const iso04Breaker: Breaker = {
  id: "ISO-04",
  description: "widens a tenant table's policy so USING no longer constrains the post-update row, permitting a silent cross-tenant UPDATE",
  apply: async (client) => {
    await client.query("ALTER POLICY ws_isolation_competitors ON competitors USING (true) WITH CHECK (true)");
  },
  revert: NOOP_REVERT,
};
