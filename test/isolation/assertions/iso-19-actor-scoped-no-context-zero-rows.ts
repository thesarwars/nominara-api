import type { AssertionContext } from "../support/assertion-context.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { ACTOR_SELF_SCOPED_TABLES } from "../../../src/db/conventions.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// STORY-021 / ADR-0001 ISO-19 — an ISO-01 regression, specific to the two
// tables this story added a SECOND permissive policy to: with absolutely NO
// context set at all (no BEGIN, no set_config of any kind — not even the
// workspace GUC cleared), `workspaces`/`workspace_members` must still return
// zero rows. ISO-01 already covers this generically for every tenant table;
// this is a dedicated, exact-table regression so a future edit to
// computeActorSelfScopedPolicies that accidentally drops the
// `user_id = app.current_actor()` conjunct (leaving only
// `app.current_workspace() IS NULL`, which is trivially true with no
// workspace GUC set either) is caught here explicitly.
export async function assertIso19NoGucsZeroRows(ctx: AssertionContext): Promise<void> {
  const app = await connectAsRole(ctx.target, "nominara_app");
  try {
    for (const table of ACTOR_SELF_SCOPED_TABLES) {
      const result = await app.query<{ count: string }>(`SELECT count(*) FROM ${table}`);
      const count = Number(result.rows[0]!.count);
      if (count !== 0) {
        throw new Error(
          `ISO-19: ${table} returned ${count} row(s) with NO context set at all (role=nominara_app) — the actor-self-scoped ` +
            "policy must never admit a request that identifies neither a workspace nor an actor",
        );
      }
    }
  } finally {
    await app.end();
  }
}

export const iso19Breaker: Breaker = {
  id: "ISO-19",
  description: "drops the actor-identity conjunct from self_membership_workspace_members, leaking every member row when no context is set at all",
  apply: async (client) => {
    await client.query("ALTER POLICY self_membership_workspace_members ON workspace_members USING (app.current_workspace() IS NULL)");
  },
  revert: NOOP_REVERT,
};
