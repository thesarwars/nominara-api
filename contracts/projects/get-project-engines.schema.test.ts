import { describe, expect, it } from "vitest";
import { getProjectEnginesParamsSchema, getProjectEnginesResponseSchema } from "./index.js";

const ID = "0192f0aa-0000-7000-8000-000000000001";

describe("GET /projects/{id}/engines · contract", () => {
  it("GE-C1 the response carries overrides and the effective set, and refuses an unknown key", () => {
    const ok = { project_id: ID, overrides: [{ engine_key: "chatgpt", enabled: false, weight: 2, sample_count: 1 }], engines: [] };
    expect(getProjectEnginesResponseSchema.safeParse(ok).success).toBe(true);
    expect(getProjectEnginesResponseSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
  it("GE-C2 :id must be a lowercase uuid", () => {
    expect(getProjectEnginesParamsSchema.safeParse({ id: ID }).success).toBe(true);
    expect(getProjectEnginesParamsSchema.safeParse({ id: "nope" }).success).toBe(false);
  });
});
