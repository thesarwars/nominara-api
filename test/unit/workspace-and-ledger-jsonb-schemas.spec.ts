import { describe, expect, it } from "vitest";
import { entitlementOverridesSchema } from "../../contracts/workspaces/entitlement-overrides.schema.js";
import { ownershipTransferSchema } from "../../contracts/workspaces/ownership-transfer.schema.js";
import { ledgerUnitDetailSchema } from "../../contracts/billing/ledger-unit-detail.schema.js";

// STORY-007 · code review: three jsonb columns shipped with no zod schema —
// data-model.md's convention table treats that as a review rejection.
describe("STORY-007 · jsonb column schemas flagged by review", () => {
  describe("entitlementOverridesSchema", () => {
    it("accepts an empty object, matching the column's default", () => {
      expect(entitlementOverridesSchema.safeParse({}).success).toBe(true);
    });

    it("accepts a partial override of known entitlement keys", () => {
      expect(entitlementOverridesSchema.safeParse({ "projects.max": 10, "sso.oidc": true }).success).toBe(true);
    });

    it("rejects a non-object", () => {
      expect(entitlementOverridesSchema.safeParse("not an object").success).toBe(false);
    });
  });

  describe("ownershipTransferSchema", () => {
    it("accepts null — no transfer in progress", () => {
      expect(ownershipTransferSchema.safeParse(null).success).toBe(true);
    });

    it("accepts a valid in-progress transfer matching EC-15's state machine", () => {
      const result = ownershipTransferSchema.safeParse({
        state: "awaiting_acceptance",
        initiatedBy: "11111111-1111-4111-8111-111111111111",
        recipientId: "22222222-2222-4222-8222-222222222222",
        initiatedAt: "2026-08-11T00:00:00.000Z",
      });
      expect(result.success).toBe(true);
    });

    it("rejects a state outside EC-15's diagram", () => {
      const result = ownershipTransferSchema.safeParse({
        state: "not_a_real_state",
        initiatedBy: "11111111-1111-4111-8111-111111111111",
        recipientId: "22222222-2222-4222-8222-222222222222",
        initiatedAt: "2026-08-11T00:00:00.000Z",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a non-UUID actor", () => {
      const result = ownershipTransferSchema.safeParse({
        state: "initiated",
        initiatedBy: "not-a-uuid",
        recipientId: "22222222-2222-4222-8222-222222222222",
        initiatedAt: "2026-08-11T00:00:00.000Z",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("ledgerUnitDetailSchema", () => {
    it("accepts null — not every ledger entry carries unit-of-work detail", () => {
      expect(ledgerUnitDetailSchema.safeParse(null).success).toBe(true);
    });

    it("accepts the documented shape", () => {
      const result = ledgerUnitDetailSchema.safeParse({
        prompts: 30,
        engines: ["chatgpt", "claude"],
        cellsCharged: 12,
        cellsCached: 18,
      });
      expect(result.success).toBe(true);
    });

    it("rejects a negative count", () => {
      expect(ledgerUnitDetailSchema.safeParse({ cellsCharged: -1 }).success).toBe(false);
    });
  });
});
