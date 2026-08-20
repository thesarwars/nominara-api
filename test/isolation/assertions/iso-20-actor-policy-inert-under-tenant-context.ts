import type { AssertionContext } from "../support/assertion-context.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { withTenantContext } from "../../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../../src/tenancy/constants.js";
import { ROW_COUNT } from "../support/three-tenant-fixture.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// STORY-021 / ADR-0001 ISO-20 — under a NORMAL (two-GUC) tenant-scoped
// transaction, the new self_membership_* policies must contribute ZERO
// additional rows beyond what the pre-existing ws_isolation_* policies
// already grant — proving the new OR-combined policy is "inert" whenever
// app.current_workspace() IS NOT NULL. Asserts EXACT counts (not >=), unlike
// ISO-02's generic loop, because a single extra row leaking in from the new
// policy is exactly the regression this story's own migration could
// introduce and ISO-02 (iterating all 59 tables generically) might not
// surface as sharply as a targeted, exact-count check on these two tables.
export async function assertIso20ActorPolicyInertUnderTenantContext(ctx: AssertionContext): Promise<void> {
  const { a } = ctx.fixture;
  const app = await connectAsRole(ctx.target, "nominara_app");
  try {
    await withTenantContext(app, { workspaceId: a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      const members = await tx.query<{ count: string }>("SELECT count(*) FROM workspace_members");
      const memberCount = Number(members.rows[0]!.count);
      if (memberCount !== ROW_COUNT) {
        throw new Error(
          `ISO-20: workspace_members under A's tenant context returned ${memberCount}, expected EXACTLY ${ROW_COUNT} — ` +
            "the actor-self-scoped policy must contribute zero additional rows under a normal tenant-scoped context",
        );
      }
      const foreignMembers = await tx.query<{ count: string }>("SELECT count(*) FROM workspace_members WHERE workspace_id <> $1", [
        a.workspaceId,
      ]);
      if (Number(foreignMembers.rows[0]!.count) !== 0) {
        throw new Error("ISO-20: workspace_members leaked a foreign-tenant row under A's normal tenant context");
      }

      const workspaces = await tx.query<{ id: string }>("SELECT id FROM workspaces");
      if (workspaces.rows.length !== 1 || workspaces.rows[0]!.id !== a.workspaceId) {
        throw new Error(
          `ISO-20: workspaces under A's tenant context returned [${workspaces.rows.map((r) => r.id).join(", ")}], expected ` +
            `EXACTLY [${a.workspaceId}] — the actor-self-scoped policy must not add any other workspace under a normal tenant-scoped context`,
        );
      }
    });
  } finally {
    await app.end();
  }
}

export const iso20Breaker: Breaker = {
  id: "ISO-20",
  description: "widens self_membership_workspaces to ignore the app.current_workspace() IS NULL conjunct, leaking every workspace even under a normal tenant-scoped context",
  apply: async (client) => {
    await client.query("ALTER POLICY self_membership_workspaces ON workspaces USING (true)");
  },
  revert: NOOP_REVERT,
};
