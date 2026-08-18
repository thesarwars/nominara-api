import { Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";

// STORY-022 scaffold, extended by STORY-018 with the two workspace-status
// mutations its own test scenarios need (suspend a workspace; bump the
// entitlement version). Full workspace CRUD (create/update/delete,
// ownership transfer) remains a future story's job per
// coding-standards.md §3 — services call Drizzle/pg directly, no repository
// layer.
@Injectable()
export class WorkspacesService {
  /** Test scenario 8: a suspended workspace refuses access immediately (WorkspaceGuard reads status live, never cached). */
  async suspend(pool: Pool, workspaceId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await tx.query("UPDATE workspaces SET status = 'suspended', updated_at = now() WHERE id = $1", [
          workspaceId,
        ]);
      });
    } finally {
      client.release();
    }
  }

  /** Test scenario 7: bumping entitlement_version forces the next request bearing a stale ent_v claim to refresh. */
  async bumpEntitlementVersion(pool: Pool, workspaceId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await tx.query(
          "UPDATE workspaces SET entitlement_version = entitlement_version + 1, updated_at = now() WHERE id = $1",
          [workspaceId],
        );
      });
    } finally {
      client.release();
    }
  }
}
