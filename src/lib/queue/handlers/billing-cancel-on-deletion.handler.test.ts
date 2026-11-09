import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { ClientBase, Pool } from "pg";
import { handlerFor, type QueueHandlerContext } from "../handlers.js";
import { signQueueJobPayload } from "../envelope.js";
import { topologyFor } from "../topology.js";
import { createJobProcessor } from "../worker-factory.js";
import { createBillingCancelOnDeletionHandler } from "./billing-cancel-on-deletion.handler.js";

// Decision 83(a) — `billing.cancel_on_deletion`: after a workspace deletion request commits, set its Stripe subscription to
// cancel at period end. A SIGNED TENANT job; no refund; no Stripe call inside a transaction; a workspace with no Stripe
// subscription is a no-op.

const WORKSPACE = "11111111-1111-7111-8111-111111111111";
const KEY = Buffer.from("billing-cancel-on-deletion-test-key");

interface Rows {
  status?: string;
  subscription?: { stripe_subscription_id: string; cancel_at_period_end: boolean };
}

function harness(rows: Rows, order: string[] = []) {
  const query = vi.fn(async (sql: string) => {
    const head = sql.trim().split(/\s+/)[0]!.toUpperCase();
    if (/FROM workspaces/i.test(sql)) {
      order.push("read-workspace");
      return { rows: rows.status === undefined ? [] : [{ status: rows.status }], rowCount: rows.status === undefined ? 0 : 1 };
    }
    if (/FROM subscriptions/i.test(sql)) {
      order.push("read-subscription");
      return { rows: rows.subscription ? [rows.subscription] : [], rowCount: rows.subscription ? 1 : 0 };
    }
    order.push(head);
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() } as unknown as ClientBase & { release(): void };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { context: { pool, env: {} as never } satisfies QueueHandlerContext, query, client, order };
}
const jobWith = (payload: Record<string, unknown> = {}): Job => ({ data: { payload: { workspaceId: WORKSPACE, kid: "k1", ...payload } } }) as unknown as Job;
const txStub = (): ClientBase => ({ query: vi.fn() }) as unknown as ClientBase;
const LIVE = { stripe_subscription_id: "sub_live", cancel_at_period_end: false };

describe("decision 83(a) · billing.cancel_on_deletion handler", () => {
  it("D83A-Q-1 · a pending_deletion workspace with a live Stripe subscription is set to cancel at period end, once", async () => {
    const h = harness({ status: "pending_deletion", subscription: LIVE });
    const setSubscriptionCancelAtPeriodEnd = vi.fn(async () => undefined);
    const outcome = await createBillingCancelOnDeletionHandler(h.context, { gateway: { setSubscriptionCancelAtPeriodEnd } })(txStub(), jobWith());
    expect(outcome).toBe("cancel_scheduled");
    expect(setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledTimes(1);
    expect(setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith({ subscriptionId: "sub_live" });
  });

  it("D83A-Q-2 · a workspace with no subscription, or only the local placeholder, makes no Stripe call", async () => {
    for (const subscription of [undefined, { stripe_subscription_id: `local_sub_${WORKSPACE}`, cancel_at_period_end: false }]) {
      const h = harness({ status: "pending_deletion", ...(subscription !== undefined ? { subscription } : {}) });
      const setSubscriptionCancelAtPeriodEnd = vi.fn(async () => undefined);
      const outcome = await createBillingCancelOnDeletionHandler(h.context, { gateway: { setSubscriptionCancelAtPeriodEnd } })(txStub(), jobWith());
      expect(outcome).toBe("no_subscription");
      expect(setSubscriptionCancelAtPeriodEnd).not.toHaveBeenCalled();
    }
  });

  it("D83A-Q-3 · INVARIANT: a workspace that is no longer pending_deletion is left alone", async () => {
    for (const status of ["active", "suspended", undefined]) {
      const h = harness({ ...(status !== undefined ? { status } : {}), subscription: LIVE });
      const setSubscriptionCancelAtPeriodEnd = vi.fn(async () => undefined);
      const outcome = await createBillingCancelOnDeletionHandler(h.context, { gateway: { setSubscriptionCancelAtPeriodEnd } })(txStub(), jobWith());
      expect(outcome, String(status)).toBe("not_pending_deletion");
      expect(setSubscriptionCancelAtPeriodEnd).not.toHaveBeenCalled();
    }
  });

  it("D83A-Q-4 · a replay after the flag is already set makes no second call (idempotent under at-least-once delivery)", async () => {
    const h = harness({ status: "pending_deletion", subscription: { ...LIVE, cancel_at_period_end: true } });
    const setSubscriptionCancelAtPeriodEnd = vi.fn(async () => undefined);
    const outcome = await createBillingCancelOnDeletionHandler(h.context, { gateway: { setSubscriptionCancelAtPeriodEnd } })(txStub(), jobWith());
    expect(outcome).toBe("already_cancelling");
    expect(setSubscriptionCancelAtPeriodEnd).not.toHaveBeenCalled();
  });

  it("D83A-Q-5 · KAD-06: the tenant transaction is COMMITTED and its connection released BEFORE Stripe is called", async () => {
    const order: string[] = [];
    const h = harness({ status: "pending_deletion", subscription: LIVE }, order);
    const setSubscriptionCancelAtPeriodEnd = vi.fn(async () => {
      order.push("stripe");
    });
    (h.client as unknown as { release: () => void }).release = vi.fn(() => {
      order.push("released");
    });
    await createBillingCancelOnDeletionHandler(h.context, { gateway: { setSubscriptionCancelAtPeriodEnd } })(txStub(), jobWith());
    expect(order.indexOf("stripe")).toBeGreaterThan(order.indexOf("released"));
    expect(order.indexOf("released")).toBeGreaterThan(order.indexOf("COMMIT"));
  });

  it("D83A-Q-6 · the payload is strict: a subscription id (or any unknown key) smuggled into the job is refused and nothing is read or called", async () => {
    const h = harness({ status: "pending_deletion", subscription: LIVE });
    const setSubscriptionCancelAtPeriodEnd = vi.fn(async () => undefined);
    const handler = createBillingCancelOnDeletionHandler(h.context, { gateway: { setSubscriptionCancelAtPeriodEnd } });
    await expect(handler(txStub(), jobWith({ subscriptionId: "sub_attacker" }))).rejects.toThrow();
    expect(setSubscriptionCancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it("D83A-Q-7 · a Stripe failure propagates so the retry ladder sees it", async () => {
    const h = harness({ status: "pending_deletion", subscription: LIVE });
    const setSubscriptionCancelAtPeriodEnd = vi.fn(async () => {
      throw new Error("stripe unavailable");
    });
    await expect(createBillingCancelOnDeletionHandler(h.context, { gateway: { setSubscriptionCancelAtPeriodEnd } })(txStub(), jobWith())).rejects.toThrow(/stripe unavailable/);
  });

  describe("through the real job processor (ISO-11: verify before any context)", () => {
    const entry = topologyFor("billing.cancel_on_deletion");
    const keys = { current: { kid: "k1", key: KEY } };

    it("D83A-Q-8 · a payload redirected to another workspace after signing is rejected before any client is acquired", async () => {
      const h = harness({ status: "pending_deletion", subscription: LIVE });
      const setSubscriptionCancelAtPeriodEnd = vi.fn(async () => undefined);
      const getClient = vi.fn(() => txStub());
      const run = createJobProcessor(entry, { keys, getClient, process: createBillingCancelOnDeletionHandler(h.context, { gateway: { setSubscriptionCancelAtPeriodEnd } }) });
      const job = { data: signQueueJobPayload({ workspaceId: WORKSPACE, kid: "k1" }, KEY) } as unknown as Job;
      (job.data as { payload: { workspaceId: string } }).payload.workspaceId = "22222222-2222-7222-8222-222222222222";
      await expect(run(job)).rejects.toThrow();
      expect(getClient).not.toHaveBeenCalled();
      expect(setSubscriptionCancelAtPeriodEnd).not.toHaveBeenCalled();
    });

    it("D83A-Q-9 · the queue is registered, tenant-scoped, and retried on a ladder long enough to outlast a Stripe outage", () => {
      expect(handlerFor("billing.cancel_on_deletion")).toBeDefined();
      expect(entry).toMatchObject({ workerGroup: "rollup", tenantScoped: true });
      expect(entry.retry.delaysMs.length).toBeGreaterThanOrEqual(5);
    });
  });
});
