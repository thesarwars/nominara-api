import { describe, expect, it } from "vitest";
import { PRECONDITION_UNMET_REASONS } from "../../contracts/common/error-details.schema.js";
import { noCapturableScopeError, scopeIsCapturable } from "../../src/lib/capture/manual-run.js";

// STORY-034 — "does this scan have anything to capture" has ONE definition,
// used by the estimate's `capturable`, by the trigger's in-transaction
// refusal, and by CreditGuard's refusal before it reserves. Three copies of
// `> 0` would be three chances to disagree about a scope the customer is
// about to be charged for.
describe("STORY-034 · scopeIsCapturable", () => {
  it("is false for an empty scope and true from one planned cell up — the boundary", () => {
    expect(scopeIsCapturable(0)).toBe(false);
    expect(scopeIsCapturable(1)).toBe(true);
    expect(scopeIsCapturable(2_400)).toBe(true);
  });
});

describe("STORY-034 · noCapturableScopeError", () => {
  it("is a 422 precondition_unmet whose details.reason names the check, and says nothing was charged", () => {
    const error = noCapturableScopeError();
    expect(error.getStatus()).toBe(422);
    expect(error.code).toBe("precondition_unmet");
    expect(error.details).toEqual({ reason: "no_capturable_scope" });
    expect(PRECONDITION_UNMET_REASONS).toContain("no_capturable_scope");
    expect(error.message).toMatch(/nothing was charged/);
  });
});
