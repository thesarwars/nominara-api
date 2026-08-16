import type { Client } from "pg";
import type { AssertionContext } from "../support/assertion-context.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { PORTAL_READABLE_TABLES } from "../../../src/db/conventions.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

async function withPortalContext<T>(client: Client, workspaceId: string, scopeProjectIds: readonly string[], fn: (tx: Client) => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    if (scopeProjectIds.length > 0) {
      await client.query("SELECT set_config('app.current_scope_projects', $1, true)", [scopeProjectIds.join(",")]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// security-and-tenancy.md §10 ISO-09 / STORY-012 T15 — a share-token session
// cannot read a project outside app.current_scope_projects, EVEN within the
// SAME workspace, across all 18 PORTAL_READABLE_TABLES (src/db/conventions.ts
// — count not reopened here, per the story's own decision).
export async function assertIso09PortalReadScope(ctx: AssertionContext): Promise<void> {
  if (PORTAL_READABLE_TABLES.length !== 18) {
    throw new Error(`ISO-09: expected 18 PORTAL_READABLE_TABLES, found ${PORTAL_READABLE_TABLES.length}`);
  }

  const { a } = ctx.fixture;
  // projectIds[2] is in scope, projectIds[3] is the same workspace but OUT of scope.
  const inScopeProject = a.projectIds[2]!;
  const outOfScopeProject = a.projectIds[3]!;

  const portal = await connectAsRole(ctx.target, "nominara_portal");
  try {
    await withPortalContext(portal, a.workspaceId, [inScopeProject], async (tx) => {
      for (const table of PORTAL_READABLE_TABLES) {
        const scopeColumn = table === "projects" ? "id" : "project_id";
        const outOfScope = await tx.query(`SELECT 1 FROM ${table} WHERE ${scopeColumn} = $1`, [outOfScopeProject]);
        if ((outOfScope.rowCount ?? 0) > 0) {
          throw new Error(`ISO-09: ${table} leaked a row from an out-of-scope project within the same workspace`);
        }
        const inScope = await tx.query(`SELECT 1 FROM ${table} WHERE ${scopeColumn} = $1`, [inScopeProject]);
        if ((inScope.rowCount ?? 0) === 0) {
          throw new Error(`ISO-09: ${table} returned ZERO rows for the in-scope project — cannot distinguish "isolated" from "bricked"`);
        }
      }
    });
  } finally {
    await portal.end();
  }
}

export const iso09Breaker: Breaker = {
  id: "ISO-09",
  description: "drops the project-scope conjunct from a portal policy, leaking every project in the workspace",
  apply: async (client) => {
    await client.query(
      "ALTER POLICY portal_scope_competitors ON competitors USING (workspace_id = app.current_workspace())",
    );
  },
  revert: NOOP_REVERT,
};
