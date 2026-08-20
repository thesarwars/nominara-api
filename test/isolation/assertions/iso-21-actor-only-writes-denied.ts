import type { ClientBase } from "pg";
import type { AssertionContext } from "../support/assertion-context.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { withActorContext, type ActorOnlyContext } from "../../../src/tenancy/tenant-context.js";
import { ACTOR_GUC, WORKSPACE_GUC } from "../../../src/tenancy/constants.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// STORY-021 / ADR-0001 ISO-21 — every write (INSERT/UPDATE/DELETE) against
// BOTH self-scoped tables fails under an actor-only context. `SET LOCAL
// TRANSACTION READ ONLY` is the primary, asserted-explicitly defense
// (SQLSTATE 25006) — RLS's own WITH CHECK would independently deny most of
// these too (42501), but that is a SEPARATE backstop this story's own
// defense-in-depth deliberately does not rely on alone (tenant-context.ts's
// withActorContext doc comment).
type OpenActorTx = typeof withActorContext;

/** withActorContext's own sequence, minus SET LOCAL TRANSACTION READ ONLY — the exact regression this assertion exists to catch. */
const openActorTxWithoutReadOnly: OpenActorTx = async <T>(
  client: ClientBase,
  context: ActorOnlyContext,
  fn: (tx: ClientBase) => Promise<T>,
): Promise<T> => {
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config($1, $2, true)", [WORKSPACE_GUC, ""]);
    await client.query("SELECT set_config($1, $2, true)", [ACTOR_GUC, context.actorId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // best-effort — the original error below is what matters here
    }
    throw error;
  }
};

interface WriteProbe {
  readonly label: string;
  readonly sql: string;
  readonly params: readonly unknown[];
}

function probesFor(workspaceId: string, actorId: string): WriteProbe[] {
  return [
    {
      label: "INSERT workspace_members",
      sql: "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')",
      params: [workspaceId, actorId],
    },
    { label: "UPDATE workspace_members", sql: "UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = $1", params: [workspaceId] },
    { label: "DELETE workspace_members", sql: "DELETE FROM workspace_members WHERE workspace_id = $1", params: [workspaceId] },
    {
      label: "INSERT workspaces",
      sql: "INSERT INTO workspaces (name, slug, plan_key) VALUES ('ISO-21 probe', 'iso-21-write-probe', 'free')",
      params: [],
    },
    { label: "UPDATE workspaces", sql: "UPDATE workspaces SET name = 'ISO-21 probe' WHERE id = $1", params: [workspaceId] },
    { label: "DELETE workspaces", sql: "DELETE FROM workspaces WHERE id = $1", params: [workspaceId] },
  ];
}

export async function assertIso21ActorOnlyWritesDenied(ctx: AssertionContext, openTx: OpenActorTx = withActorContext): Promise<void> {
  const { a } = ctx.fixture;
  const actorId = a.userIds[3]!;
  const app = await connectAsRole(ctx.target, "nominara_app");
  try {
    for (const probe of probesFor(a.workspaceId, actorId)) {
      let raised: { code?: string } | undefined;
      try {
        await openTx(app, { actorId }, async (tx) => {
          await tx.query(probe.sql, probe.params as unknown[]);
        });
      } catch (error) {
        raised = error as { code?: string };
      }
      if (!raised) {
        throw new Error(`ISO-21: ${probe.label} under an actor-only context did not raise at all — writes must be categorically denied`);
      }
      if (raised.code !== "25006") {
        throw new Error(
          `ISO-21: ${probe.label} raised SQLSTATE ${raised.code ?? "undefined"}, expected 25006 (read_only_sql_transaction — SET LOCAL TRANSACTION READ ONLY)`,
        );
      }
    }
  } finally {
    await app.end();
  }
}

export const iso21Breaker: Breaker = {
  id: "ISO-21",
  description: "opens the actor-only transaction without SET LOCAL TRANSACTION READ ONLY (no database policy exists for this pure-code defense-in-depth property)",
  apply: NOOP_REVERT,
  revert: NOOP_REVERT,
};

/** Exported for the breaker-matrix test: runs the real assertion against the READ-ONLY-omitting variant — expected to throw the assertion's own "expected 25006" message. */
export async function assertIso21AgainstMissingReadOnly(ctx: AssertionContext): Promise<void> {
  return assertIso21ActorOnlyWritesDenied(ctx, openActorTxWithoutReadOnly);
}
