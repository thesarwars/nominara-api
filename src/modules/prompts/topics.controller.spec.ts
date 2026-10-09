import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { AUDIT_METADATA_KEY } from "../../api/decorators/audit.decorator.js";
import { PROJECT_PARAM_KEY } from "../../api/decorators/project-param.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { SCOPED_BY_QUERY_KEY } from "../../api/decorators/scoped-by-query.decorator.js";
import { TopicsController } from "./topics.controller.js";

// NEW-B-3 CP2 QA — the topics routes had no route-metadata test. Mutations M7
// (GET topics to project:read) and M9 (@ProjectParam('id') swapped for
// @ScopedByQuery on GET) survived every suite, and M9 matters:
// TopicsService.list does no scope check of its own, so a scoped manager could
// list another project's topics with nothing failing.
describe("NEW-B-3 · TopicsController route metadata", () => {
  const list = TopicsController.prototype.list;
  const rename = TopicsController.prototype.rename;

  it("GET /projects/:id/topics requires tracking:read", () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, list)).toBe("tracking:read");
  });

  it("GET /projects/:id/topics names the project param, so the guard compares it to the member's scope", () => {
    expect(Reflect.getMetadata(PROJECT_PARAM_KEY, list)).toBe("id");
  });

  it("GET /projects/:id/topics does NOT opt in to ScopedByQuery (the service does no scope check of its own)", () => {
    expect(Reflect.getMetadata(SCOPED_BY_QUERY_KEY, list)).toBeUndefined();
  });

  it("PATCH /topics/:id requires prompt:write", () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, rename)).toBe("prompt:write");
  });

  it("PATCH /topics/:id opts in to ScopedByQuery and has no @ProjectParam (the path names a topic, not a project)", () => {
    expect(Reflect.getMetadata(SCOPED_BY_QUERY_KEY, rename)).toBe(true);
    expect(Reflect.getMetadata(PROJECT_PARAM_KEY, rename)).toBeUndefined();
  });

  it("PATCH /topics/:id is audited as topic.renamed", () => {
    expect(Reflect.getMetadata(AUDIT_METADATA_KEY, rename)).toMatchObject({ action: "topic.renamed", resourceType: "topic" });
  });

  it("declares operation ids listTopics and renameTopic", () => {
    expect((Reflect.getMetadata(API_CONTRACT_KEY, list) as { operationId: string }).operationId).toBe("listTopics");
    expect((Reflect.getMetadata(API_CONTRACT_KEY, rename) as { operationId: string }).operationId).toBe("renameTopic");
  });
});
