import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { EntitlementExceededError, NotFoundError } from "../../api/errors/domain-errors.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";
import type { ProjectCadence } from "../../lib/capture/dispatch-cells.js";
import { nextRunAfter } from "../../lib/capture/scheduler.js";
import type { AuditActorType } from "../../lib/crypto/audit-chain.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import { resolveEntitlements } from "../../lib/entitlements/resolution.js";
import { countStructural } from "../../lib/entitlements/structural-usage.js";
import { AuditChainService } from "../audit/audit-chain.service.js";
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
// the downgrade reconcile, which plans within the limit itself. test/unit/projects/project-status-writers.spec.ts fails
// when a statement writing `projects.status` appears in any other file.
//
// Review round 2 — what the door does besides the limit, so the PATCH route inherits it rather than re-deriving it:
//   * a move to `active` RE-SEEDS `next_run_at` from the cadence (activation.service.ts `activateProject`'s rule): a
//     long-archived project's stale seed must never become an immediate overdue run; `manual` stores NULL;
//   * the transition is AUDITED (`project.reactivated`, from and to) on the hash chain, in the same transaction;
//   * a lock-wait timeout is counted under `path="project_reactivation"`, and the work runs in one span.

const tracer = trace.getTracer("nominara-api");

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

/** Who moved the project, for the audit row. */
export interface ReactivationActor {
  readonly type: AuditActorType;
  readonly id: string | null;
  readonly requestId: string;
}

/**
 * Moves an archived or paused project back to tracking, inside the CALLER's tenant transaction: to `active`, or, for a
 * project a downgrade paused, to what it was (`initializing` stays initializing), clearing the downgrade marker. A
 * project already tracking is returned unchanged (no limit check: it holds its slot already). Refused 403 when no slot
 * is free; a refusal writes nothing.
 */
export async function reactivateProject(
  client: ClientBase,
  input: { readonly workspaceId: string; readonly projectId: string; readonly actor: ReactivationActor },
): Promise<{ id: string; status: "active" | "initializing" }> {
  return await tracer.startActiveSpan("projects.reactivate", async (span) => {
    span.setAttributes({ "nominara.workspace_id": input.workspaceId, "nominara.project_id": input.projectId });
    try {
      const result = await reactivateInSpan(client, input);
      span.setAttribute("nominara.project.status", result.status);
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function reactivateInSpan(
  client: ClientBase,
  input: { readonly workspaceId: string; readonly projectId: string; readonly actor: ReactivationActor },
): Promise<{ id: string; status: "active" | "initializing" }> {
  await lockWorkspaceForActivation(client, input.workspaceId, "project_reactivation");
  const found = await client.query<{ status: string; cadence: ProjectCadence; paused_by_downgrade_from: "active" | "initializing" | null }>(
    "SELECT status, cadence, paused_by_downgrade_from FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE",
    [input.projectId, input.workspaceId],
  );
  const row = found.rows[0];
  if (row === undefined) throw new NotFoundError({ message: "no such project" });
  if (row.status === "active" || row.status === "initializing") return { id: input.projectId, status: row.status };

  const resolved = await resolveEntitlements(client, input.workspaceId);
  await assertProjectSlotFree(client, input.workspaceId, resolved.entitlements);

  const status = row.paused_by_downgrade_from ?? "active";
  if (status === "active") {
    // Re-seeded from now, never left at its old value: the rule activateProject applies (activation.service.ts).
    await client.query(
      `UPDATE projects SET status = 'active', next_run_at = $2, paused_by_downgrade_at = NULL, paused_by_downgrade_from = NULL, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL`,
      [input.projectId, nextRunAfter(row.cadence, new Date())],
    );
  } else {
    // Back to onboarding: confirming its prompts is what activates it and seeds next_run_at (activateProject).
    await client.query(
      `UPDATE projects SET status = 'initializing', paused_by_downgrade_at = NULL, paused_by_downgrade_from = NULL, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL`,
      [input.projectId],
    );
  }
  await new AuditChainService().append(client, {
    workspaceId: input.workspaceId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    actorIp: null,
    actorUa: null,
    action: "project.reactivated",
    resourceType: "project",
    resourceId: input.projectId,
    beforeState: { status: row.status },
    afterState: { status },
    requestId: input.actor.requestId,
    supportGrantId: null,
    severity: "notice",
  });
  return { id: input.projectId, status };
}
