import { describe, expect, it } from "vitest";
import { desiredFromStripeSubscription, toCents } from "./subscription-state.js";

// STORY-075 AC4 / AC5 — the pure half of the reconciler: a freshly fetched
// Stripe subscription in, the whole local record (or a refusal to write one) out.

const T0 = 1_760_000_000;
const sub = (over: Record<string, unknown> = {}, meta: Record<string, string> = {}): { raw: Record<string, unknown>; metadata: Record<string, string> } => ({
  metadata: { workspace_id: "w", plan_key: "growth", billing_interval: "monthly", ...meta },
  raw: {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    trial_end: null,
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: T0,
          current_period_end: T0 + 86_400 * 30,
          price: { recurring: { interval: "month" }, product: { metadata: { nominara_kind: "plan" } } },
        },
      ],
    },
    ...over,
  },
});

describe("STORY-075 AC5 · every synchronised field comes from the fetched subscription", () => {
  it("maps ids, plan, interval, status, period boundaries, trial, cancel flag", () => {
    const { raw, metadata } = sub({ trial_end: T0 + 100, cancel_at_period_end: true });
    const out = desiredFromStripeSubscription(raw, metadata);
    expect(out).toEqual({
      kind: "write",
      state: {
        provider: "stripe",
        providerCustomerId: "cus_1",
        providerSubscriptionId: "sub_1",
        planKey: "growth",
        billingInterval: "monthly",
        status: "active",
        currentPeriodStart: new Date(T0 * 1000),
        currentPeriodEnd: new Date((T0 + 86_400 * 30) * 1000),
        trialEndsAt: new Date((T0 + 100) * 1000),
        cancelAtPeriodEnd: true,
        seatsPurchased: 1,
        projectsPurchased: 0,
      },
    });
  });

  it("reads period boundaries from the subscription itself when the API version puts them there", () => {
    const { raw, metadata } = sub({ current_period_start: T0 + 5, current_period_end: T0 + 50, items: { data: [] } });
    const out = desiredFromStripeSubscription(raw, metadata);
    expect(out.kind === "write" && out.state.currentPeriodEnd).toEqual(new Date((T0 + 50) * 1000));
  });

  it("the billing interval comes from the price Stripe charges, not the metadata we wrote", () => {
    const { raw, metadata } = sub({}, { billing_interval: "monthly" });
    (raw.items as { data: Array<{ price: { recurring: { interval: string } } }> }).data[0]!.price.recurring.interval = "year";
    const out = desiredFromStripeSubscription(raw, metadata);
    expect(out.kind === "write" && out.state.billingInterval).toBe("annual");
  });

  it("extra_seat and extra_project items set seats_purchased (1 + seats) and projects_purchased", () => {
    const { raw, metadata } = sub();
    (raw.items as { data: unknown[] }).data.push(
      { quantity: 3, price: { product: { metadata: { nominara_kind: "extra_seat" } } } },
      { quantity: 2, price: { product: { metadata: { nominara_kind: "extra_project" } } } },
    );
    const out = desiredFromStripeSubscription(raw, metadata);
    expect(out.kind === "write" && [out.state.seatsPurchased, out.state.projectsPurchased]).toEqual([4, 2]);
  });

  it("an object expanded as a customer still yields the id", () => {
    const { raw, metadata } = sub({ customer: { id: "cus_9" } });
    const out = desiredFromStripeSubscription(raw, metadata);
    expect(out.kind === "write" && out.state.providerCustomerId).toBe("cus_9");
  });
});

describe("STORY-075 AC4 · which statuses move the plan", () => {
  it.each(["active", "trialing", "past_due"])("%s keeps the paid plan with that status", (status) => {
    const { raw, metadata } = sub({ status });
    const out = desiredFromStripeSubscription(raw, metadata);
    expect(out.kind === "write" && [out.state.planKey, out.state.status]).toEqual(["growth", status]);
  });

  it.each(["canceled", "incomplete_expired", "unpaid", "paused"])("%s ends the entitlement: free, live row, customer link kept", (status) => {
    const { raw, metadata } = sub({ status });
    const out = desiredFromStripeSubscription(raw, metadata);
    expect(out.kind === "write" && [out.state.planKey, out.state.status, out.state.providerCustomerId]).toEqual(["free", "active", "cus_1"]);
  });

  it("incomplete (first payment not yet taken) writes nothing", () => {
    const { raw, metadata } = sub({ status: "incomplete" });
    expect(desiredFromStripeSubscription(raw, metadata)).toEqual({ kind: "ignore", reason: "subscription is incomplete: payment has not been taken" });
  });

  it("no plan_key in the metadata means it is not a subscription this product created", () => {
    const { raw } = sub();
    expect(desiredFromStripeSubscription(raw, { workspace_id: "w" }).kind).toBe("ignore");
  });

  it("an unrecognised status is refused rather than guessed", () => {
    const { raw, metadata } = sub({ status: "mystery" });
    expect(desiredFromStripeSubscription(raw, metadata).kind).toBe("ignore");
  });
});

describe("toCents — money is never a float", () => {
  it.each([
    ["49.00", 4900],
    ["130", 13000],
    ["1290.50", 129050],
    ["0.07", 7],
  ])("%s -> %i", (price, cents) => expect(toCents(price)).toBe(cents));
  it("refuses a non-money string", () => expect(() => toCents("12.345")).toThrow());
});
