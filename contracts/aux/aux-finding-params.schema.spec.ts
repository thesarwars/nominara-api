import { describe, expect, it } from "vitest";
import { auxFindingParamsSchema } from "./aux-finding.schema.js";

describe("the :id of /aux-findings/{id}/... routes", () => {
  it("accepts a lowercase uuid", () => {
    expect(auxFindingParamsSchema.safeParse({ id: "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b" }).success).toBe(true);
  });
  it("refuses a non-uuid, so the route answers 400 rather than a uuid-cast 500", () => {
    for (const id of ["not-a-uuid", "", "0191a2b3c4d57e6f8a9b0c1d2e3f4a5b"]) {
      expect(auxFindingParamsSchema.safeParse({ id }).success).toBe(false);
    }
  });
  it("refuses an extra key", () => {
    expect(auxFindingParamsSchema.safeParse({ id: "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b", x: 1 }).success).toBe(false);
  });
});
