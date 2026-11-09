import { describe, expect, it, vi } from "vitest";
import { StripeUpstreamError } from "./stripe-gateway.js";
import { StripeHttpGateway } from "./stripe-http.gateway.js";

// Decision 83(a) — the HTTP adapter's cancel-at-period-end, against a stubbed SDK client (NO network). The request SHAPE is what is
// asserted: ONLY the flag, no immediate cancel, no proration or refund, and no idempotency key (subscription-prompt-stripe.md trap 9:
// a key on a boolean toggle makes Stripe replay the stored response without re-applying it).

const gatewayWith = (client: unknown): StripeHttpGateway => {
  const gateway = new StripeHttpGateway({ secretKey: "sk_test_Zx9QpLmN2vB8cD4eF6gH1jK3", webhookSecret: "whsec_Tq7RsUvW5xYz0AbC2dEf4GhI6jKl" });
  (gateway as unknown as { client: unknown }).client = client;
  return gateway;
};

describe("decision 83(a) · setSubscriptionCancelAtPeriodEnd", () => {
  it("sets cancel_at_period_end on the subscription and nothing else: no immediate cancel, no refund, no idempotency key", async () => {
    const update = vi.fn(() => Promise.resolve({}));
    const cancel = vi.fn();
    await gatewayWith({ subscriptions: { update, cancel } }).setSubscriptionCancelAtPeriodEnd({ subscriptionId: "sub_1" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a Stripe failure is a StripeUpstreamError so the retry ladder sees it", async () => {
    const update = vi.fn(() => Promise.reject(Object.assign(new Error("boom"), { statusCode: 503 })));
    const failure = await gatewayWith({ subscriptions: { update } }).setSubscriptionCancelAtPeriodEnd({ subscriptionId: "sub_1" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StripeUpstreamError);
    expect((failure as StripeUpstreamError).statusCode).toBe(503);
  });

  it("an unconfigured gateway fails closed", async () => {
    await expect(gatewayWith(undefined).setSubscriptionCancelAtPeriodEnd({ subscriptionId: "sub_1" })).rejects.toBeInstanceOf(StripeUpstreamError);
  });
});
