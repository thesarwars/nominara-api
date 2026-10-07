import { describe, expect, it } from "vitest";
import { desiredFromStripeSubscription, toCents, type ClaimedPlanPrice } from "./subscription-state.js";

// STORY-075 AC4 / AC5 — the pure half of the reconciler: a freshly fetched
// Stripe subscription in, the whole local record (or a refusal to write one) out.

const T0 = 1_760_000_000;
/** The catalog price of `growth` (migration 0002): $129 / $1,290, USD. */
const GROWTH: ClaimedPlanPrice = { monthlyCents: 12_900, annualCents: 129_000, currency: "USD" };
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
          price: { unit_amount: 12_900, currency: "usd", recurring: { interval: "month" }, product: { metadata: { nominara_kind: "plan" } } },
        },
      ],
    },
    ...over,
  },
});

describe("STORY-075 AC5 · every synchronised field comes from the fetched subscription", () => {
  it("maps ids, plan, interval, status, period boundaries, trial, cancel flag", () => {
    const { raw, metadata } = sub({ trial_end: T0 + 100, cancel_at_period_end: true });
    const out = desiredFromStripeSubscription(raw, metadata, GROWTH);
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
    const { raw, metadata } = sub({
      current_period_start: T0 + 5,
      current_period_end: T0 + 50,
      items: { data: [{ quantity: 1, price: { unit_amount: 12_900, currency: "usd", recurring: { interval: "month" }, product: { metadata: { nominara_kind: "plan" } } } }] },
    });
    const out = desiredFromStripeSubscription(raw, metadata, GROWTH);
    expect(out.kind === "write" && out.state.currentPeriodEnd).toEqual(new Date((T0 + 50) * 1000));
  });

  it("the billing interval comes from the price Stripe charges, not the metadata we wrote", () => {
    const { raw, metadata } = sub({}, { billing_interval: "monthly" });
    const price = (raw.items as { data: Array<{ price: { unit_amount: number; recurring: { interval: string } } }> }).data[0]!.price;
    price.recurring.interval = "year";
    price.unit_amount = 129_000;
    const out = desiredFromStripeSubscription(raw, metadata, GROWTH);
    expect(out.kind === "write" && out.state.billingInterval).toBe("annual");
  });

  it("extra_seat and extra_project items set seats_purchased (1 + seats) and projects_purchased", () => {
    const { raw, metadata } = sub();
    (raw.items as { data: unknown[] }).data.push(
      { quantity: 3, price: { product: { metadata: { nominara_kind: "extra_seat" } } } },
      { quantity: 2, price: { product: { metadata: { nominara_kind: "extra_project" } } } },
    );
    const out = desiredFromStripeSubscription(raw, metadata, GROWTH);
    expect(out.kind === "write" && [out.state.seatsPurchased, out.state.projectsPurchased]).toEqual([4, 2]);
  });

  it("an object expanded as a customer still yields the id", () => {
    const { raw, metadata } = sub({ customer: { id: "cus_9" } });
    const out = desiredFromStripeSubscription(raw, metadata, GROWTH);
    expect(out.kind === "write" && out.state.providerCustomerId).toBe("cus_9");
  });
});

describe("STORY-075 AC4 · which statuses move the plan", () => {
  it.each(["active", "trialing", "past_due"])("%s keeps the paid plan with that status", (status) => {
    const { raw, metadata } = sub({ status });
    const out = desiredFromStripeSubscription(raw, metadata, GROWTH);
    expect(out.kind === "write" && [out.state.planKey, out.state.status]).toEqual(["growth", status]);
  });

  it.each(["canceled", "incomplete_expired", "unpaid", "paused"])("%s ends the entitlement: free, live row, customer link kept", (status) => {
    const { raw, metadata } = sub({ status });
    const out = desiredFromStripeSubscription(raw, metadata, GROWTH);
    expect(out.kind === "write" && [out.state.planKey, out.state.status, out.state.providerCustomerId]).toEqual(["free", "active", "cus_1"]);
  });

  it("incomplete (first payment not yet taken) writes nothing", () => {
    const { raw, metadata } = sub({ status: "incomplete" });
    expect(desiredFromStripeSubscription(raw, metadata, GROWTH)).toEqual({ kind: "ignore", reason: "subscription is incomplete: payment has not been taken" });
  });

  it("no plan_key in the metadata means it is not a subscription this product created", () => {
    const { raw } = sub();
    expect(desiredFromStripeSubscription(raw, { workspace_id: "w" }, GROWTH).kind).toBe("ignore");
  });

  it("an unrecognised status is refused rather than guessed", () => {
    const { raw, metadata } = sub({ status: "mystery" });
    expect(desiredFromStripeSubscription(raw, metadata, GROWTH).kind).toBe("ignore");
  });
});

describe("CP1 · the plan is verified against the price Stripe charges", () => {
  const withPrice = (price: Record<string, unknown>, quantity: number | undefined = 1) => {
    const { raw, metadata } = sub();
    (raw.items as { data: Array<{ price: Record<string, unknown>; quantity?: number }> }).data[0]!.price = {
      product: { metadata: { nominara_kind: "plan" } },
      ...price,
    };
    (raw.items as { data: Array<{ quantity?: number }> }).data[0]!.quantity = quantity;
    return { raw, metadata };
  };
  const monthly = { unit_amount: 12_900, currency: "usd", recurring: { interval: "month" } };

  it("accepts the catalog monthly and annual price, in either letter case of the currency", () => {
    const m = withPrice(monthly);
    expect(desiredFromStripeSubscription(m.raw, m.metadata, GROWTH).kind).toBe("write");
    const yearly = withPrice({ unit_amount: 129_000, currency: "USD", recurring: { interval: "year" } });
    expect(desiredFromStripeSubscription(yearly.raw, yearly.metadata, GROWTH).kind).toBe("write");
  });

  it.each([
    ["another plan's amount", { ...monthly, unit_amount: 34_900 }],
    ["one cent under", { ...monthly, unit_amount: 12_899 }],
    ["one cent over", { ...monthly, unit_amount: 12_901 }],
    ["another currency", { ...monthly, currency: "eur" }],
    ["the monthly amount on a yearly interval", { ...monthly, recurring: { interval: "year" } }],
    ["a yearly amount on a monthly interval", { ...monthly, unit_amount: 129_000 }],
    ["a weekly interval", { ...monthly, recurring: { interval: "week" } }],
    ["an every-two-months interval", { ...monthly, recurring: { interval: "month", interval_count: 2 } }],
    ["no unit amount (tiered)", { currency: "usd", recurring: { interval: "month" } }],
    ["a unit amount that is not a number", { ...monthly, unit_amount: "12900" }],
    ["no recurring block", { unit_amount: 12_900, currency: "usd" }],
  ])("refuses %s as a mismatch", (_label, price) => {
    const { raw, metadata } = withPrice(price);
    expect(desiredFromStripeSubscription(raw, metadata, GROWTH)).toMatchObject({ kind: "ignore", mismatch: true });
  });

  it("refuses a plan item bought in a quantity other than 1", () => {
    const { raw, metadata } = withPrice(monthly, 2);
    expect(desiredFromStripeSubscription(raw, metadata, GROWTH)).toMatchObject({ kind: "ignore", mismatch: true });
  });

  it("refuses a subscription with no plan item, and one whose claimed plan does not exist", () => {
    const noPlan = sub({ items: { data: [{ quantity: 3, price: { product: { metadata: { nominara_kind: "extra_seat" } } } }] } });
    expect(desiredFromStripeSubscription(noPlan.raw, noPlan.metadata, GROWTH)).toMatchObject({ kind: "ignore", mismatch: true });
    const { raw, metadata } = sub();
    expect(desiredFromStripeSubscription(raw, metadata, null)).toMatchObject({ kind: "ignore", mismatch: true });
  });

  it("an ENDED subscription is never refused for its price: it can only take a plan away", () => {
    const { raw, metadata } = withPrice({ unit_amount: 1, currency: "xxx", recurring: { interval: "week" } });
    raw.status = "canceled";
    expect(desiredFromStripeSubscription(raw, metadata, null).kind).toBe("write");
  });

  it("add-on items do not disturb the plan item's check", () => {
    const { raw, metadata } = sub();
    (raw.items as { data: unknown[] }).data.push({ quantity: 3, price: { unit_amount: 1500, currency: "usd", product: { metadata: { nominara_kind: "extra_seat" } } } });
    expect(desiredFromStripeSubscription(raw, metadata, GROWTH).kind).toBe("write");
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
