import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { ClientBase, Pool } from "pg";
import { handlerFor, type QueueHandlerContext } from "../handlers.js";
import { signQueueJobPayload } from "../envelope.js";
import { topologyFor } from "../topology.js";
import { createJobProcessor } from "../worker-factory.js";
import { createBillingCustomerEmailHandler } from "./billing-customer-email.handler.js";

// STORY-021 (ownership transfer) — `billing.customer_email`: re-point the Stripe customer's email at the workspace's
// CURRENT owner. A SIGNED TENANT job; ids only in the payload; the address and customer are read live.

const WORKSPACE = "11111111-1111-7111-8111-111111111111";
const OWNER = "33333333-3333-7333-8333-333333333333";
const STALE = "44444444-4444-7444-8444-444444444444";
const KEY = Buffer.from("billing-customer-email-test-key");

interface Rows {
  owner?: { user_id: string; email: string };
  customer?: string;
}

function harness(rows: Rows, order: string[] = []) {
  const query = vi.fn(async (sql: string) => {
    order.push(sql.trim().split(/\s+/)[0]!.toUpperCase() === "SELECT" && sql.includes("workspace_members") ? "read-owner" : sql.includes("subscriptions") ? "read-customer" : sql.split(/\s+/)[0]!.toUpperCase().slice(0, 12));
    if (sql.includes("workspace_members")) return { rows: rows.owner ? [rows.owner] : [], rowCount: rows.owner ? 1 : 0 };
    if (sql.includes("subscriptions")) return { rows: rows.customer ? [{ stripe_customer_id: rows.customer }] : [], rowCount: rows.customer ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() } as unknown as ClientBase & { release(): void };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  const context = { pool, env: {} as never } satisfies QueueHandlerContext;
  return { context, query, client, order };
}
const jobWith = (payload: Record<string, unknown>): Job => ({ data: { payload: { workspaceId: WORKSPACE, kid: "k1", ownerUserId: OWNER, ...payload } } }) as unknown as Job;
const txStub = (): ClientBase => ({ query: vi.fn() }) as unknown as ClientBase;

describe("STORY-021 · billing.customer_email handler", () => {
  it("S021-Q-1 · points the customer at the CURRENT owner's address, read live — the job carries no address", async () => {
    const h = harness({ owner: { user_id: OWNER, email: "new.owner@example.test" }, customer: "cus_123" });
    const updateCustomerBillingEmail = vi.fn(async () => undefined);
    const outcome = await createBillingCustomerEmailHandler(h.context, { gateway: { updateCustomerBillingEmail } })(txStub(), jobWith({}));
    expect(outcome).toBe("updated");
    expect(updateCustomerBillingEmail).toHaveBeenCalledTimes(1);
    expect(updateCustomerBillingEmail).toHaveBeenCalledWith({ customerId: "cus_123", email: "new.owner@example.test" });
  });

  it("S021-Q-2 · INVARIANT: a job that outlived a SECOND transfer does nothing — the current owner is not the one it was enqueued for", async () => {
    const h = harness({ owner: { user_id: STALE, email: "later.owner@example.test" }, customer: "cus_123" });
    const updateCustomerBillingEmail = vi.fn(async () => undefined);
    const outcome = await createBillingCustomerEmailHandler(h.context, { gateway: { updateCustomerBillingEmail } })(txStub(), jobWith({}));
    expect(outcome).toBe("stale_owner");
    expect(updateCustomerBillingEmail).not.toHaveBeenCalled();
  });

  it("S021-Q-3 · a workspace that has never been to Stripe (local placeholder customer, or none) makes no Stripe call", async () => {
    for (const customer of [`local_cus_${WORKSPACE}`, undefined]) {
      const h = harness({ owner: { user_id: OWNER, email: "o@example.test" }, ...(customer !== undefined ? { customer } : {}) });
      const updateCustomerBillingEmail = vi.fn(async () => undefined);
      const outcome = await createBillingCustomerEmailHandler(h.context, { gateway: { updateCustomerBillingEmail } })(txStub(), jobWith({}));
      expect(outcome, String(customer)).toBe("no_stripe_customer");
      expect(updateCustomerBillingEmail).not.toHaveBeenCalled();
    }
  });

  it("S021-Q-4 · no live owner means no call", async () => {
    const h = harness({ customer: "cus_123" });
    const updateCustomerBillingEmail = vi.fn(async () => undefined);
    expect(await createBillingCustomerEmailHandler(h.context, { gateway: { updateCustomerBillingEmail } })(txStub(), jobWith({}))).toBe("no_owner");
    expect(updateCustomerBillingEmail).not.toHaveBeenCalled();
  });

  it("S021-Q-5 · KAD-06: the tenant transaction is COMMITTED and its connection released BEFORE Stripe is called", async () => {
    const order: string[] = [];
    const h = harness({ owner: { user_id: OWNER, email: "o@example.test" }, customer: "cus_123" }, order);
    const updateCustomerBillingEmail = vi.fn(async () => {
      order.push("stripe");
    });
    (h.client as unknown as { release: () => void }).release = vi.fn(() => {
      order.push("released");
    });
    await createBillingCustomerEmailHandler(h.context, { gateway: { updateCustomerBillingEmail } })(txStub(), jobWith({}));
    expect(order.indexOf("stripe")).toBeGreaterThan(order.indexOf("released"));
    expect(order.indexOf("released")).toBeGreaterThan(order.indexOf("COMMIT"));
  });

  it("S021-Q-6 · the payload is strict: an address (or any unknown key) smuggled into the job is refused and nothing is read or called", async () => {
    const h = harness({ owner: { user_id: OWNER, email: "o@example.test" }, customer: "cus_123" });
    const updateCustomerBillingEmail = vi.fn(async () => undefined);
    const handler = createBillingCustomerEmailHandler(h.context, { gateway: { updateCustomerBillingEmail } });
    await expect(handler(txStub(), jobWith({ email: "attacker@example.test" }))).rejects.toThrow();
    await expect(handler(txStub(), jobWith({ ownerUserId: "not-a-uuid" }))).rejects.toThrow();
    expect(updateCustomerBillingEmail).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it("S021-Q-7 · a Stripe failure propagates so the retry ladder sees it (setting the same email again is a no-op at Stripe)", async () => {
    const h = harness({ owner: { user_id: OWNER, email: "o@example.test" }, customer: "cus_123" });
    const updateCustomerBillingEmail = vi.fn(async () => {
      throw new Error("stripe unavailable");
    });
    await expect(createBillingCustomerEmailHandler(h.context, { gateway: { updateCustomerBillingEmail } })(txStub(), jobWith({}))).rejects.toThrow(/stripe unavailable/);
  });

  describe("through the real job processor (ISO-11: verify before any context)", () => {
    const entry = topologyFor("billing.customer_email");
    const keys = { current: { kid: "k1", key: KEY } };
    const signed = (payload: Record<string, unknown>): Job =>
      ({ data: signQueueJobPayload({ workspaceId: WORKSPACE, kid: "k1", ownerUserId: OWNER, ...payload }, KEY) }) as unknown as Job;

    it("S021-Q-8 · a payload redirected to another workspace after signing is rejected before any client is acquired", async () => {
      const h = harness({ owner: { user_id: OWNER, email: "o@example.test" }, customer: "cus_123" });
      const updateCustomerBillingEmail = vi.fn(async () => undefined);
      const getClient = vi.fn(() => txStub());
      const run = createJobProcessor(entry, { keys, getClient, process: createBillingCustomerEmailHandler(h.context, { gateway: { updateCustomerBillingEmail } }) });
      const job = signed({});
      (job.data as { payload: { workspaceId: string } }).payload.workspaceId = "22222222-2222-7222-8222-222222222222";
      await expect(run(job)).rejects.toThrow();
      expect(getClient).not.toHaveBeenCalled();
      expect(updateCustomerBillingEmail).not.toHaveBeenCalled();
    });

    it("S021-Q-9 · a payload that swaps the owner after signing is rejected (the owner id is under the signature)", async () => {
      const h = harness({ owner: { user_id: STALE, email: "o@example.test" }, customer: "cus_123" });
      const updateCustomerBillingEmail = vi.fn(async () => undefined);
      const getClient = vi.fn(() => txStub());
      const run = createJobProcessor(entry, { keys, getClient, process: createBillingCustomerEmailHandler(h.context, { gateway: { updateCustomerBillingEmail } }) });
      const job = signed({});
      (job.data as { payload: { ownerUserId: string } }).payload.ownerUserId = STALE;
      await expect(run(job)).rejects.toThrow();
      expect(updateCustomerBillingEmail).not.toHaveBeenCalled();
    });

    it("S021-Q-10 · the queue is registered and tenant-scoped", () => {
      expect(handlerFor("billing.customer_email")).toBeDefined();
      expect(entry).toMatchObject({ workerGroup: "rollup", tenantScoped: true });
    });
  });
});
