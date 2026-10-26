import type { ClientBase } from "pg";
import type { DigestCadence } from "../../../contracts/notifications/index.js";
import { evaluatePermission } from "../../tenancy/permission-matrix.js";

// STORY-068 — who sees a notification, and who is emailed about it. ONE definition, read by the inbox, the immediate
// email and the digest, so the three can never disagree about a member.
//
// VISIBILITY. A notification addressed to a user (`user_id`) is that user's alone; a workspace-wide one (`user_id` NULL)
// is every member's. A notification about a project is visible only to a member who may read that project: a role whose
// `project:read` is SCOPED (manager, viewer) sees the projects in its `project_scope` — NULL is every project, an empty
// array is none (rbac.guard.ts draws the same distinction) — and an unscoped role sees all.
//
// CADENCE. OWNER DECISION 2026-10-23: the digest is WEEKLY by default for owners, admins and managers; analysts and viewers
// default to off; each member may set their own (`workspace_members.digest_cadence`, NULL = the role's default). `off`
// stops alert email for that member entirely, the immediate critical email included.

export const DIGEST_DEFAULT_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "manager"]);

export function defaultCadenceFor(role: string): DigestCadence {
  return DIGEST_DEFAULT_ROLES.has(role) ? "weekly" : "off";
}

export function effectiveCadence(role: string, stored: string | null): DigestCadence {
  return stored === "off" || stored === "daily" || stored === "weekly" ? stored : defaultCadenceFor(role);
}

/** The projects a member may see notifications about: `null` is every project. */
export function visibleProjects(role: string, projectScope: readonly string[] | null): readonly string[] | null {
  if (evaluatePermission(role, "project:read").access !== "scoped") return null;
  return projectScope ?? null;
}

/** Whether a notification about `projectId` (null = no project) reaches a member who sees `visible` projects. */
export function seesProject(visible: readonly string[] | null, projectId: string | null): boolean {
  return projectId === null || visible === null || visible.includes(projectId);
}

/**
 * The SQL predicate (over a `notifications` alias `n`) for what one member sees. `$user` and `$scope` are bind
 * positions: the member's user id and the result of `visibleProjects` (NULL = every project).
 */
export function visibleToMemberSql(userParam: string, scopeParam: string): string {
  return `(n.user_id IS NULL OR n.user_id = ${userParam}::uuid) AND (n.project_id IS NULL OR ${scopeParam}::uuid[] IS NULL OR n.project_id = ANY(${scopeParam}::uuid[]))`;
}

export interface EmailRecipient {
  readonly userId: string;
  readonly role: string;
  readonly cadence: DigestCadence;
  readonly visible: readonly string[] | null;
}

/**
 * The active members of the workspace (inside the caller's tenant transaction) whose effective cadence is not `off`,
 * whose account is live and whose address is verified. `userId` narrows to one member (a user-addressed notification).
 */
export async function emailableMembers(tx: ClientBase, workspaceId: string, userId: string | null = null): Promise<EmailRecipient[]> {
  const rows = await tx.query<{ user_id: string; role: string; digest_cadence: string | null; project_scope: string[] | null }>(
    `SELECT m.user_id, m.role, m.digest_cadence, m.project_scope
       FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL
        AND ($2::uuid IS NULL OR m.user_id = $2::uuid)
      ORDER BY m.user_id`,
    [workspaceId, userId],
  );
  return rows.rows
    .map((row) => ({ userId: row.user_id, role: row.role, cadence: effectiveCadence(row.role, row.digest_cadence), visible: visibleProjects(row.role, row.project_scope) }))
    .filter((member) => member.cadence !== "off");
}
