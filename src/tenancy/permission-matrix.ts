// STORY-019 — security-and-tenancy.md §6 "Permission matrix", expressed
// once as data so RbacGuard and (eventually) the interface's disabled-state
// logic read the exact same source rather than two encodings that can
// diverge. `evaluatePermission` is pure — no clock, no I/O, no randomness —
// so it can be unit-tested directly against the spec table without a guard,
// a request, or a database.
//
// Step-up is a per-(role, permission) flag on the matrix cell, matching the
// table's own inline "(step-up)" markers — limited, per this story's
// decision, to the six permissions the table actually annotates
// (workspace:delete, workspace:transfer_ownership, sso:configure,
// apikey:create, agency:custom_domain, export:data — the last one only on
// the owner/admin cells, not manager/analyst).
//
// Deliberately NOT modelled here (out of this story's scope, enforced
// elsewhere by the owning service once it exists): "cannot grant owner"
// (member:update_role), "not owner" (member:remove), "dual accept"
// (workspace:transfer_ownership), and the "tools only" / "CSV only" method
// restrictions on credits:spend / export:data. Those are conditions on the
// action's target or payload, not on whether the role holds the permission.

export const ROLES = ["owner", "admin", "manager", "analyst", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "workspace:read",
  "workspace:update",
  "workspace:delete",
  "workspace:transfer_ownership",
  "member:invite",
  "member:update_role",
  "member:remove",
  "billing:read",
  "billing:write",
  "credits:spend",
  "sso:configure",
  "apikey:create",
  "project:create",
  "project:read",
  "project:update",
  "project:delete",
  "prompt:write",
  "tracking:trigger",
  "tracking:read",
  "lookup:execute",
  "lookup:read_history",
  "aux:trigger",
  "aux:read",
  "task:create",
  "task:move",
  "task:comment",
  "task:read",
  "optimizer:use",
  "agency:branding",
  "agency:custom_domain",
  "share_token:mint",
  "share_token:revoke",
  "export:data",
  "audit_log:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type PermissionAccess = "allow" | "scoped" | "deny";

export interface PermissionRule {
  readonly access: PermissionAccess;
  readonly stepUp: boolean;
}

export const DENIED_RULE: PermissionRule = { access: "deny", stepUp: false };

type MatrixRow = Readonly<Record<Role, PermissionRule>>;
export type PermissionMatrix = Readonly<Record<Permission, MatrixRow>>;

function row(
  cells: Readonly<Record<Role, PermissionAccess>>,
  stepUpRoles: readonly Role[] = [],
): MatrixRow {
  const entries = ROLES.map((role) => [role, { access: cells[role], stepUp: stepUpRoles.includes(role) }] as const);
  return Object.fromEntries(entries) as MatrixRow;
}

// Column order throughout matches security-and-tenancy.md §6:
// owner, admin, manager, analyst, viewer.
export const PERMISSION_MATRIX: PermissionMatrix = {
  "workspace:read": row({ owner: "allow", admin: "allow", manager: "allow", analyst: "allow", viewer: "allow" }),
  "workspace:update": row({ owner: "allow", admin: "allow", manager: "deny", analyst: "deny", viewer: "deny" }),
  "workspace:delete": row(
    { owner: "allow", admin: "deny", manager: "deny", analyst: "deny", viewer: "deny" },
    ["owner"],
  ),
  "workspace:transfer_ownership": row(
    { owner: "allow", admin: "deny", manager: "deny", analyst: "deny", viewer: "deny" },
    ["owner"],
  ),
  "member:invite": row({ owner: "allow", admin: "allow", manager: "deny", analyst: "deny", viewer: "deny" }),
  "member:update_role": row({ owner: "allow", admin: "allow", manager: "deny", analyst: "deny", viewer: "deny" }),
  "member:remove": row({ owner: "allow", admin: "allow", manager: "deny", analyst: "deny", viewer: "deny" }),
  "billing:read": row({ owner: "allow", admin: "allow", manager: "deny", analyst: "deny", viewer: "deny" }),
  "billing:write": row({ owner: "allow", admin: "allow", manager: "deny", analyst: "deny", viewer: "deny" }),
  "credits:spend": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "allow", viewer: "deny" }),
  "sso:configure": row(
    { owner: "allow", admin: "allow", manager: "deny", analyst: "deny", viewer: "deny" },
    ["owner", "admin"],
  ),
  "apikey:create": row(
    { owner: "allow", admin: "allow", manager: "deny", analyst: "deny", viewer: "deny" },
    ["owner", "admin"],
  ),
  "project:create": row({ owner: "allow", admin: "allow", manager: "allow", analyst: "deny", viewer: "deny" }),
  "project:read": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "allow", viewer: "scoped" }),
  "project:update": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "deny", viewer: "deny" }),
  "project:delete": row({ owner: "allow", admin: "allow", manager: "deny", analyst: "deny", viewer: "deny" }),
  "prompt:write": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "deny", viewer: "deny" }),
  "tracking:trigger": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "deny", viewer: "deny" }),
  "tracking:read": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "allow", viewer: "scoped" }),
  "lookup:execute": row({ owner: "allow", admin: "allow", manager: "allow", analyst: "allow", viewer: "deny" }),
  "lookup:read_history": row({ owner: "allow", admin: "allow", manager: "allow", analyst: "allow", viewer: "deny" }),
  "aux:trigger": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "deny", viewer: "deny" }),
  "aux:read": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "allow", viewer: "scoped" }),
  "task:create": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "deny", viewer: "deny" }),
  "task:move": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "deny", viewer: "deny" }),
  "task:comment": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "allow", viewer: "deny" }),
  "task:read": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "allow", viewer: "scoped" }),
  "optimizer:use": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "deny", viewer: "deny" }),
  "agency:branding": row({ owner: "allow", admin: "allow", manager: "deny", analyst: "deny", viewer: "deny" }),
  "agency:custom_domain": row(
    { owner: "allow", admin: "allow", manager: "deny", analyst: "deny", viewer: "deny" },
    ["owner", "admin"],
  ),
  "share_token:mint": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "deny", viewer: "deny" }),
  "share_token:revoke": row({ owner: "allow", admin: "allow", manager: "scoped", analyst: "deny", viewer: "deny" }),
  "export:data": row(
    { owner: "allow", admin: "allow", manager: "scoped", analyst: "allow", viewer: "deny" },
    ["owner", "admin"],
  ),
  "audit_log:read": row({ owner: "allow", admin: "allow", manager: "deny", analyst: "deny", viewer: "deny" }),
};

/**
 * Looks up the (role, permission) cell. `role` is typed as `string`, not
 * `Role` — it arrives on the request as the LIVE `workspace_members.role`
 * value (security-and-tenancy.md §7: "the token's role claim is a hint for
 * UI rendering only"), which TypeScript cannot narrow statically, and an
 * unrecognized role fails closed to `deny` rather than throwing. `matrix` is
 * an explicit parameter (defaulting to the production `PERMISSION_MATRIX`)
 * so the function stays pure and callers — including tests proving the
 * spend/purchase separation in the general case — can evaluate it against
 * any matrix shaped the same way, not only the production data.
 */
export function evaluatePermission(
  role: string,
  permission: Permission,
  matrix: PermissionMatrix = PERMISSION_MATRIX,
): PermissionRule {
  const cell = matrix[permission]?.[role as Role];
  return cell ?? DENIED_RULE;
}
