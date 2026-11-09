import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { getProjectEnginesParamsSchema, getProjectEnginesResponseSchema, updateProjectEnginesParamsSchema } from "../../../contracts/projects/index.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { ProjectEnginesController } from "./project-engines.controller.js";

describe("PUT /projects/{id}/engines · controller", () => {
  it("validates :id, so a malformed id is a 400 and not a uuid-cast 500 (the same boundary check as /aux-findings/{id})", () => {
    const contract = Reflect.getMetadata(API_CONTRACT_KEY, ProjectEnginesController.prototype.update) as { paramsSchema?: unknown };
    expect(contract).toMatchObject({ paramsSchema: updateProjectEnginesParamsSchema });
  });

  it("GE-6 GET /projects/{id}/engines is the PUT's permission (project:update), validates :id, and has a contracted response", () => {
    const get = ProjectEnginesController.prototype as unknown as { read?: (...a: never[]) => unknown };
    expect(get.read).toBeTypeOf("function");
    const contract = Reflect.getMetadata(API_CONTRACT_KEY, get.read!) as { paramsSchema?: unknown; responseSchema?: unknown };
    expect(contract).toMatchObject({ paramsSchema: getProjectEnginesParamsSchema, responseSchema: getProjectEnginesResponseSchema });
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, get.read!)).toBe("project:update");
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, ProjectEnginesController.prototype.update)).toBe("project:update");
  });
});
