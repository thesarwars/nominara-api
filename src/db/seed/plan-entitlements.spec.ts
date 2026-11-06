import { describe, expect, it } from "vitest";
import { PLAN_ENTITLEMENTS } from "./plan-entitlements.js";

// OWNER DECISION 67a - Prompt Research Keep on Free costs 1 credit per kept prompt, from the included credits.
describe("plan entitlement seed - prompts.credits_per_generated", () => {
  it("DECISION 67a - every tier publishes 1 credit per generated prompt, Free included (no tier is left null)", () => {
    for (const tier of ["free", "starter", "growth", "business", "enterprise"] as const) {
      expect(PLAN_ENTITLEMENTS[tier]["prompts.credits_per_generated"]?.value, tier).toBe(1);
    }
  });
});
