import { describe, expect, it } from "vitest";
import { purgeFailureDetailSchema } from "../../contracts/ops/purge-failure-detail.schema.js";

// STORY-013 (should-fix #9, code review): purge_failures.detail shipped as a
// jsonb column with no zod schema — coding-standards.md §2 treats that as a
// review rejection, same class as STORY-007's three.
describe("STORY-013 · purgeFailureDetailSchema", () => {
  it("accepts null — most failures record only `reason`, no structured detail", () => {
    expect(purgeFailureDetailSchema.safeParse(null).success).toBe(true);
  });

  it("accepts the errorName/errorMessage/stack triad an (error as Error) naturally produces", () => {
    const result = purgeFailureDetailSchema.safeParse({
      errorName: "Error",
      errorMessage: "s3 timeout",
      stack: "Error: s3 timeout\n    at foo",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object", () => {
    expect(purgeFailureDetailSchema.safeParse({}).success).toBe(true);
  });

  it("passes through additional diagnostic keys a future caller attaches", () => {
    const result = purgeFailureDetailSchema.safeParse({ errorName: "Error", attempt: 3 });
    expect(result.success).toBe(true);
  });

  it("rejects a non-object, non-null value", () => {
    expect(purgeFailureDetailSchema.safeParse("not an object").success).toBe(false);
  });
});
