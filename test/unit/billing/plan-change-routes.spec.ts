import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { AUDIT_METADATA_KEY } from "../../../src/api/decorators/audit.decorator.js";
import { IDEMPOTENT_KEY } from "../../../src/api/decorators/idempotent.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../../src/api/decorators/require-permission.decorator.js";
import { RATE_LIMIT_CLASS_KEY } from "../../../src/api/rate-limit/route-class.js";
import { PlanChangeController } from "../../../src/modules/billing/plan-change.controller.js";

// STORY-184 scenarios 26-28 — the declarations of the three routes, in the fast suite (the behaviour over HTTP is proved
// by the integration specs): billing:write on every one (owner and admin hold it; a manager and a viewer do not), no
// step-up decorator, the change idempotent, and the change and its cancel in the `plan_change` rate class.
describe("STORY-184 · plan-change route declarations", () => {
  const reflector = new Reflector();
  const proto = PlanChangeController.prototype;
  const handlers = { preview: proto.preview, change: proto.change, cancel: proto.cancel };

  it.each(Object.entries(handlers))("scenario 26 · %s requires billing:write", (_name, handler) => {
    expect(reflector.get<string>(REQUIRE_PERMISSION_KEY, handler)).toBe("billing:write");
  });

  it("scenario 26 · none of them asks for a step-up (owner decision 2026-10-16)", () => {
    for (const handler of Object.values(handlers)) {
      expect(Reflect.getMetadataKeys(handler).filter((key) => String(key).toLowerCase().includes("stepup") || String(key).toLowerCase().includes("step_up"))).toEqual([]);
    }
  });

  it("scenario 27 · the change is idempotent; the preview and the cancel are not", () => {
    expect(reflector.get<boolean>(IDEMPOTENT_KEY, handlers.change)).toBe(true);
    expect(reflector.get<boolean | undefined>(IDEMPOTENT_KEY, handlers.preview)).toBeUndefined();
    expect(reflector.get<boolean | undefined>(IDEMPOTENT_KEY, handlers.cancel)).toBeUndefined();
  });

  it("scenario 27 · every route is audited under its own action", () => {
    expect(Object.values(handlers).map((h) => reflector.get<{ action: string }>(AUDIT_METADATA_KEY, h).action)).toEqual([
      "billing.plan_change.previewed",
      "billing.plan_change.requested",
      "billing.plan_change.cancelled",
    ]);
  });

  it("scenario 28 · the change and the cancel share the plan_change rate class; the preview is an ordinary write", () => {
    expect(reflector.get<string>(RATE_LIMIT_CLASS_KEY, handlers.change)).toBe("plan_change");
    expect(reflector.get<string>(RATE_LIMIT_CLASS_KEY, handlers.cancel)).toBe("plan_change");
    expect(reflector.get<string | undefined>(RATE_LIMIT_CLASS_KEY, handlers.preview)).toBeUndefined();
  });
});
