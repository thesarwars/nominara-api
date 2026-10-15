import { z } from "zod";

// STORY-019 — the published shape of contracts/permission-matrix.generated.json.
// A GENERATED artifact (not an endpoint): src/contracts/permission-matrix-artifact.ts
// builds it from PERMISSION_MATRIX, the one table RbacGuard enforces, and
// `contracts:check` fails when the committed file drifts from it.
//
// Ids are open strings here on purpose: the role and permission vocabularies
// are owned by src/tenancy/permission-matrix.ts, and the artifact's job is to
// carry them, not to freeze a second copy of the lists.
//
// `access`: "allow" = held workspace-wide; "scoped" = held only for projects
// in the member's project_scope (a request outside it is refused with the
// distinct out-of-scope code); "deny" = refused with a 403 naming the permission.
export const permissionAccessSchema = z.enum(["allow", "scoped", "deny"]);

export const permissionCellSchema = z
  .object({
    access: permissionAccessSchema,
    // true: the action also needs a strong re-authentication within step_up.window_ms.
    step_up: z.boolean(),
  })
  .strict();

export const permissionMatrixArtifactSchema = z
  .object({
    version: z.literal(1),
    // Ordered most- to least-privileged, as in security-and-tenancy.md §6.
    roles: z.array(z.string()),
    permissions: z.array(z.string()),
    // role -> permission -> cell. Every role carries every permission.
    by_role: z.record(z.string(), z.record(z.string(), permissionCellSchema)),
    // permission -> roles holding it (access "allow" or "scoped"), in role order.
    // This is the "ask an owner or admin" explanation for a disabled control.
    granted_to: z.record(z.string(), z.array(z.string())),
    step_up: z
      .object({
        window_ms: z.number().int().positive(),
        methods: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export type PermissionMatrixArtifact = z.infer<typeof permissionMatrixArtifactSchema>;
