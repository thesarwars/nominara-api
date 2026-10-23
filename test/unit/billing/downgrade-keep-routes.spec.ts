import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { AUDIT_METADATA_KEY } from "../../../src/api/decorators/audit.decorator.js";
import { IDEMPOTENT_KEY } from "../../../src/api/decorators/idempotent.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../../src/api/decorators/require-permission.decorator.js";
import { RATE_LIMIT_CLASS_KEY } from "../../../src/api/rate-limit/route-class.js";
import { DowngradeKeepController } from "../../../src/modules/billing/downgrade-keep.controller.js";

// STORY-077 D2 — the declarations of the keep-choice routes (the behaviour over HTTP is in downgrade-keep.spec.ts): the read
// is billing:read, the choice billing:write and audited; neither moves money, so neither is in the plan_change class.
describe("STORY-077 D2 · keep-choice route declarations", () => {
  const reflector = new Reflector();
  const proto = DowngradeKeepController.prototype;

  it("GET is billing:read, PUT billing:write", () => {
    expect(reflector.get<string>(REQUIRE_PERMISSION_KEY, proto.view)).toBe("billing:read");
    expect(reflector.get<string>(REQUIRE_PERMISSION_KEY, proto.choose)).toBe("billing:write");
  });

  it("the choice is audited as billing.plan_change.keep_chosen; the read is not", () => {
    expect(reflector.get<{ action: string }>(AUDIT_METADATA_KEY, proto.choose).action).toBe("billing.plan_change.keep_chosen");
    expect(reflector.get<unknown>(AUDIT_METADATA_KEY, proto.view)).toBeUndefined();
  });

  it("neither route takes the money-moving plan_change rate class, and the PUT needs no idempotency key", () => {
    expect(reflector.get<string | undefined>(RATE_LIMIT_CLASS_KEY, proto.choose)).toBeUndefined();
    expect(reflector.get<string | undefined>(RATE_LIMIT_CLASS_KEY, proto.view)).toBeUndefined();
    expect(reflector.get<boolean | undefined>(IDEMPOTENT_KEY, proto.choose)).toBeUndefined();
  });
});
