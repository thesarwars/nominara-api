import "reflect-metadata";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { permissionMatrixArtifactSchema } from "../../contracts/identity/permission-matrix-artifact.schema.js";
import { RbacGuard, type RbacScopedRequest } from "../../src/api/guards/rbac.guard.js";
import { RequirePermission } from "../../src/api/decorators/require-permission.decorator.js";
import {
  buildPermissionMatrixArtifact,
  checkPermissionMatrixDrift,
  renderPermissionMatrixArtifact,
  PERMISSION_MATRIX_ARTIFACT_PATH,
} from "../../src/contracts/permission-matrix-artifact.js";
import { ACCEPTABLE_STEP_UP_METHODS, STEP_UP_WINDOW_MS } from "../../src/tenancy/constants.js";
import { PermissionDeniedException, ProjectOutOfScopeException, StepUpRequiredException } from "../../src/tenancy/errors.js";
import {
  PERMISSION_MATRIX,
  PERMISSIONS,
  ROLES,
  type Permission,
  type PermissionMatrix,
} from "../../src/tenancy/permission-matrix.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-019 (open AC: the interface reads the matrix) — the matrix is
// published as a GENERATED CONTRACT ARTIFACT, contracts/permission-matrix.generated.json.
// The decisive test is "equals what the guard enforces": the observed
// outcome is driven through the REAL RbacGuard for every role x permission
// pair, never read back from the table the artifact was built from.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const CHECK_SCRIPT = resolve(REPO_ROOT, "src/contracts/check.ts");
const OPENAPI_PATH = resolve(REPO_ROOT, "contracts/openapi.generated.json");

type Observed = { access: "allow" | "scoped" | "deny"; step_up: boolean };

function ctxFor(permission: Permission, req: RbacScopedRequest): ExecutionContext {
  class Probe {
    handler(): void {}
  }
  RequirePermission(permission)(Probe);
  return {
    getHandler: () => Probe.prototype.handler,
    getClass: () => Probe,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

function outcome(guard: RbacGuard, role: string, permission: Permission, over: Partial<RbacScopedRequest>) {
  const req: RbacScopedRequest = {
    membership: { role, projectScope: null },
    session: { lastStrongAuthAt: new Date() },
    ...over,
  } as RbacScopedRequest;
  try {
    guard.canActivate(ctxFor(permission, req));
    return "pass" as const;
  } catch (error) {
    if (error instanceof PermissionDeniedException) return "denied" as const;
    if (error instanceof ProjectOutOfScopeException) return "out_of_scope" as const;
    if (error instanceof StepUpRequiredException) return "step_up" as const;
    throw error;
  }
}

// What the guard ACTUALLY does for (role, permission), by probing it.
function observe(guard: RbacGuard, role: string, permission: Permission): Observed {
  const unrestricted = outcome(guard, role, permission, {});
  if (unrestricted === "denied") return { access: "deny", step_up: false };
  const zeroProjects = outcome(guard, role, permission, {
    membership: { role, projectScope: [] },
  } as Partial<RbacScopedRequest>);
  const stale = outcome(guard, role, permission, {
    session: { lastStrongAuthAt: null },
  } as Partial<RbacScopedRequest>);
  return {
    access: zeroProjects === "out_of_scope" ? "scoped" : "allow",
    step_up: stale === "step_up",
  };
}

describe("STORY-019 · permission matrix contract artifact", () => {
  const guard = new RbacGuard(new Reflector());
  const artifact = buildPermissionMatrixArtifact();

  it("REQ-019-10 · for every role x permission pair the artifact equals what RbacGuard enforces", () => {
    const mismatches: string[] = [];
    for (const role of ROLES) {
      for (const permission of PERMISSIONS) {
        const published = artifact.by_role[role]![permission]!;
        const enforced = observe(guard, role, permission);
        if (published.access !== enforced.access || published.step_up !== enforced.step_up) {
          mismatches.push(`${role} ${permission}: published ${JSON.stringify(published)} vs enforced ${JSON.stringify(enforced)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(ROLES.length * PERMISSIONS.length).toBeGreaterThan(100); // not vacuous
  });

  it("REQ-019-10 · the probe sees a change: a guard-visible difference is not invisible to the comparison", () => {
    // Guards the guard-driven test above against vacuity: a matrix that
    // differs in ONE cell yields an artifact the enforced behaviour refutes.
    const flipped = buildPermissionMatrixArtifact(mutate(PERMISSION_MATRIX, "workspace:update", "viewer", { access: "allow", stepUp: false }));
    const published = flipped.by_role.viewer!["workspace:update"]!;
    expect(published).not.toEqual(observe(guard, "viewer", "workspace:update"));
  });

  it("REQ-019-10 · every role and every permission is present exactly once, and the shape parses against its zod contract", () => {
    expect(permissionMatrixArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(Object.keys(artifact.by_role)).toEqual([...ROLES]);
    for (const role of ROLES) expect(Object.keys(artifact.by_role[role]!)).toEqual([...PERMISSIONS]);
    expect(Object.keys(artifact.granted_to)).toEqual([...PERMISSIONS]);
  });

  it("REQ-019-10 · granted_to lists exactly the roles whose cell is allow or scoped, in role order", () => {
    expect(artifact.granted_to["billing:write"]).toEqual(["owner", "admin"]);
    expect(artifact.granted_to["credits:spend"]).toEqual(["owner", "admin", "manager", "analyst"]);
    expect(artifact.granted_to["workspace:delete"]).toEqual(["owner"]);
    for (const permission of PERMISSIONS) {
      const expected = ROLES.filter((role) => artifact.by_role[role]![permission]!.access !== "deny");
      expect(artifact.granted_to[permission]).toEqual(expected);
    }
  });

  it("REQ-019-10 · project-scoped cells are published as scoped, not flattened to allow", () => {
    expect(artifact.by_role.manager!["project:update"]!.access).toBe("scoped");
    expect(artifact.by_role.viewer!["project:read"]!.access).toBe("scoped");
    expect(artifact.by_role.analyst!["project:read"]!.access).toBe("allow");
  });

  it("REQ-019-10 · the step-up window and acceptable methods come from the constants the guard uses", () => {
    expect(artifact.step_up).toEqual({ window_ms: STEP_UP_WINDOW_MS, methods: [...ACCEPTABLE_STEP_UP_METHODS] });
  });

  it("REQ-019-10 · output is deterministic: two builds render byte-identical text ending in a newline", () => {
    const a = renderPermissionMatrixArtifact(buildPermissionMatrixArtifact());
    const b = renderPermissionMatrixArtifact(buildPermissionMatrixArtifact());
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
  });

  it("REQ-019-10 · the committed artifact is current (no drift against the code)", () => {
    expect(checkPermissionMatrixDrift(PERMISSION_MATRIX_ARTIFACT_PATH).clean).toBe(true);
  });

  it("REQ-019-10 · drift: changing ONE role's permission in code without regenerating is detected", () => {
    const changed = mutate(PERMISSION_MATRIX, "billing:write", "analyst", { access: "allow", stepUp: false });
    expect(checkPermissionMatrixDrift(PERMISSION_MATRIX_ARTIFACT_PATH, changed).clean).toBe(false);
  });

  it("REQ-019-10 · drift: flipping only a step-up flag is detected", () => {
    const changed = mutate(PERMISSION_MATRIX, "workspace:delete", "owner", { access: "allow", stepUp: false });
    expect(checkPermissionMatrixDrift(PERMISSION_MATRIX_ARTIFACT_PATH, changed).clean).toBe(false);
  });

  it("REQ-019-10 · drift: a hand-edited committed file is detected", () => {
    const dir = mkdtempSync(resolve(REPO_ROOT, "node_modules/.tmp-story019-"));
    try {
      const doc = JSON.parse(readFileSync(PERMISSION_MATRIX_ARTIFACT_PATH, "utf8"));
      doc.by_role.viewer["billing:write"].access = "allow";
      const path = resolve(dir, "m.json");
      writeFileSync(path, JSON.stringify(doc, null, 2));
      expect(checkPermissionMatrixDrift(path).clean).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("STORY-019 · contracts:check CLI fails on matrix drift (no warning mode)", () => {
  const originalEnv = { ...process.env };
  let tempDir: string | undefined;
  beforeEach(() => applyFakeApiEnv());
  afterEach(() => {
    process.env = { ...originalEnv };
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  function run(matrixPath: string) {
    const r = spawnSync(TSX_BIN, [CHECK_SCRIPT, OPENAPI_PATH, matrixPath], { cwd: REPO_ROOT, encoding: "utf8" });
    return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("REQ-019-10 · exits 0 against the committed artifact and non-zero against a drifted copy", () => {
    const clean = run(PERMISSION_MATRIX_ARTIFACT_PATH);
    expect(clean.status, clean.output).toBe(0);

    const doc = JSON.parse(readFileSync(PERMISSION_MATRIX_ARTIFACT_PATH, "utf8"));
    doc.by_role.analyst["billing:write"].access = "allow";
    tempDir = mkdtempSync(resolve(REPO_ROOT, "node_modules/.tmp-story019-cli-"));
    const path = resolve(tempDir, "m.json");
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const drifted = run(path);
    expect(drifted.status, drifted.output).not.toBe(0);
    expect(drifted.output).toContain("permission matrix");
  }, 60_000);
});

function mutate(
  matrix: PermissionMatrix,
  permission: Permission,
  role: (typeof ROLES)[number],
  cell: { access: "allow" | "scoped" | "deny"; stepUp: boolean },
): PermissionMatrix {
  return { ...matrix, [permission]: { ...matrix[permission], [role]: cell } };
}
