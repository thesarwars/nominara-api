import { describe, expect, it } from "vitest";
import { evaluatePermission, ROLES, type Permission, type PermissionAccess, type PermissionMatrix, type Role } from "./permission-matrix.js";

// STORY-019 · REQ-019-1 — this table is transcribed directly from
// security-and-tenancy.md §6, independently of src/tenancy/permission-
// matrix.ts's own data, so this test proves the implementation matches the
// spec rather than matching itself. Column order: owner, admin, manager,
// analyst, viewer.
const SPEC_TABLE: ReadonlyArray<{
  permission: Permission;
  cells: readonly [PermissionAccess, PermissionAccess, PermissionAccess, PermissionAccess, PermissionAccess];
  stepUpRoles?: readonly Role[];
}> = [
  { permission: "workspace:read", cells: ["allow", "allow", "allow", "allow", "allow"] },
  { permission: "workspace:update", cells: ["allow", "allow", "deny", "deny", "deny"] },
  { permission: "workspace:delete", cells: ["allow", "deny", "deny", "deny", "deny"], stepUpRoles: ["owner"] },
  {
    permission: "workspace:transfer_ownership",
    cells: ["allow", "deny", "deny", "deny", "deny"],
    stepUpRoles: ["owner"],
  },
  { permission: "member:invite", cells: ["allow", "allow", "deny", "deny", "deny"] },
  { permission: "member:update_role", cells: ["allow", "allow", "deny", "deny", "deny"] },
  { permission: "member:remove", cells: ["allow", "allow", "deny", "deny", "deny"] },
  { permission: "billing:read", cells: ["allow", "allow", "deny", "deny", "deny"] },
  { permission: "billing:write", cells: ["allow", "allow", "deny", "deny", "deny"] },
  { permission: "credits:spend", cells: ["allow", "allow", "scoped", "allow", "deny"] },
  { permission: "sso:configure", cells: ["allow", "allow", "deny", "deny", "deny"], stepUpRoles: ["owner", "admin"] },
  { permission: "apikey:create", cells: ["allow", "allow", "deny", "deny", "deny"], stepUpRoles: ["owner", "admin"] },
  { permission: "project:create", cells: ["allow", "allow", "allow", "deny", "deny"] },
  { permission: "project:read", cells: ["allow", "allow", "scoped", "allow", "scoped"] },
  { permission: "project:update", cells: ["allow", "allow", "scoped", "deny", "deny"] },
  { permission: "project:delete", cells: ["allow", "allow", "deny", "deny", "deny"] },
  { permission: "prompt:write", cells: ["allow", "allow", "scoped", "deny", "deny"] },
  { permission: "tracking:trigger", cells: ["allow", "allow", "scoped", "deny", "deny"] },
  { permission: "tracking:read", cells: ["allow", "allow", "scoped", "allow", "scoped"] },
  { permission: "lookup:execute", cells: ["allow", "allow", "allow", "allow", "deny"] },
  { permission: "lookup:read_history", cells: ["allow", "allow", "allow", "allow", "deny"] },
  { permission: "aux:trigger", cells: ["allow", "allow", "scoped", "deny", "deny"] },
  { permission: "aux:read", cells: ["allow", "allow", "scoped", "allow", "scoped"] },
  { permission: "task:create", cells: ["allow", "allow", "scoped", "deny", "deny"] },
  { permission: "task:move", cells: ["allow", "allow", "scoped", "deny", "deny"] },
  { permission: "task:comment", cells: ["allow", "allow", "scoped", "allow", "deny"] },
  { permission: "task:read", cells: ["allow", "allow", "scoped", "allow", "scoped"] },
  { permission: "optimizer:use", cells: ["allow", "allow", "scoped", "deny", "deny"] },
  { permission: "agency:branding", cells: ["allow", "allow", "deny", "deny", "deny"] },
  {
    permission: "agency:custom_domain",
    cells: ["allow", "allow", "deny", "deny", "deny"],
    stepUpRoles: ["owner", "admin"],
  },
  { permission: "share_token:mint", cells: ["allow", "allow", "scoped", "deny", "deny"] },
  { permission: "share_token:revoke", cells: ["allow", "allow", "scoped", "deny", "deny"] },
  // export:data's step-up flag is owner/admin only — the manager (scoped)
  // and analyst (CSV only, still plain "allow") rows are NOT step-up.
  { permission: "export:data", cells: ["allow", "allow", "scoped", "allow", "deny"], stepUpRoles: ["owner", "admin"] },
  { permission: "audit_log:read", cells: ["allow", "allow", "deny", "deny", "deny"] },
];

describe("STORY-019 · permission matrix", () => {
  it("REQ-019-1 · each role against each permission matches the spec table exactly", () => {
    for (const { permission, cells, stepUpRoles = [] } of SPEC_TABLE) {
      ROLES.forEach((role, index) => {
        const expectedAccess = cells[index];
        const rule = evaluatePermission(role, permission);
        expect(rule.access, `${permission} / ${role} access`).toBe(expectedAccess);
        expect(rule.stepUp, `${permission} / ${role} stepUp`).toBe(stepUpRoles.includes(role));
      });
    }
  });

  it("REQ-019-1 · covers every permission exactly once, including task:create/task:move as two distinct keys", () => {
    // The spec table's "task:create / task:move" row is one row of prose
    // but two identical-access permission keys — 33 table rows, 34
    // permission keys.
    expect(SPEC_TABLE).toHaveLength(34);
    expect(new Set(SPEC_TABLE.map((entry) => entry.permission)).size).toBe(34);
  });

  it("REQ-019-8 · a spend-capable role (analyst) attempting a purchase (billing:write) is refused", () => {
    expect(evaluatePermission("analyst", "credits:spend").access).not.toBe("deny");
    expect(evaluatePermission("analyst", "billing:write").access).toBe("deny");
  });

  it("coupling regression lock · evaluatePermission never conflates the billing:write and credits:spend cells", () => {
    // NOT evidence for AC 8's "a finance-focused role may buy without
    // spending" clause — see STORY-019-E-4. With §6's fixed five roles,
    // every purchase-capable role (owner, admin) is also spend-capable, so
    // that clause has no real-matrix example to assert against; a
    // purchase-only role does not exist in this story. What this test DOES
    // pin: evaluatePermission treats billing:write and credits:spend as
    // unrelated keys, never coupled by the evaluator itself — a role
    // granted one is refused the other unless its OWN cell says otherwise.
    // A regression that hardcoded "billing:write implies credits:spend" (or
    // vice versa) into the evaluator would fail this, on a hypothetical
    // matrix built for exactly that purpose below.
    const financeOnlyMatrix = {
      "billing:write": {
        owner: { access: "deny", stepUp: false },
        admin: { access: "deny", stepUp: false },
        manager: { access: "deny", stepUp: false },
        analyst: { access: "deny", stepUp: false },
        viewer: { access: "allow", stepUp: false },
      },
      "credits:spend": {
        owner: { access: "deny", stepUp: false },
        admin: { access: "deny", stepUp: false },
        manager: { access: "deny", stepUp: false },
        analyst: { access: "deny", stepUp: false },
        viewer: { access: "deny", stepUp: false },
      },
    } as unknown as PermissionMatrix;

    // "viewer" here stands in for the hypothetical finance-focused role:
    // purchase-capable (billing:write allow) but not spend-capable.
    expect(evaluatePermission("viewer", "billing:write", financeOnlyMatrix).access).toBe("allow");
    expect(evaluatePermission("viewer", "credits:spend", financeOnlyMatrix).access).toBe("deny");
  });

  it("falls back to deny for a role the matrix does not recognize, rather than throwing", () => {
    expect(evaluatePermission("not-a-real-role", "workspace:read")).toEqual({ access: "deny", stepUp: false });
  });
});
