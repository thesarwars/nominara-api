import { describe, expect, it } from "vitest";
import { retryRunRequestSchema } from "./retry-run-request.schema.js";
import { conflictDetailsSchema } from "../common/error-details.schema.js";

describe("STORY-195-AC4 retryRunRequestSchema", () => {
  it("accepts an empty body and refuses any key", () => {
    expect(retryRunRequestSchema.parse({})).toEqual({});
    expect(retryRunRequestSchema.safeParse({ engines: ["x"] }).success).toBe(false);
  });
  it("a first run that failed for a reason other than every engine degrading has its own refusal reason (decision 96b)", () => {
    expect(conflictDetailsSchema.safeParse({ reason: "failure_not_degradation" }).success).toBe(true);
  });
  it("the two distinct refusals are accepted conflict reasons", () => {
    for (const reason of ["no_first_run", "run_since_first_run"]) expect(conflictDetailsSchema.safeParse({ reason }).success, reason).toBe(true);
  });
});
