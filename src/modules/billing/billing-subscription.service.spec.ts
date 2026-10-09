import type { ClientBase } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { StripeGateway } from "../../lib/billing/stripe/stripe-gateway.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { BillingSubscriptionService } from "./billing-subscription.service.js";

// STORY-075a checkpoint-4 — checkout waits for the workspace row lock for a BOUNDED time, like an add-on purchase.
// A request queued behind the lock holder keeps its main-pool connection while it waits; unbounded, enough of them
// empty the pool and the whole API stops answering.

const counter = vi.hoisted(() => vi.fn((..._args: unknown[]) => undefined));
vi.mock("../../lib/telemetry/metrics.js", () => ({ incrementCounter: counter }));

const WS = "00000000-0000-7000-8000-000000000001";

function client(onLock: () => unknown): ClientBase & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM plans WHERE key/u.test(sql) || /FROM plans\s+WHERE key/u.test(sql)) {
        return Promise.resolve({ rows: [{ key: "growth", display_name: "Growth", monthly_price: "129.00", annual_price: "1290.00", currency: "USD", sort_order: 3 }], rowCount: 1 });
      }
      if (/FROM workspaces WHERE id = \$1 FOR UPDATE/u.test(sql)) return Promise.resolve(onLock());
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as ClientBase & { calls: Array<{ sql: string; params: unknown[] }> };
}

describe("STORY-075a checkpoint-4 · checkout takes the workspace lock with a bounded wait", () => {
  const gateway = { isConfigured: () => true } as unknown as StripeGateway;
  const pool = { connect: () => Promise.reject(new Error("the write pool must not be reached")) } as never;

  it("AC-checkout-lock . the lock is waited for at most 3 s (transaction-local) and exceeding it is a retryable 409, counted, with no Stripe call and no write", async () => {
    const c = client(() => {
      throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
    });
    const service = new BillingSubscriptionService(gateway, pool);
    await expect(withTenantContext(c, { workspaceId: WS, actorId: WS }, () => service.checkout({ plan_key: "growth", billing_interval: "monthly" }))).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/in progress/u),
    });
    const timeout = c.calls.find(({ sql }) => /set_config\('lock_timeout', \$1, true\)/u.test(sql));
    expect(timeout?.params).toEqual(["3000"]);
    const lock = c.calls.findIndex(({ sql }) => /FOR UPDATE/u.test(sql));
    expect(c.calls.findIndex(({ sql }) => /set_config\('lock_timeout', \$1, true\)/u.test(sql))).toBeLessThan(lock);
    expect(counter).toHaveBeenCalledWith("nominara_billing_checkout_session_total", { outcome: "lock_wait_exceeded" });
  });

  it("AC-checkout-lock . an error that is not a lock timeout is not swallowed into a 409", async () => {
    const c = client(() => {
      throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    });
    const service = new BillingSubscriptionService(gateway, pool);
    await expect(withTenantContext(c, { workspaceId: WS, actorId: WS }, () => service.checkout({ plan_key: "growth", billing_interval: "monthly" }))).rejects.toMatchObject({ code: "40P01" });
  });
});
