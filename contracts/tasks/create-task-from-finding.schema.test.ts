import { describe, expect, it } from "vitest";
import { createTaskFromFindingRequestSchema } from "./create-task-from-finding.schema.js";

describe("POST /aux-findings/{id}/create-task request schema", () => {
  it("accepts an empty body", () => {
    expect(createTaskFromFindingRequestSchema.safeParse({}).success).toBe(true);
  });
  it("refuses any key, so a client cannot set a field the finding decides", () => {
    for (const body of [{ title: "x" }, { kind: "content" }, { impact_score: 90 }, { finding_id: "x" }]) {
      expect(createTaskFromFindingRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});
