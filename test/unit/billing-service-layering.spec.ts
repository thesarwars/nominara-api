import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DAILY_CAP_ENTITLEMENT as FROM_DECORATOR } from "../../src/api/decorators/daily-cap.decorator.js";
import { DAILY_CAP_ENTITLEMENT } from "../../src/lib/usage/daily-cap.js";

// STORY-096 AC15 - the service layer reads the daily-cap entitlement map from lib/, not from the API layer's decorator module.
describe("STORY-096 AC15 · the daily-cap entitlement map lives in lib/usage", () => {
  it("BillingService does not import from the API decorators", () => {
    const source = readFileSync(new URL("../../src/modules/billing/billing.service.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "\.\.\/\.\.\/api\/decorators\//);
  });
  it("lib/usage/daily-cap.ts owns the map and the decorator re-exports the SAME object (one source)", () => {
    expect(DAILY_CAP_ENTITLEMENT).toEqual({ lookup: "credits.lookups_per_day_max", nlp_command: "credits.nlp_parses_per_day_max" });
    expect(FROM_DECORATOR).toBe(DAILY_CAP_ENTITLEMENT);
  });
});
