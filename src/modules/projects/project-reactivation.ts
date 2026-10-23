import type { ClientBase } from "pg";
import { EntitlementExceededError, NotFoundError } from "../../api/errors/domain-errors.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import { resolveEntitlements } from "../../lib/entitlements/resolution.js";
import { countStructural } from "../../lib/entitlements/structural-usage.js";
import { lockWorkspaceForActivation } from "../prompts/active-limit.js";

// STORY-077 — OWNER DECISION 2026-10-23. Archived and person-paused projects use NO plan slot (`projects.max` counts
// the tracking ones: structural-usage.ts `PROJECT_USES_SLOT`). The other half of that rule lives here: leaving `archived`
// or `paused` - an un-archive, a person's resume, or a person resuming a project a downgrade paused - is a move INTO a
// slot, so it needs room under the resolved `projects.max`, or it is refused 403 `entitlement_exceeded`. Without it,
// archiving would be a way around the limit: archive one, create one, un-archive the first.
//
// ⚠ THE SAME LOCK PATTERN AS A PROMPT RESUME (active-limit.ts). The count is workspace-wide, so the workspace row lock
// (bounded, the one every billing writer takes, in their order: workspace, then projects) is taken FIRST, then the
// project row, and the limit is resolved AFTER the lock from the committed version. Two moves that each see one free
// slot therefore serialise, and the second counts the first. POST /projects takes the same lock and the same check
// (projects.service.ts), so a creation cannot race a reactivation either.
//
// ⚠ NO HTTP DOOR YET. `PATCH /projects/{id}` (api-specification.md §3) is not built; it must call `reactivateProject`
// for any status change out of `archived` or `paused`. Nothing else in the API moves a project out of those states except
// the downgrade reconcile, which plans within the limit itself.

type Entitlements = Readonly<Record<string, { readonly value: unknown } | undefined>>;

/**
 * Refuses (403 `entitlement_exceeded`, `projects.max`) when one more TRACKING project would take the workspace above its
 * resolved project limit. The caller holds the workspace lock (`lockWorkspaceForActivation`), or two calls can both pass.
 */
export async function assertProjectSlotFree(client: ClientBase, workspaceId: string, entitlements: Entitlements): Promise<void> {
  const value = entitlements["projects.max"]?.value;
  const parsed = value === undefined ? undefined : structuralLimitFrom(value as EntitlementValue);
  const limit = parsed === undefined ? 0 : parsed.kind === "unlimited" ? null : parsed.limit;
  if (limit === null) return;
  const current = await countStructural(client, "projects.max", workspaceId);
  if (current + 1 > limit) {
    throw new EntitlementExceededError({
      message: `this plan allows ${String(limit)} tracking projects: archive or pause one, or upgrade`,
      details: { key: "projects.max", limit, current },
      remediation: { kind: "increase_limit", url: "/settings/billing" },
    });
  }
}

/**
 * Moves an archived or paused project back to tracking, inside the CALLER's tenant transaction: to `active`, or, for a
 * project a downgrade paused, to what it was (`initializing` stays initializing), clearing the downgrade marker. A
 * project already tracking is returned unchanged (no limit check: it holds its slot already). Refused 403 when no slot
 * is free; a refusal writes nothing.
 */
export async function reactivateProject(client: ClientBase, input: { readonly workspaceId: string; readonly projectId: string }): Promise<{ id: string; status: "active" | "initializing" }> {
  await lockWorkspaceForActivation(client, input.workspaceId);
  const found = await client.query<{ status: string; paused_by_downgrade_from: "active" | "initializing" | null }>(
    "SELECT status, paused_by_downgrade_from FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE",
    [input.projectId, input.workspaceId],
  );
  const row = found.rows[0];
  if (row === undefined) throw new NotFoundError({ message: "no such project" });
  if (row.status === "active" || row.status === "initializing") return { id: input.projectId, status: row.status };

  const resolved = await resolveEntitlements(client, input.workspaceId);
  await assertProjectSlotFree(client, input.workspaceId, resolved.entitlements);

  const status = row.paused_by_downgrade_from ?? "active";
  await client.query(
    `UPDATE projects SET status = $2, paused_by_downgrade_at = NULL, paused_by_downgrade_from = NULL, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL`,
    [input.projectId, status],
  );
  return { id: input.projectId, status };
}
