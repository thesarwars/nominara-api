import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStripeGateway } from "../../support/fake-stripe-gateway.js";
import { StripeUpstreamError } from "../../../src/lib/billing/stripe/stripe-gateway.js";
import { runStripeDriftCheck, type LocalStripeSubscription } from "../../../src/lib/billing/stripe-drift.js";

// STORY-075 AC11 / owner decision 2026-10-28 §100(e): the nightly provider-vs-local drift check ALERTS ONLY. Fake gateway; never Stripe.

const T0 = Date.UTC(2026, 10, 1) / 1000;
const T1 = Date.UTC(2026, 11, 1) / 1000;

function local(n: number, over: Partial<LocalStripeSubscription> = {}): LocalStripeSubscription {
  return {
    id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    workspaceId: `11111111-0000-7000-8000-${String(n).padStart(12, "0")}`,
    stripeSubscriptionId: `sub_${String(n)}`,
    planKey: "growth",
    status: "active",
    currentPeriodStart: new Date(T0 * 1000),
    currentPeriodEnd: new Date(T1 * 1000),
    cancelAtPeriodEnd: false,
    seatsPurchased: 3,
    projectsPurchased: 2,
    ...over,
  };
}

function item(kind: string, quantity: number): Record<string, unknown> {
  return { quantity, price: { product: { metadata: { nominara_kind: kind } } } };
}

function remoteRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "active",
    current_period_start: T0,
    current_period_end: T1,
    cancel_at_period_end: false,
    items: { data: [item("plan", 1), item("extra_seat", 2), item("extra_project", 2)] },
    ...over,
  };
}

describe("STORY-075 AC11 · nightly Stripe drift check", () => {
  let gateway: FakeStripeGateway;
  let metrics: { metric: string; field?: string }[];
  let logs: unknown[];

  beforeEach(() => {
    gateway = new FakeStripeGateway();
    metrics = [];
    logs = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
      if (typeof message === "object" && message !== null && "metric" in message) metrics.push(message as { metric: string; field?: string });
      else logs.push(message);
    });
    vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => void logs.push(message));
    vi.spyOn(Logger.prototype, "error").mockImplementation((message: unknown) => void logs.push(message));
  });
  afterEach(() => vi.restoreAllMocks());

  const put = (n: number, raw = remoteRaw(), planKey = "growth"): void => gateway.putObject("subscription", `sub_${String(n)}`, { plan_key: planKey }, raw);
  const pagesOf = (rows: LocalStripeSubscription[]) => (afterId: string | null, limit: number) =>
    Promise.resolve(rows.filter((row) => afterId === null || row.id > afterId).slice(0, limit));
  const driftMetrics = (): string[] => metrics.filter((m) => m.metric === "nominara_billing_stripe_drift_total").map((m) => m.field ?? "");

  it("[STORY-075 AC11] no drift reports nothing", async () => {
    put(1);
    const result = await runStripeDriftCheck({ loadPage: pagesOf([local(1)]), gateway });
    expect(result).toMatchObject({ checked: 1, drifted: 0, errors: 0 });
    expect(driftMetrics()).toEqual([]);
    expect(logs.filter((l) => JSON.stringify(l).includes("stripe_drift_detected"))).toEqual([]);
  });

  it.each([
    ["status", remoteRaw({ status: "past_due" }), {}, "status"],
    ["current_period_start", remoteRaw({ current_period_start: T0 + 86_400 }), {}, "current_period_start"],
    ["current_period_end", remoteRaw({ current_period_end: T1 + 86_400 }), {}, "current_period_end"],
    ["cancel_at_period_end", remoteRaw({ cancel_at_period_end: true }), {}, "cancel_at_period_end"],
    ["seats_purchased", remoteRaw({ items: { data: [item("plan", 1), item("extra_seat", 5), item("extra_project", 2)] } }), {}, "seats_purchased"],
    ["projects_purchased", remoteRaw({ items: { data: [item("plan", 1), item("extra_seat", 2)] } }), {}, "projects_purchased"],
    ["plan_key", remoteRaw(), { planKey: "scale" }, "plan_key"],
  ] as const)("[STORY-075 AC11] drift in %s is reported on exactly that field", async (_n, raw, over, field) => {
    put(1, raw);
    const result = await runStripeDriftCheck({ loadPage: pagesOf([local(1, over)]), gateway });
    expect(result.drifted).toBe(1);
    expect(driftMetrics()).toEqual([field]);
  });

  it("[STORY-075 AC11] an ended remote subscription matches local free + active (no false drift)", async () => {
    put(1, remoteRaw({ status: "canceled" }));
    await runStripeDriftCheck({ loadPage: pagesOf([local(1, { planKey: "free", status: "active" })]), gateway });
    expect(driftMetrics()).toEqual([]);
  });

  it("[STORY-075 AC11] a subscription deleted at Stripe is reported as remote_missing", async () => {
    const result = await runStripeDriftCheck({ loadPage: pagesOf([local(1)]), gateway });
    expect(result.drifted).toBe(1);
    expect(driftMetrics()).toEqual(["remote_missing"]);
  });

  it("[STORY-075 AC11] a Stripe error on one subscription does not abort the run", async () => {
    put(2, remoteRaw({ status: "past_due" }));
    const real = gateway.fetchObject.bind(gateway);
    vi.spyOn(gateway, "fetchObject").mockImplementation((kind, id) => (id === "sub_1" ? Promise.reject(new StripeUpstreamError(503)) : real(kind, id)));
    const result = await runStripeDriftCheck({ loadPage: pagesOf([local(1), local(2)]), gateway });
    expect(result).toMatchObject({ checked: 2, drifted: 1, errors: 1 });
    expect(driftMetrics()).toEqual(["status"]);
    expect(metrics.some((m) => m.metric === "nominara_billing_stripe_drift_errors_total")).toBe(true);
  });

  it("[STORY-075 AC11] pages through every local row with bounded concurrency", async () => {
    const rows = Array.from({ length: 23 }, (_v, i) => local(i + 1));
    rows.forEach((_r, i) => put(i + 1));
    let inFlight = 0;
    let peak = 0;
    const real = gateway.fetchObject.bind(gateway);
    vi.spyOn(gateway, "fetchObject").mockImplementation(async (kind, id) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return real(kind, id);
    });
    const result = await runStripeDriftCheck({ loadPage: pagesOf(rows), gateway }, { pageSize: 10, concurrency: 4 });
    expect(result.checked).toBe(23);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("[STORY-075 AC11] the log line carries ids and field names only - no plan, email or amounts", async () => {
    put(1, remoteRaw({ status: "past_due", customer_email: "leak@example.com", amount: 4900 }));
    await runStripeDriftCheck({ loadPage: pagesOf([local(1)]), gateway });
    const text = JSON.stringify(logs);
    expect(text).toContain("stripe_drift_detected");
    expect(text).toContain(local(1).id);
    expect(text).toContain("status");
    expect(text).not.toContain("leak@example.com");
    expect(text).not.toContain("4900");
    expect(text).not.toContain("past_due");
    expect(text).not.toContain("growth");
  });

  it("[STORY-075 AC11] the check has no write path: the gateway is only ever asked to fetch", async () => {
    put(1, remoteRaw({ status: "past_due" }));
    await runStripeDriftCheck({ loadPage: pagesOf([local(1)]), gateway });
    expect(gateway.fetches.every((f) => f.startsWith("subscription:"))).toBe(true);
  });
});
