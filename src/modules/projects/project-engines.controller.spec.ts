import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { updateProjectEnginesParamsSchema } from "../../../contracts/projects/index.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { ProjectEnginesController } from "./project-engines.controller.js";

describe("PUT /projects/{id}/engines · controller", () => {
  it("validates :id, so a malformed id is a 400 and not a uuid-cast 500 (the same boundary check as /aux-findings/{id})", () => {
    const contract = Reflect.getMetadata(API_CONTRACT_KEY, ProjectEnginesController.prototype.update) as { paramsSchema?: unknown };
    expect(contract).toMatchObject({ paramsSchema: updateProjectEnginesParamsSchema });
  });
});
