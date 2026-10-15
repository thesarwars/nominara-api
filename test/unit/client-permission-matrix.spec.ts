import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateClient, generateOpenApiDocument } from "../../src/contracts/generate.js";
import { buildPermissionMatrixArtifact } from "../../src/contracts/permission-matrix-artifact.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-019 — the app drives its disabled-with-reason states from the
// permission matrix and consumes the API only through @nominara/client, so the
// generated package must carry the matrix. Generated into a temp dir so this
// checks the GENERATOR, and compared against BOTH the committed artifact and the
// live builder: a stale or altered emission fails against either.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
let outDir: string;
let source: string;

beforeAll(async () => {
  applyFakeApiEnv();
  outDir = mkdtempSync(join(tmpdir(), "nominara-client-matrix-"));
  await generateClient(await generateOpenApiDocument(), outDir);
  source = readFileSync(join(outDir, "permission-matrix.ts"), "utf8");
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

function emittedConstant(): unknown {
  const match = /export const PERMISSION_MATRIX = (\{[\s\S]*?\n\}) as const;/.exec(source);
  expect(match, "PERMISSION_MATRIX constant not found").not.toBeNull();
  return JSON.parse(match![1]!);
}

describe("STORY-019 · the published client carries the permission matrix", () => {
  it("emits PERMISSION_MATRIX deep-equal to contracts/permission-matrix.generated.json", () => {
    const committed = JSON.parse(readFileSync(resolve(REPO_ROOT, "contracts/permission-matrix.generated.json"), "utf8"));
    expect(emittedConstant()).toEqual(committed);
  });

  it("emits PERMISSION_MATRIX deep-equal to the live builder output", () => {
    expect(emittedConstant()).toEqual(buildPermissionMatrixArtifact());
  });

  it("exports the types Role, Permission and PermissionAccess", () => {
    expect(source).toMatch(/export type Role = /);
    expect(source).toMatch(/export type Permission = /);
    expect(source).toMatch(/export type PermissionAccess = /);
  });

  it("exports the matrix and its types from the package index", () => {
    const index = readFileSync(join(outDir, "index.ts"), "utf8");
    expect(index).toContain("./permission-matrix.js");
    expect(index).toMatch(/PERMISSION_MATRIX/);
    for (const t of ["Role", "Permission", "PermissionAccess"]) expect(index).toContain(t);
  });

  it("keeps the order of roles and permissions (most- to least-privileged)", () => {
    const emitted = emittedConstant() as { roles: string[]; permissions: string[] };
    const live = buildPermissionMatrixArtifact();
    expect(emitted.roles).toEqual(live.roles);
    expect(emitted.permissions).toEqual(live.permissions);
  });
});
