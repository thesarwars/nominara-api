import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { RbacGuard, type RbacScopedRequest } from "../../../src/api/guards/rbac.guard.js";
import { REQUIRE_PERMISSION_KEY } from "../../../src/api/decorators/require-permission.decorator.js";
import { REQUIRE_STEP_UP_KEY } from "../../../src/api/decorators/require-step-up.decorator.js";
import { PERMISSION_MATRIX, PERMISSIONS, ROLES, type Permission, type Role } from "../../../src/tenancy/permission-matrix.js";
import { STEP_UP_WINDOW_MS } from "../../../src/tenancy/constants.js";
import { discoverRealRoutes, type DiscoveredRoute } from "../../support/discover-contract-routes.js";
import { applyFakeApiEnv } from "../../support/fake-env.js";

// STORY-110 abuse suite, step-up (scenario 20): every documented irreversible action is attempted WITHOUT step-up, and
// with a stale one, and is refused. The list below is security-and-tenancy.md section 5/6's permission table, written out
// by hand so the matrix cannot drift away from it unnoticed (a derived list would agree with whatever the code says).
const DOCUMENTED_STEP_UP: Readonly<Record<string, readonly Role[]>> = {
  "workspace:delete": ["owner"],
  "workspace:transfer_ownership": ["owner"],
  "sso:configure": ["owner", "admin"],
  "apikey:create": ["owner", "admin"],
  "agency:custom_domain": ["owner", "admin"],
  "export:data": ["owner", "admin"],
};

const NOW = Date.now();
const guard = new RbacGuard(new Reflector());

function attempt(handlerHost: { handler: () => void }, ctor: new () => object, role: Role, lastStrongAuthAt: Date | null) {
  const req = {
    membership: { role, projectScope: null },
    session: { lastStrongAuthAt, lastStrongAuthMethod: lastStrongAuthAt === null ? null : "webauthn" },
    params: {},
  } as unknown as RbacScopedRequest;
  const context = {
    getHandler: () => handlerHost.handler,
    getClass: () => ctor,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
  return () => guard.canActivate(context);
}

function hostFor(permission: Permission): { host: { handler: () => void }; ctor: new () => object } {
  class Host {
    handler(): void {}
  }
  Reflect.defineMetadata(REQUIRE_PERMISSION_KEY, permission, Host.prototype.handler);
  return { host: new Host(), ctor: Host };
}

describe("STORY-110 · scenario 20 — the matrix marks exactly the documented actions for step-up", () => {
  it("the permissions that carry step-up for any role are exactly the documented ones, for exactly the documented roles", () => {
    const actual: Record<string, Role[]> = {};
    for (const permission of PERMISSIONS) {
      const roles = ROLES.filter((r) => PERMISSION_MATRIX[permission][r].stepUp);
      if (roles.length > 0) actual[permission] = [...roles];
    }
    expect(actual).toEqual(DOCUMENTED_STEP_UP);
  });
});

describe("STORY-110 · scenario 20 — each irreversible action, attempted without step-up", () => {
  const cases = Object.entries(DOCUMENTED_STEP_UP).flatMap(([permission, roles]) => roles.map((role) => [permission as Permission, role] as const));

  it.each(cases)("%s as %s with NO strong authentication is refused step_up_required", (permission, role) => {
    const { host, ctor } = hostFor(permission);
    expect(attempt(host, ctor, role, null)).toThrowError(expect.objectContaining({ response: expect.objectContaining({ code: "step_up_required" }) }));
  });

  it.each(cases)("%s as %s with a step-up past the window is refused", (permission, role) => {
    const { host, ctor } = hostFor(permission);
    const stale = new Date(Date.now() - STEP_UP_WINDOW_MS - 1_000);
    expect(attempt(host, ctor, role, stale)).toThrowError(expect.objectContaining({ response: expect.objectContaining({ code: "step_up_required" }) }));
  });

  it.each(cases)("%s as %s with a fresh step-up is allowed (the refusal above is the step-up, not a blanket deny)", (permission, role) => {
    const { host, ctor } = hostFor(permission);
    expect(attempt(host, ctor, role, new Date(NOW))()).toBe(true);
  });

  it("a role the matrix denies is refused as a permission denial BEFORE step-up is asked about (no oracle either way)", () => {
    const { host, ctor } = hostFor("workspace:delete");
    expect(attempt(host, ctor, "admin", null)).toThrowError(expect.objectContaining({ response: expect.objectContaining({ code: "forbidden" }) }));
  });
});

describe("STORY-110 · scenario 20 — every registered route behind a step-up permission goes through RbacGuard's check", () => {
  let routes: DiscoveredRoute[] = [];
  beforeAll(async () => {
    applyFakeApiEnv();
    routes = await discoverRealRoutes();
  }, 60_000);

  it("each registered route that declares a step-up permission refuses a stale session for that permission's role", () => {
    const gated = routes.filter((r) => Reflect.getMetadata(REQUIRE_PERMISSION_KEY, r.handler) !== undefined && (Reflect.getMetadata(REQUIRE_PERMISSION_KEY, r.handler) as string) in DOCUMENTED_STEP_UP);
    // Not vacuous. A route exists for these four (DELETE /workspaces/{id} since the workspace-deletion story); sso:configure and
    // agency:custom_domain have no route yet, so the matrix describe above is what guards them until one is added (that route
    // lands inside this loop, and the assertion below turns into a failure the day it appears without being listed).
    const permissionsWithARoute = new Set(gated.map((r) => Reflect.getMetadata(REQUIRE_PERMISSION_KEY, r.handler) as string));
    for (const expected of ["workspace:delete", "workspace:transfer_ownership", "apikey:create", "export:data"]) expect(permissionsWithARoute.has(expected), expected).toBe(true);
    for (const unrouted of ["sso:configure", "agency:custom_domain"]) expect(permissionsWithARoute.has(unrouted), `${unrouted} now has a route: add it to the expected list above`).toBe(false);
    for (const route of gated) {
      const permission = Reflect.getMetadata(REQUIRE_PERMISSION_KEY, route.handler) as Permission;
      const role = DOCUMENTED_STEP_UP[permission]![0]!;
      const ctor = route.controllerClass as unknown as new () => object;
      const call = attempt({ handler: route.handler as () => void }, ctor, role, null);
      expect(call, `${route.fullPath} (${permission})`).toThrowError(expect.objectContaining({ response: expect.objectContaining({ code: "step_up_required" }) }));
    }
  });
});

// STORY-110 AC17 - the documented list in security-and-tenancy.md section 5 is wider than the permission matrix: some of its
// actions carry the step-up on the ROUTE (`@RequireStepUp()`, owner decision 100(j)) or inside the service. Each is swept
// here by operationId, so a route that loses its step-up, or a new route under a documented action, is caught.
const PROSE_ACTIONS: Readonly<Record<string, { readonly enforcedBy: "route" | "service"; readonly proof?: string; readonly role: Role }>> = {
  requestRetentionExport: { enforcedBy: "route", role: "owner" },
  startGscOauth: { enforcedBy: "service", proof: "test/integration/gsc-search-console.spec.ts", role: "owner" },
  createAttributionConfig: { enforcedBy: "service", proof: "test/integration/attribution-config-and-beacon.spec.ts", role: "owner" },
  disconnectAttributionConfig: { enforcedBy: "service", proof: "test/integration/attribution-config-and-beacon.spec.ts", role: "owner" },
  acceptOwnershipTransfer: { enforcedBy: "service", proof: "test/integration/ownership-transfer.spec.ts", role: "owner" },
  createPasskeyRegistrationOptions: { enforcedBy: "service", proof: "test/integration/identity-passkey-registration-proves-email.spec.ts", role: "owner" },
  verifyPasskeyRegistration: { enforcedBy: "service", proof: "test/integration/identity-passkey-registration-proves-email.spec.ts", role: "owner" },
  revokeOtherSessions: { enforcedBy: "service", proof: "test/integration/identity-session-list-and-revoke.spec.ts", role: "owner" },
  revokeSession: { enforcedBy: "service", proof: "test/integration/identity-session-list-and-revoke.spec.ts", role: "owner" },
};

describe("STORY-110 AC17 - the prose-documented irreversible actions that have a route", () => {
  let routes: DiscoveredRoute[] = [];
  beforeAll(async () => {
    applyFakeApiEnv();
    routes = await discoverRealRoutes();
  }, 60_000);

  it("every listed operation is a registered route (a rename or removal cannot silently drop it from the sweep)", () => {
    const registered = new Set(routes.map((r) => r.contract?.operationId));
    for (const operationId of Object.keys(PROSE_ACTIONS)) expect(registered.has(operationId), operationId).toBe(true);
  });

  it("a route-level step-up (@RequireStepUp) refuses a session with no strong authentication, and a stale one", () => {
    const routeLevel = routes.filter((r) => Reflect.getMetadata(REQUIRE_STEP_UP_KEY, r.handler) === true);
    // The set of routes carrying the decorator is exactly the listed route-enforced ones: a new @RequireStepUp route must be listed.
    expect(routeLevel.map((r) => r.contract?.operationId).sort()).toEqual(
      Object.entries(PROSE_ACTIONS).filter(([, v]) => v.enforcedBy === "route").map(([id]) => id).sort(),
    );
    for (const route of routeLevel) {
      const role = PROSE_ACTIONS[route.contract!.operationId!]!.role;
      const ctor = route.controllerClass as unknown as new () => object;
      const stale = new Date(Date.now() - STEP_UP_WINDOW_MS - 1_000);
      for (const at of [null, stale]) {
        expect(attempt({ handler: route.handler as () => void }, ctor, role, at), route.fullPath).toThrowError(
          expect.objectContaining({ response: expect.objectContaining({ code: "step_up_required" }) }),
        );
      }
      expect(attempt({ handler: route.handler as () => void }, ctor, role, new Date(NOW))(), `${route.fullPath} with a fresh step-up`).toBe(true);
    }
  });

  it("a service-enforced step-up names the integration spec that attempts it without one, and that spec still asserts step_up_required", () => {
    for (const [operationId, entry] of Object.entries(PROSE_ACTIONS)) {
      if (entry.enforcedBy !== "service") continue;
      const path = new URL(`../../../${entry.proof!}`, import.meta.url);
      expect(existsSync(path), `${operationId}: ${entry.proof!} is missing`).toBe(true);
      expect(readFileSync(path, "utf8"), `${operationId}: ${entry.proof!} no longer asserts step_up_required`).toContain("step_up_required");
    }
  });
});
