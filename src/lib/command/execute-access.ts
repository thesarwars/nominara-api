import { PermissionDeniedException, ProjectOutOfScopeException } from "../../tenancy/errors.js";
import { evaluatePermission, type Permission } from "../../tenancy/permission-matrix.js";
import { assertStepUpFresh } from "../../tenancy/step-up.js";
import type { ParseRecord } from "./parse-record.js";

// STORY-085 AC "the bar is never a privilege path" - the permission the UNDERLYING endpoint declares, evaluated
// against the caller's LIVE membership at execute (the same matrix RbacGuard reads), not against anything the
// parse recorded about the caller. The parse recorded only which permission the action needs.
//
// Shared by the credit guard (which must refuse BEFORE it reserves) and the execute handler (which is the
// backstop when a project is chosen at execute), so the two cannot disagree.

export interface ExecuteMembership {
  readonly role: string;
  readonly projectScope: readonly string[] | null | undefined;
}

/**
 * Throws the same 403 the underlying route would: `forbidden` naming the permission, or `project_out_of_scope`.
 * `projectId` is the project the action will run on, when known; a scoped caller with a non-empty scope is
 * re-checked by the handler once the project is resolved.
 */
export function assertMayExecute(
  record: Pick<ParseRecord, "required_permission">,
  membership: ExecuteMembership | undefined,
  projectId: string | null,
  lastStrongAuthAt: Date | null,
): void {
  const permission = record.required_permission;
  if (permission === null) return;
  // No live membership means no role to evaluate: fail closed.
  if (membership === undefined) throw new PermissionDeniedException(permission);
  const rule = evaluatePermission(membership.role, permission as Permission);
  if (rule.access === "deny") throw new PermissionDeniedException(permission);
  if (rule.access === "scoped") {
    const scope = membership.projectScope;
    // null/undefined is unrestricted; an empty array is scoped to NOTHING and refuses every project-bound action.
    if (scope !== null && scope !== undefined) {
      if (scope.length === 0) throw new ProjectOutOfScopeException();
      if (projectId !== null && !scope.includes(projectId)) throw new ProjectOutOfScopeException();
    }
  }
  if (rule.stepUp) assertStepUpFresh(lastStrongAuthAt);
}

/** Why an action is disabled for this caller, in the `forbidden:<permission>` form FR-CMD-05 names; null when it is not. */
export function disabledReasonFor(
  requiredPermission: string | null,
  membership: ExecuteMembership | undefined,
): string | null {
  if (requiredPermission === null) return null;
  if (membership === undefined) return `forbidden:${requiredPermission}`;
  const rule = evaluatePermission(membership.role, requiredPermission as Permission);
  if (rule.access === "deny") return `forbidden:${requiredPermission}`;
  if (rule.access === "scoped" && membership.projectScope?.length === 0) return `forbidden:${requiredPermission}`;
  return null;
}
