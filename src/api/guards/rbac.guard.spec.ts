import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { NotFoundException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectParam } from "../decorators/project-param.decorator.js";
import { RequirePermission } from "../decorators/require-permission.decorator.js";
import { PermissionDeniedException, ProjectOutOfScopeException, StepUpRequiredException } from "../../tenancy/errors.js";
import { RbacGuard, type RbacScopedRequest } from "./rbac.guard.js";

// STORY-019 — dangerous area (tenant-authorization path): RbacGuard is the
// third link in the fixed enforcement chain (security-and-tenancy.md §5),
// evaluated against req.membership.role — the LIVE role WorkspaceGuard
// re-verified this request — never req.auth.role (§7: "a hint for UI
// rendering only", which is why these fixtures never set req.auth at all).

class ProjectReadController {
  @RequirePermission("project:read")
  @ProjectParam("projectId")
  handler(): void {}
}

class WorkspaceUpdateController {
  @RequirePermission("workspace:update")
  handler(): void {}
}

class WorkspaceDeleteController {
  @RequirePermission("workspace:delete")
  handler(): void {}
}

class LookupExecuteController {
  @RequirePermission("lookup:execute")
  handler(): void {}
}

class NoPermissionController {
  handler(): void {}
}

function makeContext(ctor: new () => object, req: RbacScopedRequest): ExecutionContext {
  const proto = ctor.prototype as { handler: () => void };
  return {
    getHandler: () => proto.handler,
    getClass: () => ctor,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

describe("STORY-019 · RbacGuard", () => {
  let guard: RbacGuard;

  beforeEach(() => {
    guard = new RbacGuard(new Reflector());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a route with no @RequirePermission metadata is left alone", () => {
    const req: RbacScopedRequest = {};
    expect(guard.canActivate(makeContext(NoPermissionController, req))).toBe(true);
  });

  // ---- scenario 2 ---------------------------------------------------------

  it("REQ-019-2 · a scoped role's request for a project inside its scope is permitted", () => {
    const req: RbacScopedRequest = {
      membership: { role: "manager", projectScope: ["proj-a", "proj-b"] },
      params: { projectId: "proj-a" },
    };
    expect(guard.canActivate(makeContext(ProjectReadController, req))).toBe(true);
  });

  // ---- scenario 3 ---------------------------------------------------------

  it("REQ-019-3 · a scoped role's request for a project outside its scope is refused with the scope-specific code", () => {
    const req: RbacScopedRequest = {
      membership: { role: "manager", projectScope: ["proj-a"] },
      params: { projectId: "proj-b" },
    };
    expect(() => guard.canActivate(makeContext(ProjectReadController, req))).toThrow(ProjectOutOfScopeException);
    try {
      guard.canActivate(makeContext(ProjectReadController, req));
      expect.fail("expected canActivate to throw");
    } catch (error) {
      expect((error as ProjectOutOfScopeException).getResponse()).toMatchObject({ code: "project_out_of_scope" });
    }
  });

  it("an unrestricted (null) project scope permits every project, regardless of which one is requested", () => {
    const req: RbacScopedRequest = {
      membership: { role: "manager", projectScope: null },
      params: { projectId: "any-project-at-all" },
    };
    expect(guard.canActivate(makeContext(ProjectReadController, req))).toBe(true);
  });

  // ---- scenario 4 ---------------------------------------------------------

  it("REQ-019-4 · a permission denial names the required permission and is not a not-found", () => {
    const req: RbacScopedRequest = { membership: { role: "viewer", projectScope: null } };
    expect(() => guard.canActivate(makeContext(WorkspaceUpdateController, req))).toThrow(PermissionDeniedException);
    try {
      guard.canActivate(makeContext(WorkspaceUpdateController, req));
      expect.fail("expected canActivate to throw");
    } catch (error) {
      const denial = error as PermissionDeniedException;
      expect(denial).not.toBeInstanceOf(NotFoundException);
      expect(denial.getStatus()).toBe(403);
      expect(denial.getResponse()).toMatchObject({
        code: "forbidden",
        details: { required_permission: "workspace:update" },
      });
    }
  });

  // ---- scenario 5 ---------------------------------------------------------

  it("REQ-019-5 · a privileged action without recent strong authentication is refused, naming acceptable methods", () => {
    const req: RbacScopedRequest = {
      membership: { role: "owner", projectScope: null },
      session: { lastStrongAuthAt: null, lastStrongAuthMethod: null },
    };
    expect(() => guard.canActivate(makeContext(WorkspaceDeleteController, req))).toThrow(StepUpRequiredException);
    try {
      guard.canActivate(makeContext(WorkspaceDeleteController, req));
      expect.fail("expected canActivate to throw");
    } catch (error) {
      const stepUp = error as StepUpRequiredException;
      expect(stepUp.getStatus()).toBe(401);
      expect(stepUp.getResponse()).toMatchObject({ code: "step_up_required", details: { methods: ["webauthn", "email_otp"] } });
    }
  });

  // ---- scenario 6 & 7 -------------------------------------------------------

  it("REQ-019-6 · a privileged action with strong authentication exactly 5 minutes old is permitted (closed interval)", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const lastStrongAuthAt = new Date(now.getTime() - 5 * 60 * 1000);
    const req: RbacScopedRequest = {
      membership: { role: "owner", projectScope: null },
      session: { lastStrongAuthAt, lastStrongAuthMethod: "webauthn" },
    };
    expect(guard.canActivate(makeContext(WorkspaceDeleteController, req))).toBe(true);
  });

  it("REQ-019-7 · a privileged action with strong authentication one millisecond past 5 minutes is refused", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const lastStrongAuthAt = new Date(now.getTime() - 5 * 60 * 1000 - 1);
    const req: RbacScopedRequest = {
      membership: { role: "owner", projectScope: null },
      session: { lastStrongAuthAt, lastStrongAuthMethod: "webauthn" },
    };
    expect(() => guard.canActivate(makeContext(WorkspaceDeleteController, req))).toThrow(StepUpRequiredException);
  });

  // ---- scenarios 8 & 9 are unit-tested at the pure-function level in
  // permission-matrix.spec.ts, since they are properties of the matrix data
  // itself rather than of the guard's control flow.

  // ---- widen: pre-workspace-selection request -----------------------------

  it("widen — a request with no req.membership at all (pre-workspace-selection) refuses cleanly, not with an unhandled error", () => {
    const req: RbacScopedRequest = {};
    expect(() => guard.canActivate(makeContext(WorkspaceUpdateController, req))).toThrow(PermissionDeniedException);
  });

  // ---- widen: empty project scope vs. null project scope ------------------

  it("widen — an empty project_scope array (scoped to zero projects) refuses every project-scoped request, unlike null (unrestricted)", () => {
    const req: RbacScopedRequest = {
      membership: { role: "manager", projectScope: [] },
      params: { projectId: "proj-a" },
    };
    expect(() => guard.canActivate(makeContext(ProjectReadController, req))).toThrow(ProjectOutOfScopeException);
  });

  // ---- widen: at most one cached lookup per request ------------------------

  it("widen — RbacGuard adds zero DB/cache lookups: canActivate is fully synchronous for both a step-up and a non-step-up route", () => {
    // RbacGuard's constructor takes only a Reflector — no Pool, no cache
    // service — so there is structurally nothing for it to look up beyond
    // what WorkspaceGuard/AuthGuard already placed on the request.
    // canActivate's own return type (`boolean`, not `boolean |
    // Promise<boolean>`) is the compile-time half of that guarantee; this
    // asserts the runtime half — neither call below is or returns a
    // Promise, i.e. no I/O of any kind occurred.
    const stepUpReq: RbacScopedRequest = {
      membership: { role: "owner", projectScope: null },
      session: { lastStrongAuthAt: new Date(), lastStrongAuthMethod: "webauthn" },
    };
    const stepUpResult = guard.canActivate(makeContext(WorkspaceDeleteController, stepUpReq));
    expect(stepUpResult).toBe(true);
    expect(stepUpResult).not.toBeInstanceOf(Promise);

    const plainReq: RbacScopedRequest = { membership: { role: "owner", projectScope: null } };
    const plainResult = guard.canActivate(makeContext(LookupExecuteController, plainReq));
    expect(plainResult).toBe(true);
    expect(plainResult).not.toBeInstanceOf(Promise);
  });
});
