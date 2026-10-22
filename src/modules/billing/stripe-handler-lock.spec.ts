import type { ClientBase } from "pg";
import { describe, expect, it, vi } from "vitest";
import { StripeInvoiceHandler } from "./stripe-invoice.handler.js";
import { StripeSubscriptionHandler } from "./stripe-subscription.handler.js";
import type { StripeEventContext } from "./stripe-event-handler.js";

// STORY-075 / STORY-075b checkpoint-5 — a webhook handler takes the workspace row lock on a MAIN-POOL connection.
// Unbounded, every event queued behind a slow billing request holds a connection while it waits (the add-on
// requests hold the lock across Stripe calls), which starves every other tenant. The wait is bounded and a
// timeout is a retryable failure: nothing is recorded, so Stripe redelivers the event.

const counter = vi.hoisted(() => vi.fn((..._args: unknown[]) => undefined));
vi.mock("../../lib/telemetry/metrics.js", () => ({ incrementCounter: counter }));

const WS = "00000000-0000-7000-8000-000000000001";

function lockedClient(): ClientBase & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FOR UPDATE/u.test(sql)) return Promise.reject(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as ClientBase & { calls: Array<{ sql: string; params: unknown[] }> };
}

const context = (tx: ClientBase, kind: "subscription" | "invoice"): StripeEventContext =>
  ({ tx, workspaceId: WS, event: { id: "evt_1", type: "x", objectId: "o" }, object: { kind, id: "o", metadata: {}, raw: {} }, fetchStartedAt: new Date(), afterCommit: [] }) as unknown as StripeEventContext;

describe.each([
  ["StripeSubscriptionHandler", () => new StripeSubscriptionHandler({} as never, {} as never), "subscription"],
  ["StripeInvoiceHandler", () => new StripeInvoiceHandler({} as never), "invoice"],
] as const)("STORY-075 checkpoint-5 · %s bounds its workspace lock wait", (_name, make, kind) => {
  it("sets a transaction-local lock_timeout BEFORE the lock, and a timeout is a retryable degraded (never a hang or a 500), counted", async () => {
    const tx = lockedClient();
    await expect(make().handle(context(tx, kind))).rejects.toMatchObject({ code: "degraded" });
    const timeout = tx.calls.findIndex(({ sql }) => /set_config\('lock_timeout', \$1, true\)/u.test(sql));
    const lock = tx.calls.findIndex(({ sql }) => /FOR UPDATE/u.test(sql));
    expect(timeout).toBeGreaterThanOrEqual(0);
    expect(timeout).toBeLessThan(lock);
    expect(tx.calls[timeout]!.params).toEqual(["3000"]);
    expect(counter).toHaveBeenCalledWith("nominara_billing_webhook_lock_wait_exceeded_total", {});
  });

  it("a non-timeout failure of the lock is not disguised as one", async () => {
    const tx = { query: (sql: string) => (/FOR UPDATE/u.test(sql) ? Promise.reject(Object.assign(new Error("boom"), { code: "XX000" })) : Promise.resolve({ rows: [], rowCount: 0 })) } as unknown as ClientBase;
    await expect(make().handle(context(tx, kind))).rejects.toMatchObject({ message: "boom" });
  });
});
