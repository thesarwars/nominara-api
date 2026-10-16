import { describe, expect, it } from "vitest";
import { CONFLICT_REASONS, conflictDetailsSchema, PRECONDITION_UNMET_REASONS } from "../../../contracts/common/error-details.schema.js";
import {
  pendingPlanChangeSchema,
  planChangePreviewRequestSchema,
  planChangePreviewResponseSchema,
  planChangeRequestSchema,
  planChangeResponseSchema,
} from "../../../contracts/billing/plan-change.schema.js";

// STORY-184 — the contract the three routes are built against. Test scenarios 7, 13 and the closed reasons.

const QUOTE = { proration_date: 1_760_000_000, amount_due_now: "38.50", currency: "USD" };

describe("STORY-184 · plan-change contract", () => {
  it("scenario 13 · no request carries an interval: an unknown key is a failure, not a silent drop", () => {
    expect(planChangePreviewRequestSchema.safeParse({ plan_key: "growth" }).success).toBe(true);
    expect(planChangePreviewRequestSchema.safeParse({ plan_key: "growth", billing_interval: "annual" }).success).toBe(false);
    expect(planChangeRequestSchema.safeParse({ plan_key: "growth", billing_interval: "annual" }).success).toBe(false);
    expect(planChangeRequestSchema.safeParse({ plan_key: "growth", quote: QUOTE, extra: 1 }).success).toBe(false);
  });

  it("the quote is strict and its amount is a two-digit decimal string, never a float", () => {
    expect(planChangeRequestSchema.safeParse({ plan_key: "growth", quote: QUOTE }).success).toBe(true);
    expect(planChangeRequestSchema.safeParse({ plan_key: "growth", quote: { ...QUOTE, amount_due_now: 38.5 } }).success).toBe(false);
    expect(planChangeRequestSchema.safeParse({ plan_key: "growth", quote: { ...QUOTE, amount_due_now: "38.5" } }).success).toBe(false);
    expect(planChangeRequestSchema.safeParse({ plan_key: "growth", quote: { ...QUOTE, proration_date: 1.5 } }).success).toBe(false);
  });

  it("the change response can only say pending: a granted plan is unrepresentable", () => {
    const ok = { status: "pending", direction: "upgrade", target_plan_key: "growth", effective: "immediate", effective_at: null };
    expect(planChangeResponseSchema.safeParse(ok).success).toBe(true);
    expect(planChangeResponseSchema.safeParse({ ...ok, status: "applied" }).success).toBe(false);
  });

  it("the preview labels its credit figure an estimate and always keeps purchased credits", () => {
    const base = {
      direction: "downgrade",
      current_plan_key: "business",
      target_plan_key: "growth",
      billing_interval: "monthly",
      effective: "period_end",
      effective_at: "2026-11-01T00:00:00.000Z",
      amount_due_now: "0.00",
      currency: "USD",
      quote: null,
      credit_estimate: { basis: "estimate", top_up_now: 0, grant_at_next_cycle: 1200 },
      purchased_credits_kept: true,
      exceeds: [{ kind: "structural", key: "projects.max", limit: 3, current: 5, excess: 2 }],
      blocked_by: "exceeds_limits",
    };
    expect(planChangePreviewResponseSchema.safeParse(base).success).toBe(true);
    expect(planChangePreviewResponseSchema.safeParse({ ...base, purchased_credits_kept: false }).success).toBe(false);
    expect(planChangePreviewResponseSchema.safeParse({ ...base, credit_estimate: { ...base.credit_estimate, basis: "exact" } }).success).toBe(false);
    expect(planChangePreviewResponseSchema.safeParse({ ...base, blocked_by: "because" }).success).toBe(false);
  });

  it("the excess list carries the four kinds and nothing else; a structural entry must actually exceed", () => {
    const row = (exceeds: unknown) =>
      planChangePreviewResponseSchema.safeParse({
        direction: "downgrade", current_plan_key: "business", target_plan_key: "growth", billing_interval: "monthly",
        effective: "period_end", effective_at: null, amount_due_now: "0.00", currency: "USD", quote: null,
        credit_estimate: { basis: "estimate", top_up_now: 0, grant_at_next_cycle: 1 }, purchased_credits_kept: true,
        exceeds, blocked_by: null,
      }).success;
    expect(row([{ kind: "feature_lost", key: "whitelabel.custom_domain" }, { kind: "addon_dropped", addon: "extra_seat", quantity: 2 }, { kind: "retention_shortened", key: "retention.raw_captures_days", from_days: 395, to_days: 180 }])).toBe(true);
    expect(row([{ kind: "structural", key: "seats.max", limit: 7, current: 7, excess: 0 }])).toBe(false);
    expect(row([{ kind: "structural", key: "seats.max", limit: 7, current: 9, excess: 2, surprise: true }])).toBe(false);
    expect(row([{ kind: "pause_everything" }])).toBe(false);
  });

  it("the intent's shape is closed and the settled marker is optional", () => {
    const intent = {
      id: "0194a3d2-7b1c-7c2e-9d4a-1f2e3d4c5b6a", direction: "upgrade", from_plan_key: "starter", to_plan_key: "growth",
      billing_interval: "monthly", unit_amount_cents: 12900, currency: "USD", effective: "immediate", effective_at: null,
      stripe_subscription_id: "sub_1", stripe_idempotency_key: "plan-change-x", proration_date: 1_760_000_000,
      amount_due_now_cents: 3850, schedule_id: null, created_at: "2026-10-16T10:00:00.000Z",
    };
    expect(pendingPlanChangeSchema.safeParse(intent).success).toBe(true);
    expect(pendingPlanChangeSchema.safeParse({ ...intent, settled_at: "2026-10-16T10:00:01.000Z" }).success).toBe(true);
    expect(pendingPlanChangeSchema.safeParse({ ...intent, unit_amount_cents: 0 }).success).toBe(false);
    expect(pendingPlanChangeSchema.safeParse({ ...intent, surprise: 1 }).success).toBe(false);
  });

  it("the new refusal reasons are in the closed enums, and the conflict details carry the excess list", () => {
    for (const reason of ["quote_changed", "downgrade_exceeds_limits", "downgrade_already_effective", "subscription_past_due", "cancellation_pending", "change_scheduled", "plan_change_pending", "plan_change_not_pending"]) {
      expect(CONFLICT_REASONS).toContain(reason);
    }
    expect(PRECONDITION_UNMET_REASONS).toContain("payment_failed");
    expect(PRECONDITION_UNMET_REASONS).toContain("cancel_in_portal");
    const excess = [{ kind: "structural", key: "seats.max", limit: 7, current: 9, excess: 2 }];
    expect(conflictDetailsSchema.safeParse({ reason: "downgrade_exceeds_limits", excess }).success).toBe(true);
    expect(conflictDetailsSchema.safeParse({ reason: "made_up" }).success).toBe(false);
  });
});
