import { describe, expect, it } from "vitest";
import { updateProjectEnginesParamsSchema, updateProjectEnginesRequestSchema } from "./update-project-engines.schema.js";

describe("PUT /projects/{id}/engines request schema", () => {
  const ok = (engines: unknown) => updateProjectEnginesRequestSchema.safeParse({ engines }).success;
  it("accepts the table's bounds and refuses outside them", () => {
    expect(ok([{ engine_key: "chatgpt", weight: 5 }])).toBe(true);
    expect(ok([{ engine_key: "chatgpt", weight: 0.01, sample_count: 5, enabled: false }])).toBe(true);
    expect(ok([{ engine_key: "chatgpt", weight: 0 }])).toBe(false);
    expect(ok([{ engine_key: "chatgpt", weight: 5.01 }])).toBe(false);
    expect(ok([{ engine_key: "chatgpt", sample_count: 0 }])).toBe(false);
    expect(ok([{ engine_key: "chatgpt", sample_count: 6 }])).toBe(false);
    expect(ok([{ engine_key: "chatgpt", sample_count: 1.5 }])).toBe(false);
  });
  it("refuses unknown keys, empty or repeated entries and an entry that changes nothing", () => {
    expect(ok([{ engine_key: "chatgpt", enabled: true, colour: "red" }])).toBe(false);
    expect(updateProjectEnginesRequestSchema.safeParse({ engines: [{ engine_key: "a", enabled: true }], extra: 1 }).success).toBe(false);
    expect(ok([])).toBe(false);
    expect(ok([{ engine_key: "chatgpt" }])).toBe(false);
    expect(ok([{ engine_key: "chatgpt", enabled: true }, { engine_key: "chatgpt", weight: 2 }])).toBe(false);
  });
});

describe("the :id of PUT /projects/{id}/engines", () => {
  const id = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
  it("accepts a lowercase uuid; refuses a non-uuid, an empty id and an extra key, so the route answers 400 rather than a uuid-cast 500", () => {
    expect(updateProjectEnginesParamsSchema.safeParse({ id }).success).toBe(true);
    for (const bad of ["not-a-uuid", "", "0191a2b3c4d57e6f8a9b0c1d2e3f4a5b"]) expect(updateProjectEnginesParamsSchema.safeParse({ id: bad }).success, bad).toBe(false);
    expect(updateProjectEnginesParamsSchema.safeParse({ id, x: 1 }).success).toBe(false);
  });
});
