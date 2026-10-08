import Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StripeHttpGateway, WEBHOOK_TOLERANCE_SECONDS } from "./stripe-http.gateway.js";
import { objectKindForEventType, StripeSignatureError, StripeUpstreamError } from "./stripe-gateway.js";

// NEW-D-2 — the HTTP adapter's verification path, run against the REAL SDK's
// signing scheme (Stripe.webhooks.generateTestHeaderString) with NO network:
// `fetchObject` is the only method that would open a socket and it is not
// called here with a live key. No test in this repository calls Stripe.

const SECRET_KEY = "sk_test_Zx9QpLmN2vB8cD4eF6gH1jK3";
const WEBHOOK_SECRET = "whsec_Tq7RsUvW5xYz0AbC2dEf4GhI6jKl";

const payload = JSON.stringify({ id: "evt_1", object: "event", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });
const stripe = new Stripe(SECRET_KEY);
const sign = (body: string, opts: { secret?: string; timestamp?: number } = {}): string =>
  stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: opts.secret ?? WEBHOOK_SECRET,
    ...(opts.timestamp === undefined ? {} : { timestamp: opts.timestamp }),
  });

const gateway = (): StripeHttpGateway => new StripeHttpGateway({ secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET });

afterEach(() => vi.restoreAllMocks());

describe("STORY-075 · scenarios 2 and 3 — signature verification (HTTP adapter)", () => {
  it("scenario 3 · a correctly signed payload yields the event id, type and the object to re-fetch", () => {
    expect(gateway().verifyWebhook(Buffer.from(payload), sign(payload))).toEqual({
      id: "evt_1",
      type: "customer.subscription.updated",
      objectId: "sub_1",
    });
  });

  it("scenario 2 · a signature made with another secret is refused", () => {
    expect(() => gateway().verifyWebhook(Buffer.from(payload), sign(payload, { secret: "whsec_other" }))).toThrow(StripeSignatureError);
  });

  it("scenario 2 · a body altered after signing is refused (the HMAC covers the raw bytes)", () => {
    const header = sign(payload);
    expect(() => gateway().verifyWebhook(Buffer.from(payload.replace("sub_1", "sub_2")), header)).toThrow(StripeSignatureError);
  });

  it("scenario 2 · a missing or empty Stripe-Signature header is refused", () => {
    expect(() => gateway().verifyWebhook(Buffer.from(payload), undefined)).toThrow(StripeSignatureError);
    expect(() => gateway().verifyWebhook(Buffer.from(payload), "")).toThrow(StripeSignatureError);
    expect(() => gateway().verifyWebhook(Buffer.from(payload), "garbage")).toThrow(StripeSignatureError);
  });

  it("scenario 2 · a replay outside the tolerance is refused, and one just inside it is accepted", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() => gateway().verifyWebhook(Buffer.from(payload), sign(payload, { timestamp: now - WEBHOOK_TOLERANCE_SECONDS - 5 }))).toThrow(
      StripeSignatureError,
    );
    expect(() => gateway().verifyWebhook(Buffer.from(payload), sign(payload, { timestamp: now - WEBHOOK_TOLERANCE_SECONDS + 30 }))).not.toThrow();
  });

  it("the tolerance is Stripe's 300 seconds, stated rather than defaulted", () => {
    expect(WEBHOOK_TOLERANCE_SECONDS).toBe(300);
  });

  it("with no webhook secret configured nothing verifies — fail closed, never 'skip verification'", () => {
    const unconfigured = new StripeHttpGateway({ secretKey: SECRET_KEY, webhookSecret: undefined });
    expect(unconfigured.isConfigured()).toBe(false);
    expect(() => unconfigured.verifyWebhook(Buffer.from(payload), sign(payload))).toThrow(StripeSignatureError);
  });

  it("an event with no data.object.id is refused even when correctly signed — there is nothing to re-fetch", () => {
    const body = JSON.stringify({ id: "evt_2", object: "event", type: "x.y", data: { object: {} } });
    expect(() => gateway().verifyWebhook(Buffer.from(body), sign(body))).toThrow(StripeSignatureError);
  });
});

describe("NEW-D-2 · configuration — absent keys degrade, they do not crash", () => {
  it("isConfigured needs BOTH the secret key and the webhook secret", () => {
    expect(gateway().isConfigured()).toBe(true);
    expect(new StripeHttpGateway({ secretKey: undefined, webhookSecret: WEBHOOK_SECRET }).isConfigured()).toBe(false);
    expect(new StripeHttpGateway({ secretKey: SECRET_KEY, webhookSecret: undefined }).isConfigured()).toBe(false);
    expect(new StripeHttpGateway({ secretKey: undefined, webhookSecret: undefined }).isConfigured()).toBe(false);
  });

  it("fetchObject with no secret key is an upstream error, not a TypeError", async () => {
    const g = new StripeHttpGateway({ secretKey: undefined, webhookSecret: WEBHOOK_SECRET });
    await expect(g.fetchObject("subscription", "sub_1")).rejects.toBeInstanceOf(StripeUpstreamError);
  });
});

describe("NEW-D-2 · redaction — no error or log line ever contains a Stripe credential", () => {
  const secrets = [SECRET_KEY, WEBHOOK_SECRET];
  const leaks = (text: string): string[] => secrets.filter((s) => text.includes(s) || text.includes(s.slice(0, 12)));

  it("a refused signature carries neither secret in its message, stack or serialisation", () => {
    let caught: unknown;
    try {
      gateway().verifyWebhook(Buffer.from(payload), sign(payload, { secret: "whsec_other" }));
    } catch (error) {
      caught = error;
    }
    const error = caught as Error;
    expect(error).toBeInstanceOf(StripeSignatureError);
    expect(leaks([error.message, error.stack ?? "", JSON.stringify(error, Object.getOwnPropertyNames(error))].join("\n"))).toEqual([]);
  });

  it("an upstream failure carries a status code and nothing else — never the SDK's text, which can echo the key", async () => {
    const g = gateway();
    // The SDK's own error message embeds the (partial) key on a 401; the adapter must not pass it on.
    const sdkError = Object.assign(new Error(`Invalid API Key provided: ${SECRET_KEY}`), { statusCode: 401 });
    const internal = g as unknown as { client: { subscriptions: { retrieve: () => Promise<never> } } };
    internal.client.subscriptions.retrieve = () => Promise.reject(sdkError);

    let caught: unknown;
    try {
      await g.fetchObject("subscription", "sub_1");
    } catch (error) {
      caught = error;
    }
    const error = caught as StripeUpstreamError;
    expect(error).toBeInstanceOf(StripeUpstreamError);
    expect(error.statusCode).toBe(401);
    expect(leaks([error.message, error.stack ?? "", JSON.stringify(error, Object.getOwnPropertyNames(error))].join("\n"))).toEqual([]);
  });

  it("the adapter never writes to the console at all", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m));
    const stdout = vi.spyOn(process.stdout, "write");
    try {
      gateway().verifyWebhook(Buffer.from(payload), sign(payload));
      expect(() => gateway().verifyWebhook(Buffer.from(payload), "bad")).toThrow();
    } finally {
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(stdout.mock.calls.map((c) => String(c[0])).filter((line) => leaks(line).length > 0)).toEqual([]);
    }
  });
});

describe("NEW-D-2 · which Stripe object an event type points at", () => {
  it.each([
    ["customer.subscription.updated", "subscription"],
    ["customer.subscription.deleted", "subscription"],
    ["checkout.session.completed", "checkout_session"],
    ["invoice.paid", "invoice"],
    ["invoice.payment_failed", "invoice"],
    ["payment_intent.succeeded", "payment_intent"],
  ])("%s -> %s", (type, kind) => {
    expect(objectKindForEventType(type)).toBe(kind);
  });

  it("a type this product does not consume maps to null, not a guess", () => {
    expect(objectKindForEventType("customer.created")).toBeNull();
    expect(objectKindForEventType("")).toBeNull();
  });
});

describe("NEW-D-2 audit · the subscription Checkout call a retry can replay", () => {
  const input = {
    workspaceId: "w1",
    planKey: "growth",
    billingInterval: "monthly" as const,
    productName: "Nominara Growth",
    unitAmountCents: 12_900,
    currency: "USD",
    successUrl: "https://app.test/settings/plan?checkout=success",
    cancelUrl: "https://app.test/settings/plan?checkout=cancel",
    intentId: "0199c0de-0000-7000-8000-000000000001",
    idempotencyKey: "subscription-checkout-0199c0de-0000-7000-8000-000000000001",
  };

  it("names the intent in the subscription's metadata and sends the intent's Idempotency-Key, so the same call returns the same session", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.test/c/pay/cs_1" });
    const gw = gateway();
    (gw as unknown as { client: unknown }).client = { checkout: { sessions: { create } } };
    await gw.createSubscriptionCheckout(input);
    const [params, options] = create.mock.calls[0] as [{ subscription_data: { metadata: Record<string, string> } }, { idempotencyKey: string }];
    expect(params.subscription_data.metadata).toEqual({ workspace_id: "w1", plan_key: "growth", billing_interval: "monthly", checkout_intent_id: input.intentId });
    expect(options).toEqual({ idempotencyKey: input.idempotencyKey });
  });
});

describe("NEW-D-7 · the saved payment method and the off-session charge (HTTP adapter)", () => {
  const packInput = {
    workspaceId: "w1",
    purchaseId: "0199c0de-0000-7000-8000-000000000002",
    packKey: "starter_vault",
    productName: "Nominara Starter Vault (1000 credits)",
    credits: 1000,
    unitAmountCents: 1500,
    currency: "USD",
    successUrl: "https://app.test/settings/plan?credit_pack=success",
    cancelUrl: "https://app.test/settings/plan?credit_pack=cancel",
    saveCard: true,
  };
  const charge = {
    workspaceId: "w1",
    purchaseId: "0199c0de-0000-7000-8000-000000000003",
    packKey: "starter_vault",
    productName: "Nominara Starter Vault (1000 credits)",
    unitAmountCents: 1500,
    currency: "USD",
    customerId: "cus_1",
    paymentMethodId: "pm_1",
  };
  const withClient = (client: unknown): StripeHttpGateway => {
    const gw = gateway();
    (gw as unknown as { client: unknown }).client = client;
    return gw;
  };

  it("NEW-D-7 AC4 · a credit-pack Checkout saves the card for off-session use (setup_future_usage) under a customer", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.test/c/pay/cs_1" });
    await withClient({ checkout: { sessions: { create } } }).createCreditPackCheckout(packInput);
    const [params] = create.mock.calls[0] as [{ customer_creation: string; payment_intent_data: { setup_future_usage: string; metadata: Record<string, string> } }];
    expect(params.payment_intent_data.setup_future_usage).toBe("off_session");
    expect(params.customer_creation).toBe("always");
    expect(params.payment_intent_data.metadata.purchase_id).toBe(packInput.purchaseId);
  });

  it("owner decision 4 · a credit-pack Checkout for a workspace without auto-top-up saves NO card: no setup_future_usage, no customer_creation", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.test/c/pay/cs_1" });
    await withClient({ checkout: { sessions: { create } } }).createCreditPackCheckout({ ...packInput, saveCard: false });
    const [params] = create.mock.calls[0] as [{ customer_creation?: string; payment_intent_data: { setup_future_usage?: string; metadata: Record<string, string> } }];
    expect(params.payment_intent_data.setup_future_usage).toBeUndefined();
    expect(params.customer_creation).toBeUndefined();
    expect(params.payment_intent_data.metadata.purchase_id).toBe(packInput.purchaseId);
  });

  it("NEW-D-7 AC4 · findSavedPaymentMethod answers the customer and method only for a PaymentIntent saved with setup_future_usage=off_session", async () => {
    const retrieve = vi.fn();
    const gw = withClient({ paymentIntents: { retrieve } });
    retrieve.mockResolvedValueOnce({ id: "pi_1", customer: "cus_1", payment_method: "pm_1", setup_future_usage: "off_session" });
    expect(await gw.findSavedPaymentMethod("pi_1")).toEqual({ customerId: "cus_1", paymentMethodId: "pm_1" });
    retrieve.mockResolvedValueOnce({ id: "pi_2", customer: "cus_1", payment_method: "pm_1", setup_future_usage: null });
    expect(await gw.findSavedPaymentMethod("pi_2")).toBeNull();
    retrieve.mockResolvedValueOnce({ id: "pi_3", customer: null, payment_method: "pm_1", setup_future_usage: "off_session" });
    expect(await gw.findSavedPaymentMethod("pi_3")).toBeNull();
    retrieve.mockResolvedValueOnce({ id: "pi_4", customer: "cus_1", payment_method: null, setup_future_usage: "off_session" });
    expect(await gw.findSavedPaymentMethod("pi_4")).toBeNull();
  });

  it("NEW-D-7 AC1 · the off-session charge is confirmed off_session, carries the ids as metadata, and keys its idempotency on the purchase", async () => {
    const create = vi.fn().mockResolvedValue({ id: "pi_auto_1", status: "succeeded" });
    const result = await withClient({ paymentIntents: { create } }).createOffSessionPayment(charge);
    expect(result).toEqual({ outcome: "submitted", paymentIntentId: "pi_auto_1" });
    const [params, options] = create.mock.calls[0] as [Record<string, unknown>, { idempotencyKey: string }];
    expect(params).toMatchObject({ amount: 1500, currency: "usd", customer: "cus_1", payment_method: "pm_1", off_session: true, confirm: true });
    expect(params.metadata).toEqual({ workspace_id: "w1", purchase_id: charge.purchaseId, pack_key: "starter_vault", source: "auto_topup" });
    expect(options).toEqual({ idempotencyKey: `auto-topup-${charge.purchaseId}` });
  });

  it("NEW-D-7 AC2 · a card decline, or a charge that needs the customer present, is `declined`; any other failure is an upstream error", async () => {
    const decline = Object.assign(new Stripe.errors.StripeCardError({ type: "card_error", message: "declined" } as never), { statusCode: 402 });
    expect(await withClient({ paymentIntents: { create: vi.fn().mockRejectedValue(decline) } }).createOffSessionPayment(charge)).toEqual({ outcome: "declined" });
    expect(await withClient({ paymentIntents: { create: vi.fn().mockResolvedValue({ id: "pi_x", status: "requires_action" }) } }).createOffSessionPayment(charge)).toEqual({ outcome: "declined" });
    await expect(withClient({ paymentIntents: { create: vi.fn().mockRejectedValue(Object.assign(new Error("boom sk_test_secret"), { statusCode: 503 })) } }).createOffSessionPayment(charge)).rejects.toMatchObject({ name: "StripeUpstreamError", statusCode: 503 });
  });
});
