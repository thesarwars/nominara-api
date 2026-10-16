import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { StripeUpstreamError, type PlanPrice } from "./stripe-gateway.js";
import { StripeHttpGateway } from "./stripe-http.gateway.js";

// STORY-184 T3 — the HTTP adapter's plan-change calls, against a stubbed SDK client (NO network). What is asserted is
// the REQUEST SHAPE; that Stripe accepts it is collected against the sandbox (plans-7day/story-184-sandbox-checklist.md).

const SECRET = "sk_test_Zx9QpLmN2vB8cD4eF6gH1jK3";
function gatewayWith(client: unknown): StripeHttpGateway {
  const gateway = new StripeHttpGateway({ secretKey: SECRET, webhookSecret: "whsec_Tq7RsUvW5xYz0AbC2dEf4GhI6jKl" });
  (gateway as unknown as { client: unknown }).client = client;
  return gateway;
}

const growth: PlanPrice = { planKey: "growth", productName: "Nominara Growth", unitAmountCents: 12900, currency: "USD", interval: "month" };
const starter: PlanPrice = { planKey: "starter", productName: "Nominara Starter", unitAmountCents: 4900, currency: "USD", interval: "month" };
const priceData = (p: PlanPrice) => ({ currency: "usd", product: `nominara_plan_${p.planKey}`, unit_amount: p.unitAmountCents, recurring: { interval: p.interval } });
const META = { workspace_id: "ws-1", plan_key: "starter", billing_interval: "monthly", plan_change_intent_id: "i1" };

describe("STORY-184 · previewPlanChange", () => {
  it("T3 · asks Stripe for the preview invoice at the given proration date, plan item only, always_invoice", async () => {
    const createPreview = vi.fn(() => Promise.resolve({ amount_due: 3850, currency: "usd" }));
    const result = await gatewayWith({ invoices: { createPreview }, products: { create: vi.fn(() => Promise.resolve({})) } }).previewPlanChange({
      customerId: "cus_1", subscriptionId: "sub_1", planItemId: "si_plan", target: growth, prorationDate: 1_760_000_000,
    });
    expect(createPreview).toHaveBeenCalledWith({
      customer: "cus_1",
      subscription: "sub_1",
      subscription_details: { items: [{ id: "si_plan", price_data: priceData(growth) }], proration_behavior: "always_invoice", proration_date: 1_760_000_000 },
    });
    expect(result).toEqual({ amountDueCents: 3850, currency: "usd" });
  });

  it("T3 · a preview with no amount_due is an upstream failure, never zero (zero would quote a free upgrade)", async () => {
    const createPreview = vi.fn(() => Promise.resolve({ currency: "usd" }));
    await expect(
      gatewayWith({ invoices: { createPreview }, products: { create: vi.fn(() => Promise.resolve({})) } }).previewPlanChange({ customerId: "c", subscriptionId: "s", planItemId: "i", target: growth, prorationDate: 1 }),
    ).rejects.toBeInstanceOf(StripeUpstreamError);
  });
});

describe("STORY-184 · applyPlanUpgrade", () => {
  const args = { subscriptionId: "sub_1", planItemId: "si_plan", target: growth, prorationDate: 1_760_000_000, metadata: META, idempotencyKey: "plan-change-i1" };

  it("T3 · lists ONLY the plan item (add-on items are untouched), charges now, fails rather than leaving the change incomplete", async () => {
    const update = vi.fn(() => Promise.resolve({}));
    const products = vi.fn(() => Promise.resolve({}));
    const result = await gatewayWith({ subscriptions: { update }, products: { create: products } }).applyPlanUpgrade(args);
    expect(result).toEqual({ outcome: "applied" });
    expect(products).toHaveBeenCalledWith({ id: "nominara_plan_growth", name: "Nominara Growth", metadata: { nominara_kind: "plan" } });
    expect(update).toHaveBeenCalledWith(
      "sub_1",
      {
        items: [{ id: "si_plan", price_data: priceData(growth) }],
        proration_behavior: "always_invoice",
        proration_date: 1_760_000_000,
        payment_behavior: "error_if_incomplete",
        metadata: META,
      },
      { idempotencyKey: "plan-change-i1" },
    );
    expect((update.mock.calls[0] as unknown as [string, { items: unknown[] }])[1].items).toHaveLength(1);
  });

  it("T4 · a card decline is payment_failed (nothing changed), not an upstream outage", async () => {
    const declined = new Stripe.errors.StripeCardError({ type: "card_error", code: "card_declined", message: `declined ${SECRET}`, statusCode: 402 } as never);
    const result = await gatewayWith({ subscriptions: { update: () => Promise.reject(declined) }, products: { create: () => Promise.resolve({}) } }).applyPlanUpgrade(args);
    expect(result).toEqual({ outcome: "payment_failed" });
  });

  it("T4 · a 3-D Secure requirement (authentication_required, also a card error) is payment_failed", async () => {
    const needs = new Stripe.errors.StripeCardError({ type: "card_error", code: "authentication_required", message: "x", statusCode: 402 } as never);
    expect(await gatewayWith({ subscriptions: { update: () => Promise.reject(needs) }, products: { create: () => Promise.resolve({}) } }).applyPlanUpgrade(args)).toEqual({ outcome: "payment_failed" });
  });

  it("T4 · any other failure stays an upstream error carrying only the status and type, never the SDK text", async () => {
    const boom = Object.assign(new Error(`secret ${SECRET}`), { statusCode: 500, rawType: "api_error" });
    const err = await gatewayWith({ subscriptions: { update: () => Promise.reject(boom) }, products: { create: () => Promise.resolve({}) } }).applyPlanUpgrade(args).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeUpstreamError);
    expect(err).toMatchObject({ statusCode: 500, errorType: "api_error" });
    expect((err as Error).message).not.toContain(SECRET);
  });

  it("T4 · a reused key with a different call (idempotency_error) is NOT payment_failed: the original may have been applied", async () => {
    const refused = new Stripe.errors.StripeIdempotencyError({ type: "idempotency_error", message: "x", statusCode: 400 } as never);
    const err = await gatewayWith({ subscriptions: { update: () => Promise.reject(refused) }, products: { create: () => Promise.resolve({}) } }).applyPlanUpgrade(args).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 400, errorType: "idempotency_error" });
  });
});

describe("STORY-184 · schedulePlanDowngrade", () => {
  const keep = [{ priceId: "price_seat", quantity: 2 }];
  const stubs = (over: { schedule?: unknown; metadata?: Record<string, string> } = {}) => {
    const scheduleCreate = vi.fn(() => Promise.resolve({ id: "sub_sched_1" }));
    const scheduleUpdate = vi.fn(() => Promise.resolve({}));
    const client = {
      products: { create: vi.fn(() => Promise.resolve({})) },
      subscriptions: { retrieve: () => Promise.resolve({ schedule: over.schedule ?? null, metadata: over.metadata ?? { workspace_id: "ws-1", plan_key: "growth", billing_interval: "monthly" } }) },
      subscriptionSchedules: {
        create: scheduleCreate,
        retrieve: () => Promise.resolve({ id: "sub_sched_1", phases: [{ items: [{ price: "price_plan", quantity: 1 }, { price: { id: "price_seat" }, quantity: 2 }], start_date: 100, end_date: 200 }] }),
        update: scheduleUpdate,
      },
    };
    return { client, scheduleCreate, scheduleUpdate };
  };

  it("T3 · phase 0 is the current plan with the subscription's own metadata; phase 1 is the target plan item plus the kept add-ons, with the intent in its metadata", async () => {
    const { client, scheduleCreate, scheduleUpdate } = stubs();
    const result = await gatewayWith(client).schedulePlanDowngrade({ subscriptionId: "sub_1", target: starter, keepAddons: keep, metadata: META, idempotencyKey: "plan-change-i1" });
    expect(result).toEqual({ scheduleId: "sub_sched_1" });
    expect(scheduleCreate).toHaveBeenCalledWith({ from_subscription: "sub_1" }, { idempotencyKey: "plan-change-i1-schedule" });
    expect(scheduleUpdate).toHaveBeenCalledWith(
      "sub_sched_1",
      {
        end_behavior: "release",
        phases: [
          { items: [{ price: "price_plan", quantity: 1 }, { price: "price_seat", quantity: 2 }], start_date: 100, end_date: 200, metadata: { workspace_id: "ws-1", plan_key: "growth", billing_interval: "monthly" }, proration_behavior: "none" },
          { items: [{ price_data: priceData(starter), quantity: 1 }, { price: "price_seat", quantity: 2 }], duration: { interval: "month", interval_count: 1 }, metadata: META, proration_behavior: "none" },
        ],
      },
      { idempotencyKey: "plan-change-i1" },
    );
  });

  it("T3 · the target plan's product is created once under a fixed id with nominara_kind=plan; an existing one is reused", async () => {
    const { client } = stubs();
    const exists = new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "resource_already_exists", message: "x" } as never);
    client.products.create = vi.fn(() => Promise.reject(exists));
    await expect(gatewayWith(client).schedulePlanDowngrade({ subscriptionId: "sub_1", target: starter, keepAddons: [], metadata: META, idempotencyKey: "k" })).resolves.toEqual({ scheduleId: "sub_sched_1" });
  });

  it("T3 · a schedule the subscription already has is reused (a replay after a lost reply), not created again", async () => {
    const { client, scheduleCreate, scheduleUpdate } = stubs({ schedule: "sub_sched_1" });
    await gatewayWith(client).schedulePlanDowngrade({ subscriptionId: "sub_1", target: starter, keepAddons: [], metadata: META, idempotencyKey: "k" });
    expect(scheduleCreate).not.toHaveBeenCalled();
    expect(scheduleUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("STORY-184 · releasePlanDowngrade", () => {
  const schedule = (over: Record<string, unknown>) => ({
    id: "sub_sched_1",
    status: "active",
    phases: [{ start_date: 100, end_date: 200 }, { start_date: 200, end_date: 300 }],
    current_phase: { start_date: 100, end_date: 200 },
    ...over,
  });
  const clientFor = (s: unknown) => {
    const release = vi.fn(() => Promise.resolve({}));
    return { client: { subscriptionSchedules: { retrieve: () => Promise.resolve(s), release } }, release };
  };

  it("T3 · a schedule still in its first phase is released", async () => {
    const { client, release } = clientFor(schedule({}));
    expect(await gatewayWith(client).releasePlanDowngrade({ scheduleId: "sub_sched_1", idempotencyKey: "c1" })).toEqual({ outcome: "released" });
    expect(release).toHaveBeenCalledWith("sub_sched_1", {}, { idempotencyKey: "c1" });
  });

  it("T3 · a schedule already in its second phase has taken effect: nothing is released", async () => {
    const { client, release } = clientFor(schedule({ current_phase: { start_date: 200, end_date: 300 } }));
    expect(await gatewayWith(client).releasePlanDowngrade({ scheduleId: "sub_sched_1", idempotencyKey: "c1" })).toEqual({ outcome: "already_effective" });
    expect(release).not.toHaveBeenCalled();
  });

  it.each(["completed", "released", "canceled"])("T3 · a %s schedule has nothing left to cancel", async (status) => {
    const { client, release } = clientFor(schedule({ status, current_phase: null }));
    expect((await gatewayWith(client).releasePlanDowngrade({ scheduleId: "sub_sched_1", idempotencyKey: "c1" })).outcome).toBe("already_effective");
    expect(release).not.toHaveBeenCalled();
  });

  it("T3 · a schedule Stripe no longer has is already effective, not an outage", async () => {
    const gone = new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "resource_missing", message: "x" } as never);
    const client = { subscriptionSchedules: { retrieve: () => Promise.reject(gone), release: vi.fn() } };
    expect(await gatewayWith(client).releasePlanDowngrade({ scheduleId: "sub_sched_1", idempotencyKey: "c1" })).toEqual({ outcome: "already_effective" });
  });
});

describe("STORY-184 · scheduleAddonRemoval carries the metadata and the plan item (the latent bug)", () => {
  it("T3 · both phases keep the subscription's metadata, and the plan line survives into phase 1", async () => {
    const scheduleUpdate = vi.fn(() => Promise.resolve({}));
    const client = {
      subscriptions: {
        retrieve: () =>
          Promise.resolve({
            schedule: null,
            metadata: { workspace_id: "ws-1", plan_key: "growth", billing_interval: "monthly" },
            items: { data: [{ id: "si_plan", price: { id: "price_plan", recurring: { interval: "month" } } }, { id: "si_proj", price: { id: "price_proj", recurring: { interval: "month" } } }] },
          }),
      },
      subscriptionSchedules: {
        create: () => Promise.resolve({ id: "sub_sched_1" }),
        retrieve: () => Promise.resolve({ id: "sub_sched_1", phases: [{ items: [{ price: "price_plan", quantity: 1 }, { price: "price_proj", quantity: 2 }], start_date: 100, end_date: 200 }] }),
        update: scheduleUpdate,
      },
    };
    await gatewayWith(client).scheduleAddonRemoval({ subscriptionId: "sub_1", itemId: "si_proj", idempotencyKey: "r1" });
    const body = (scheduleUpdate.mock.calls[0] as unknown as [string, { phases: Array<{ metadata?: unknown; items: unknown[] }> }])[1];
    expect(body.phases[0]!.metadata).toEqual({ workspace_id: "ws-1", plan_key: "growth", billing_interval: "monthly" });
    expect(body.phases[1]!.metadata).toEqual({ workspace_id: "ws-1", plan_key: "growth", billing_interval: "monthly" });
    expect(body.phases[1]!.items).toEqual([{ price: "price_plan", quantity: 1 }]);
  });
});
