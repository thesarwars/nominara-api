import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { StripeUpstreamError } from "./stripe-gateway.js";
import { StripeHttpGateway } from "./stripe-http.gateway.js";

// STORY-076b — the HTTP adapter's add-on calls, against a stubbed SDK client
// (NO network; no test in this repository calls Stripe). What is asserted is
// the REQUEST SHAPE: proration, the inline price, the product id, and the
// period-end schedule. That Stripe accepts it is collected against the sandbox
// in NEW-A-17.

const SECRET = "sk_test_Zx9QpLmN2vB8cD4eF6gH1jK3";

function gatewayWith(client: unknown): StripeHttpGateway {
  const gateway = new StripeHttpGateway({ secretKey: SECRET, webhookSecret: "whsec_Tq7RsUvW5xYz0AbC2dEf4GhI6jKl" });
  (gateway as unknown as { client: unknown }).client = client;
  return gateway;
}

const input = { subscriptionId: "sub_1", kind: "extra_project" as const, quantity: 2, existingItemId: null, productName: "Nominara Extra project", unitAmountCents: 4900, currency: "USD", interval: "month" as const, proration: "create_prorations" as const, idempotencyKey: "k1" };

describe("STORY-076b · changeAddonQuantity", () => {
  it("AC1 · a new item is created from inline price_data on a fixed product, with proration, on the subscription", async () => {
    const create = vi.fn(() => Promise.resolve({}));
    const products = vi.fn(() => Promise.resolve({}));
    await gatewayWith({ subscriptionItems: { create }, products: { create: products } }).changeAddonQuantity(input);
    expect(products).toHaveBeenCalledWith({ id: "nominara_addon_extra_project", name: "Nominara Extra project", metadata: { nominara_kind: "extra_project" } });
    expect(create).toHaveBeenCalledWith(
      {
        subscription: "sub_1",
        quantity: 2,
        proration_behavior: "create_prorations",
        price_data: { currency: "usd", product: "nominara_addon_extra_project", unit_amount: 4900, recurring: { interval: "month" } },
      },
      { idempotencyKey: "k1" },
    );
  });

  it("an existing product (a second purchase) is reused, not an error", async () => {
    const create = vi.fn(() => Promise.resolve({}));
    const exists = new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "resource_already_exists", message: "x" } as never);
    await gatewayWith({ subscriptionItems: { create }, products: { create: () => Promise.reject(exists) } }).changeAddonQuantity(input);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("AC1 · an existing item is updated to the TOTAL with proration (no second item)", async () => {
    const update = vi.fn(() => Promise.resolve({}));
    const create = vi.fn();
    await gatewayWith({ subscriptionItems: { update, create }, products: { create: vi.fn() } }).changeAddonQuantity({ ...input, existingItemId: "si_9", quantity: 5 });
    expect(update).toHaveBeenCalledWith("si_9", { quantity: 5, proration_behavior: "create_prorations" }, { idempotencyKey: "k1" });
    expect(create).not.toHaveBeenCalled();
  });

  it("a Stripe failure is a StripeUpstreamError carrying only the status code", async () => {
    const boom = Object.assign(new Error(`secret ${SECRET} leaked`), { statusCode: 402 });
    const err = await gatewayWith({ subscriptionItems: { create: () => Promise.reject(boom) }, products: { create: () => Promise.resolve({}) } })
      .changeAddonQuantity(input)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeUpstreamError);
    expect((err as StripeUpstreamError).statusCode).toBe(402);
    expect((err as Error).message).not.toContain(SECRET);
  });
});

describe("STORY-076b checkpoint-4 · the error type survives the gateway", () => {
  it("STORY-076b AC-idempotency-error . Stripe's 400 idempotency_error reaches the service as a typed error, not only as a 400 status", async () => {
    const refused = new Stripe.errors.StripeIdempotencyError({ type: "idempotency_error", message: `reused ${SECRET}`, statusCode: 400 } as never);
    const err = await gatewayWith({ subscriptionItems: { update: () => Promise.reject(refused) } })
      .changeAddonQuantity({ ...input, existingItemId: "si_9" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeUpstreamError);
    expect(err).toMatchObject({ statusCode: 400, errorType: "idempotency_error" });
    expect((err as Error).message).not.toContain(SECRET);
  });

  it("STORY-076b AC-idempotency-error . an error with no Stripe type carries none (the status alone is what it was)", async () => {
    const err = await gatewayWith({ subscriptionItems: { create: () => Promise.reject(Object.assign(new Error("x"), { statusCode: 400 })) }, products: { create: () => Promise.resolve({}) } })
      .changeAddonQuantity(input)
      .catch((e: unknown) => e);
    expect((err as StripeUpstreamError).errorType).toBeUndefined();
  });
});

describe("STORY-076b · scheduleAddonRemoval", () => {
  const phaseItems = [{ price: "price_plan", quantity: 1 }, { price: { id: "price_proj" }, quantity: 2 }];
  const stubs = (over: { schedule?: unknown; phases?: unknown[]; items?: unknown[] } = {}) => {
    const scheduleCreate = vi.fn(() => Promise.resolve({ id: "sub_sched_1" }));
    const scheduleUpdate = vi.fn(() => Promise.resolve({}));
    const client = {
      subscriptions: {
        retrieve: () =>
          Promise.resolve({
            schedule: over.schedule ?? null,
            items: { data: over.items ?? [{ id: "si_plan", price: { id: "price_plan", recurring: { interval: "month" } } }, { id: "si_proj", price: { id: "price_proj", recurring: { interval: "month" } } }] },
          }),
      },
      subscriptionSchedules: {
        create: scheduleCreate,
        retrieve: () => Promise.resolve({ id: "sub_sched_1", phases: over.phases ?? [{ items: phaseItems, start_date: 100, end_date: 200 }] }),
        update: scheduleUpdate,
      },
    };
    return { client, scheduleCreate, scheduleUpdate };
  };

  it("AC4 · keeps the current phase to the period end and drops ONLY the add-on's price from the phase after it, then releases", async () => {
    const { client, scheduleCreate, scheduleUpdate } = stubs();
    await gatewayWith(client).scheduleAddonRemoval({ subscriptionId: "sub_1", itemId: "si_proj", idempotencyKey: "r1" });
    expect(scheduleCreate).toHaveBeenCalledWith({ from_subscription: "sub_1" }, { idempotencyKey: "r1-schedule" });
    expect(scheduleUpdate).toHaveBeenCalledWith(
      "sub_sched_1",
      {
        end_behavior: "release",
        phases: [
          { items: [{ price: "price_plan", quantity: 1 }, { price: "price_proj", quantity: 2 }], start_date: 100, end_date: 200 },
          { items: [{ price: "price_plan", quantity: 1 }], duration: { interval: "month", interval_count: 1 } },
        ],
      },
      { idempotencyKey: "r1" },
    );
  });

  it("reuses a schedule the subscription already has instead of creating another", async () => {
    const { client, scheduleCreate, scheduleUpdate } = stubs({ schedule: "sub_sched_1" });
    await gatewayWith(client).scheduleAddonRemoval({ subscriptionId: "sub_1", itemId: "si_proj", idempotencyKey: "r1" });
    expect(scheduleCreate).not.toHaveBeenCalled();
    expect(scheduleUpdate).toHaveBeenCalledTimes(1);
  });

  it("a removal already scheduled earlier is rewritten from the existing second phase, not appended", async () => {
    const { client, scheduleUpdate } = stubs({
      schedule: "sub_sched_1",
      phases: [{ items: [{ price: "price_plan", quantity: 1 }, { price: "price_proj", quantity: 2 }, { price: "price_seat", quantity: 1 }], start_date: 100, end_date: 200 }, { items: [{ price: "price_plan", quantity: 1 }, { price: "price_proj", quantity: 2 }] }],
    });
    await gatewayWith(client).scheduleAddonRemoval({ subscriptionId: "sub_1", itemId: "si_proj", idempotencyKey: "r2" });
    const phases = (scheduleUpdate.mock.calls[0] as unknown as [string, { phases: Array<{ items: unknown[] }> }])[1].phases;
    expect(phases).toHaveLength(2);
    expect(phases[1]!.items).toEqual([{ price: "price_plan", quantity: 1 }]);
  });

  it("null path · an item no longer on the subscription schedules nothing (a redelivered DELETE)", async () => {
    const { client, scheduleCreate, scheduleUpdate } = stubs({ items: [{ id: "si_plan", price: { id: "price_plan" } }] });
    await gatewayWith(client).scheduleAddonRemoval({ subscriptionId: "sub_1", itemId: "si_proj", idempotencyKey: "r1" });
    expect(scheduleCreate).not.toHaveBeenCalled();
    expect(scheduleUpdate).not.toHaveBeenCalled();
  });

  it("an unconfigured gateway fails closed with an upstream error", async () => {
    const gateway = new StripeHttpGateway({ secretKey: undefined, webhookSecret: undefined });
    await expect(gateway.scheduleAddonRemoval({ subscriptionId: "s", itemId: "i", idempotencyKey: "k" })).rejects.toBeInstanceOf(StripeUpstreamError);
    await expect(gateway.changeAddonQuantity(input)).rejects.toBeInstanceOf(StripeUpstreamError);
  });
});
