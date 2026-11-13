import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetentionExportController } from "../../modules/billing/retention-export.controller.js";
import { StepUpRequiredException } from "../../tenancy/errors.js";
import { REQUIRE_STEP_UP_KEY, RequireStepUp } from "../decorators/require-step-up.decorator.js";
import { RequirePermission } from "../decorators/require-permission.decorator.js";
import { RbacGuard, type RbacScopedRequest } from "./rbac.guard.js";

// Owner decision 100(j): a ROUTE can require a fresh strong authentication on top of its permission, with exactly export:data's behaviour (the shared
// window and closed edge in tenancy/step-up.ts; 401 step_up_required with details.methods). The permission matrix is untouched: billing:write stays
// step-up free for the plan change.

class Stepped {
  @RequirePermission("billing:write")
  @RequireStepUp()
  handler(): void {}
}
class Plain {
  @RequirePermission("billing:write")
  handler(): void {}
}
const ctx = (cls: new () => object, req: RbacScopedRequest): ExecutionContext =>
  ({ getHandler: () => (cls.prototype as { handler: () => void }).handler, getClass: () => cls, switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;
const guard = new RbacGuard(new Reflector());
const owner = (lastStrongAuthAt: Date | null): RbacScopedRequest => ({ membership: { role: "owner", projectScope: null }, session: { lastStrongAuthAt, lastStrongAuthMethod: lastStrongAuthAt ? "webauthn" : null } });

afterEach(() => vi.useRealTimers());

describe("owner decision 100(j) · @RequireStepUp", () => {
  it("a stale session (no strong authentication) is refused 401 step_up_required with the acceptable methods", () => {
    try {
      guard.canActivate(ctx(Stepped, owner(null)));
      expect.fail("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(StepUpRequiredException);
      expect((error as StepUpRequiredException).getStatus()).toBe(401);
      expect((error as StepUpRequiredException).getResponse()).toMatchObject({ code: "step_up_required", details: { methods: ["webauthn", "email_otp"] } });
    }
  });

  it("a session whose strong authentication is older than the window is refused; exactly at the edge it is accepted (the export:data rule)", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(() => guard.canActivate(ctx(Stepped, owner(new Date(now.getTime() - 5 * 60_000 - 1))))).toThrow(StepUpRequiredException);
    expect(guard.canActivate(ctx(Stepped, owner(new Date(now.getTime() - 5 * 60_000))))).toBe(true);
  });

  it("a step-up session is accepted", () => {
    expect(guard.canActivate(ctx(Stepped, owner(new Date())))).toBe(true);
  });

  it("the permission is still checked first: a role without it gets 403, not a step-up prompt", () => {
    const req: RbacScopedRequest = { membership: { role: "analyst", projectScope: null }, session: { lastStrongAuthAt: null, lastStrongAuthMethod: null } };
    expect(() => guard.canActivate(ctx(Stepped, req))).toThrow(/forbidden|permission/i);
  });

  it("a route without the decorator is unaffected (billing:write stays step-up free)", () => {
    expect(guard.canActivate(ctx(Plain, owner(null)))).toBe(true);
  });

  it("only the retention-export REQUEST carries it: the view and the download (a presign of an existing file) do not", () => {
    const r = new Reflector();
    const proto = RetentionExportController.prototype;
    expect(r.get(REQUIRE_STEP_UP_KEY, proto.request)).toBe(true);
    expect(r.get(REQUIRE_STEP_UP_KEY, proto.view)).toBeUndefined();
    expect(r.get(REQUIRE_STEP_UP_KEY, proto.download)).toBeUndefined();
  });
});
