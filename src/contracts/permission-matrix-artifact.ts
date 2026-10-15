import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  permissionMatrixArtifactSchema,
  type PermissionMatrixArtifact,
} from "../../contracts/identity/permission-matrix-artifact.schema.js";
import { ACCEPTABLE_STEP_UP_METHODS, STEP_UP_WINDOW_MS } from "../tenancy/constants.js";
import { PERMISSION_MATRIX, PERMISSIONS, ROLES, type PermissionMatrix } from "../tenancy/permission-matrix.js";

// STORY-019 — publishes the permission matrix to the interface as a
// GENERATED CONTRACT ARTIFACT (owner decision 2026-10-14: an artifact, not an
// endpoint). The source is PERMISSION_MATRIX, the very table RbacGuard
// evaluates — nothing here restates a permission. `contracts:generate` writes
// the file; `contracts:check` fails when the committed copy no longer matches
// what the code would generate. Deterministic: role and permission order are
// the declaration order of ROLES / PERMISSIONS, never object-key luck.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const PERMISSION_MATRIX_ARTIFACT_PATH = resolve(REPO_ROOT, "contracts/permission-matrix.generated.json");

export function buildPermissionMatrixArtifact(matrix: PermissionMatrix = PERMISSION_MATRIX): PermissionMatrixArtifact {
  const by_role: PermissionMatrixArtifact["by_role"] = {};
  for (const role of ROLES) {
    by_role[role] = Object.fromEntries(
      PERMISSIONS.map((permission) => {
        const cell = matrix[permission][role];
        return [permission, { access: cell.access, step_up: cell.stepUp }] as const;
      }),
    );
  }

  const granted_to: PermissionMatrixArtifact["granted_to"] = {};
  for (const permission of PERMISSIONS) {
    granted_to[permission] = ROLES.filter((role) => matrix[permission][role].access !== "deny");
  }

  return permissionMatrixArtifactSchema.parse({
    version: 1,
    roles: [...ROLES],
    permissions: [...PERMISSIONS],
    by_role,
    granted_to,
    step_up: { window_ms: STEP_UP_WINDOW_MS, methods: [...ACCEPTABLE_STEP_UP_METHODS] },
  });
}

export function renderPermissionMatrixArtifact(artifact: PermissionMatrixArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

export function writePermissionMatrixArtifact(path: string = PERMISSION_MATRIX_ARTIFACT_PATH): void {
  writeFileSync(path, renderPermissionMatrixArtifact(buildPermissionMatrixArtifact()), "utf8");
}

export interface PermissionMatrixDriftResult {
  readonly clean: boolean;
  readonly artifactPath: string;
}

// Byte comparison: the file is fully generated and key order is part of the
// deterministic output, so a hand edit of any kind (or a reorder) is drift.
export function checkPermissionMatrixDrift(
  artifactPath: string,
  matrix: PermissionMatrix = PERMISSION_MATRIX,
): PermissionMatrixDriftResult {
  const committed = readFileSync(artifactPath, "utf8");
  const generated = renderPermissionMatrixArtifact(buildPermissionMatrixArtifact(matrix));
  return { clean: committed === generated, artifactPath };
}
