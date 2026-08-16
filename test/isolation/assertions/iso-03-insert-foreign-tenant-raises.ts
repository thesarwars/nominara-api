import type { AssertionContext } from "../support/assertion-context.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { withTenantContext } from "../../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../../src/tenancy/constants.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-03 / STORY-012 T13 — INSERT under A's
// context carrying B's workspace_id raises 42501 — the SQLSTATE is asserted,
// never message text. Mutating: relies on withTenantContext's own
// rollback-on-throw (the INSERT never reaches COMMIT), so the shared fixture
// is untouched regardless of pass/fail.
export async function assertIso03InsertForeignTenantRaises(ctx: AssertionContext, role = "nominara_app"): Promise<void> {
  const { a, b } = ctx.fixture;
  const app = await connectAsRole(ctx.target, role);
  try {
    let raised: { code?: string } | undefined;
    try {
      await withTenantContext(app, { workspaceId: a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        // A's own project_id, but B's workspace_id — a crafted cross-tenant payload.
        return tx.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'ISO-03 probe')", [
          b.workspaceId,
          a.projectIds[0],
        ]);
      });
    } catch (error) {
      raised = error as { code?: string };
    }

    if (!raised) {
      throw new Error("ISO-03: INSERT with a foreign tenant's workspace_id did not raise at all");
    }
    if (raised.code !== "42501") {
      throw new Error(`ISO-03: expected SQLSTATE 42501, got ${raised.code ?? "undefined"}`);
    }
  } finally {
    await app.end();
  }
}

export const iso03Breaker: Breaker = {
  id: "ISO-03",
  description: "drops the WITH CHECK from a tenant table's policy, permitting a cross-tenant INSERT",
  apply: async (client) => {
    await client.query("ALTER POLICY ws_isolation_competitors ON competitors WITH CHECK (true)");
  },
  revert: NOOP_REVERT,
};
