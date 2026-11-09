import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { alignmentTargetsQuerySchema, alignmentTargetsResponseSchema } from "../../../contracts/analytics/index.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { AlignmentController } from "./alignment.controller.js";

describe("GET /geo/alignment/targets · controller", () => {
  const proto = AlignmentController.prototype as unknown as { targets?: (...a: never[]) => unknown };

  it("AT-12 is optimizer:use, contracted with a strict query, and declared BEFORE `:id` so `targets` is never read as a session id", () => {
    expect(proto.targets).toBeTypeOf("function");
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, proto.targets!)).toBe("optimizer:use");
    expect(Reflect.getMetadata(API_CONTRACT_KEY, proto.targets!)).toMatchObject({ querySchema: alignmentTargetsQuerySchema, responseSchema: alignmentTargetsResponseSchema });
    const order = Object.getOwnPropertyNames(AlignmentController.prototype);
    expect(order.indexOf("targets")).toBeLessThan(order.indexOf("get"));
  });
});
