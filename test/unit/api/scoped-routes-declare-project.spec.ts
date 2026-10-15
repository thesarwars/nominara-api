import "reflect-metadata";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PROJECT_PARAM_KEY } from "../../../src/api/decorators/project-param.decorator.js";
import { IS_PUBLIC_KEY } from "../../../src/api/decorators/public.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../../src/api/decorators/require-permission.decorator.js";
import { SCOPED_BY_QUERY_KEY } from "../../../src/api/decorators/scoped-by-query.decorator.js";
import { PERMISSION_MATRIX, ROLES, type Permission } from "../../../src/tenancy/permission-matrix.js";

// STORY-019 review (MAJOR) — `RbacGuard.assertInScope` refuses a "scoped"
// permission with `project_out_of_scope` when the route names no project
// (`@ProjectParam`) and does not narrow by query (`@ScopedByQuery`). That
// fails closed, but it also locks a scoped member out of a project they ARE
// assigned to, and makes "scoped" in the published permission matrix a
// promise the server breaks. So: every route whose permission any role holds
// as "scoped" must say where the project comes from. No allow-list: a route
// that genuinely has no project must not require a scoped permission.

const NEST_PATH_METADATA_KEY = "path";
const NEST_METHOD_METADATA_KEY = "method";
const METHOD_NAMES: Record<number, string> = { 0: "GET", 1: "POST", 2: "PUT", 3: "DELETE", 4: "PATCH" };

interface Route {
  readonly label: string;
  readonly permission: Permission | undefined;
  readonly isPublic: boolean;
  readonly hasProjectParam: boolean;
  readonly hasScopedByQuery: boolean;
}

async function walk(): Promise<Route[]> {
  const modulesDir = fileURLToPath(new URL("../../../src/modules", import.meta.url));
  const files = (readdirSync(modulesDir, { recursive: true }) as string[])
    .filter((entry) => entry.endsWith(".controller.ts"))
    .sort();
  const routes: Route[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(resolve(modulesDir, file)).href)) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== "function" || Reflect.getMetadata(NEST_PATH_METADATA_KEY, exported) === undefined) continue;
      const proto = exported.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === "constructor" || typeof handler !== "function") continue;
        const path = Reflect.getMetadata(NEST_PATH_METADATA_KEY, handler) as string | string[] | undefined;
        if (path === undefined) continue;
        const verb = METHOD_NAMES[(Reflect.getMetadata(NEST_METHOD_METADATA_KEY, handler) as number | undefined) ?? 0];
        const classPath = (Reflect.getMetadata(NEST_PATH_METADATA_KEY, exported) as string | undefined) ?? "";
        const read = <T>(key: string): T | undefined =>
          (Reflect.getMetadata(key, handler) as T | undefined) ?? (Reflect.getMetadata(key, exported) as T | undefined);
        routes.push({
          label: `${verb} /${[classPath, Array.isArray(path) ? path[0] : path].filter(Boolean).join("/").replace(/\/+/g, "/")} (${exported.name}.${name})`,
          permission: read<Permission>(REQUIRE_PERMISSION_KEY),
          isPublic: read<boolean>(IS_PUBLIC_KEY) === true,
          hasProjectParam: read<string>(PROJECT_PARAM_KEY) !== undefined,
          // Handler only — the guard reads this key from the handler alone.
          hasScopedByQuery: (Reflect.getMetadata(SCOPED_BY_QUERY_KEY, handler) as boolean | undefined) === true,
        });
      }
    }
  }
  return routes;
}

const heldAsScoped = (permission: Permission): boolean =>
  ROLES.some((role) => PERMISSION_MATRIX[permission][role].access === "scoped");

describe("STORY-019 · REQ-019-scope-declared · a scoped permission names its project", () => {
  it("every @RequirePermission route a role holds as 'scoped' declares @ProjectParam or @ScopedByQuery", async () => {
    const violations = (await walk())
      .filter((r) => !r.isPublic && r.permission !== undefined && heldAsScoped(r.permission))
      .filter((r) => !r.hasProjectParam && !r.hasScopedByQuery)
      .map((r) => `${r.label} requires ${r.permission}`);

    expect(violations, "RbacGuard refuses these for ANY restricted scope (project_out_of_scope)").toEqual([]);
  });

  it("walks routes at all - a sweep over nothing passes vacuously", async () => {
    const routes = (await walk()).filter((r) => r.permission !== undefined && heldAsScoped(r.permission));
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.some((r) => r.hasProjectParam)).toBe(true);
    expect(routes.some((r) => r.hasScopedByQuery)).toBe(true);
  });
});
