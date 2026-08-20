import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { withActorContext } from "../../../src/tenancy/tenant-context.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// STORY-021 / ADR-0001 ISO-18 — actor-only context (withActorContext) shows
// an actor ALL of their own workspace_members rows regardless of status (the
// generated policy has no status conjunct — see generate.ts's
// computeActorSelfScopedPolicies), but the `workspaces` policy only surfaces
// a workspace where that membership is 'active'. Verified across TWO actors
// so a bug that keys off "any row exists" rather than "this actor's own row"
// cannot pass vacuously. Seeds one extra cross-tenant membership directly
// (idempotent delete-then-insert) rather than touching
// three-tenant-fixture.ts, which several other assertions rely on staying
// exactly as-is (ROW_COUNT=50, no removed/suspended rows by default).
const FOREIGN_ROLE = "viewer";

async function deleteForeignMembership(ctx: AssertionContext, actorId: string, foreignWorkspaceId: string): Promise<void> {
  const superuser = await connectSuperuser(ctx);
  try {
    await superuser.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND role = $3", [
      foreignWorkspaceId,
      actorId,
      FOREIGN_ROLE,
    ]);
  } finally {
    await superuser.end();
  }
}

async function seedForeignRemovedMembership(ctx: AssertionContext, actorId: string, foreignWorkspaceId: string): Promise<void> {
  // Idempotent delete-then-insert — clears out any stray row left behind by
  // a prior run that crashed before its own teardown ran.
  await deleteForeignMembership(ctx, actorId, foreignWorkspaceId);
  const superuser = await connectSuperuser(ctx);
  try {
    await superuser.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, $3, 'removed')", [
      foreignWorkspaceId,
      actorId,
      FOREIGN_ROLE,
    ]);
  } finally {
    await superuser.end();
  }
}

export async function assertIso18ActorSelfScopedMultiActor(ctx: AssertionContext): Promise<void> {
  const { a, b, c } = ctx.fixture;
  const selfActor = a.userIds[5]!;
  const otherActor = c.userIds[7]!;

  await seedForeignRemovedMembership(ctx, selfActor, b.workspaceId);

  try {
    await assertIso18Body(ctx, selfActor, otherActor);
  } finally {
    // The shared seed database's documented baseline (three-tenant-fixture.ts)
    // has NO removed/suspended rows — restore it regardless of pass/fail so
    // other assertions relying on that baseline are never affected by this one.
    await deleteForeignMembership(ctx, selfActor, b.workspaceId);
  }
}

async function assertIso18Body(ctx: AssertionContext, selfActor: string, otherActor: string): Promise<void> {
  const { a, b, c } = ctx.fixture;
  const app = await connectAsRole(ctx.target, "nominara_app");
  try {
    await withActorContext(app, { actorId: selfActor }, async (tx) => {
      const members = await tx.query<{ workspace_id: string; status: string }>("SELECT workspace_id, status FROM workspace_members");
      if (members.rows.length !== 2) {
        throw new Error(`ISO-18: expected exactly 2 workspace_members rows (own rows, any status) for actor ${selfActor}, got ${members.rows.length}`);
      }
      const byWorkspace = new Map(members.rows.map((r) => [r.workspace_id, r.status]));
      if (byWorkspace.get(a.workspaceId) !== "active") {
        throw new Error("ISO-18: missing/incorrect ACTIVE workspace_members row for tenant A");
      }
      if (byWorkspace.get(b.workspaceId) !== "removed") {
        throw new Error("ISO-18: missing/incorrect REMOVED workspace_members row for tenant B");
      }

      const workspaces = await tx.query<{ id: string }>("SELECT id FROM workspaces");
      if (workspaces.rows.length !== 1 || workspaces.rows[0]!.id !== a.workspaceId) {
        throw new Error(
          `ISO-18: expected exactly [${a.workspaceId}] visible under actor ${selfActor}, got [${workspaces.rows.map((r) => r.id).join(", ")}] — a removed membership must not surface its workspace`,
        );
      }
    });

    await withActorContext(app, { actorId: otherActor }, async (tx) => {
      const members = await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM workspace_members");
      if (members.rows.length !== 1 || members.rows[0]!.workspace_id !== c.workspaceId) {
        throw new Error(`ISO-18: a DIFFERENT actor (${otherActor}) did not see EXACTLY their own single workspace_members row`);
      }

      const workspaces = await tx.query<{ id: string }>("SELECT id FROM workspaces");
      if (workspaces.rows.length !== 1 || workspaces.rows[0]!.id !== c.workspaceId) {
        throw new Error(`ISO-18: a DIFFERENT actor (${otherActor}) leaked or missed rows outside their own workspace`);
      }
    });
  } finally {
    await app.end();
  }
}

export const iso18Breaker: Breaker = {
  id: "ISO-18",
  description: "drops the active-status conjunct from self_membership_workspaces, leaking a workspace behind a removed/suspended membership",
  apply: async (client) => {
    await client.query(
      `ALTER POLICY self_membership_workspaces ON workspaces USING (app.current_workspace() IS NULL AND EXISTS (
         SELECT 1 FROM workspace_members m WHERE m.workspace_id = workspaces.id AND m.user_id = app.current_actor()))`,
    );
  },
  revert: NOOP_REVERT,
};
