import { Injectable } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import { MembershipCacheService, type CachedMembership } from "../../tenancy/membership-cache.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";

// STORY-018 — security-and-tenancy.md §7. Reads workspace_members/workspaces
// through a short-lived withTenantContext transaction dedicated to THIS
// check: WorkspaceGuard runs before TenantContextInterceptor opens the
// per-request transaction, and workspace_members/workspaces are both
// RLS-enforced tenant tables (workspaces scoped by its own id — "the
// workspace table's exception", security-and-tenancy.md §3), so there is no
// way to read either without first setting app.current_workspace_id to the
// workspace being checked. The connection is checked out and released here,
// independently of whatever connection the request's own transaction later
// uses.

export interface WorkspaceStatus {
  readonly status: string;
  readonly entitlementVersion: number;
  readonly deletedAt: Date | null;
}

@Injectable()
export class MembershipService {
  constructor(private readonly cache: MembershipCacheService) {}

  /** Always live, never cached — a suspended workspace must refuse access immediately, not within the membership cache's 30 s bound. */
  async getWorkspaceStatus(pool: Pool, workspaceId: string): Promise<WorkspaceStatus | null> {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        const result = await tx.query<{ status: string; entitlement_version: number; deleted_at: Date | null }>(
          "SELECT status, entitlement_version, deleted_at FROM workspaces WHERE id = $1",
          [workspaceId],
        );
        const row = result.rows[0];
        return row
          ? { status: row.status, entitlementVersion: row.entitlement_version, deletedAt: row.deleted_at }
          : null;
      });
    } finally {
      client.release();
    }
  }

  /**
   * The membership re-check every request makes: "It never trusts the
   * token's role claim." Cached for 30 s keyed mem:{user}:{ws}
   * (MembershipCacheService), invalidated synchronously by removeMember/
   * updateRole below rather than left to expire.
   */
  async getLiveMembership(pool: Pool, userId: string, workspaceId: string): Promise<CachedMembership | null> {
    const cached = this.cache.get(userId, workspaceId);
    if (cached) {
      return cached;
    }

    // Snapshotted BEFORE the DB round trip below — see membership-cache.ts's
    // class-level comment (STORY-018 review finding 1). If a concurrent
    // removeMember/updateRole invalidates this key before `set()` runs, the
    // generation will have moved on and the write below becomes a no-op
    // instead of resurrecting the pre-mutation row.
    const generation = this.cache.beginRead(userId, workspaceId);

    const client = await pool.connect();
    try {
      const membership = await withTenantContext(client, { workspaceId, actorId: userId }, async (tx) => {
        const result = await tx.query<{ role: string; status: string; project_scope: string[] | null }>(
          "SELECT role, status, project_scope FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
          [workspaceId, userId],
        );
        const row = result.rows[0];
        return row ? { role: row.role, status: row.status, projectScope: row.project_scope } : null;
      });

      // Only an ACTIVE membership is worth caching — caching a removed/
      // suspended row would itself become the stale state this story exists
      // to prevent. A miss (or a non-active row) is re-read from Postgres on
      // every request until it becomes active, which is the safe direction
      // to be wrong in.
      if (membership && membership.status === "active") {
        this.cache.set(userId, workspaceId, membership, generation);
      }
      return membership;
    } finally {
      client.release();
    }
  }

  /**
   * STORY-018's own minimal mutation seam so this story's test scenarios
   * (remove/downgrade) are real, not simulated — STORY-021's full
   * member-management surface reuses this method rather than duplicating
   * the invalidation.
   *
   * `ambientClient`, when supplied (STORY-021 code-review fix), is an
   * already-open, context-carrying client (e.g. currentTenantStore()!.client
   * from an ordinary /members/{id} route) — the UPDATE runs directly on it
   * instead of opening a second, competing transaction, so this mutation
   * commits or rolls back atomically with TenantContextInterceptor's ambient
   * transaction and AuditInterceptor's audit write. Without this, the
   * mutation could commit on its own connection while the audit write later
   * failed and rolled back the ambient transaction — a split-brain where the
   * client is told the request failed but the role/removal change already
   * stuck. Callers with no ambient transaction (STORY-018's own tests) keep
   * passing a bare `pool` and get the old own-transaction behavior.
   */
  async removeMember(pool: Pool, workspaceId: string, userId: string, ambientClient?: ClientBase): Promise<void> {
    if (ambientClient) {
      await ambientClient.query(
        "UPDATE workspace_members SET status = 'removed', updated_at = now() WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId, userId],
      );
    } else {
      const client = await pool.connect();
      try {
        await withTenantContext(client, { workspaceId, actorId: userId }, async (tx) => {
          await tx.query(
            "UPDATE workspace_members SET status = 'removed', updated_at = now() WHERE workspace_id = $1 AND user_id = $2",
            [workspaceId, userId],
          );
        });
      } finally {
        client.release();
      }
    }
    // Synchronous, in the same method as the mutation — not left to expiry.
    // NOTE: this fires even when ambientClient's enclosing transaction later
    // rolls back (e.g. the audit write fails) — an over-eager cache
    // invalidation just means the next read re-checks Postgres, the safe
    // direction to be wrong in (see getLiveMembership's own comment).
    this.cache.invalidate(userId, workspaceId);
  }

  /** See removeMember's note — same seam and same ambientClient behavior, for a role change instead of removal. */
  async updateRole(
    pool: Pool,
    workspaceId: string,
    userId: string,
    role: string,
    ambientClient?: ClientBase,
  ): Promise<void> {
    if (ambientClient) {
      await ambientClient.query(
        "UPDATE workspace_members SET role = $3, updated_at = now() WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId, userId, role],
      );
    } else {
      const client = await pool.connect();
      try {
        await withTenantContext(client, { workspaceId, actorId: userId }, async (tx) => {
          await tx.query(
            "UPDATE workspace_members SET role = $3, updated_at = now() WHERE workspace_id = $1 AND user_id = $2",
            [workspaceId, userId, role],
          );
        });
      } finally {
        client.release();
      }
    }
    this.cache.invalidate(userId, workspaceId);
  }
}
