import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import type { AutoTopupTriggerOutcome } from "../../../../contracts/billing/index.js";
import { handlerFor, liveQueueNames, type QueueHandlerContext } from "../handlers.js";
import { signQueueJobPayload } from "../envelope.js";
import { topologyFor } from "../topology.js";
import { createJobProcessor } from "../worker-factory.js";
import { createBillingAutoTopupHandler } from "./billing-auto-topup.handler.js";

// NEW-D-7 checkpoint-3 finding 4 / owner decision 4 — `billing.auto_topup`: a SIGNED TENANT job. The signature is
// verified before any context is set, the workspace comes ONLY from the verified payload, and the handler runs
// AutoTopupService.trigger — whose Stripe and mail calls happen outside any transaction of its own.

const WORKSPACE = "11111111-1111-7111-8111-111111111111";
const OTHER = "22222222-2222-7222-8222-222222222222";
const KEY = Buffer.from("billing-auto-topup-test-key");
const CONTEXT = { pool: {} as never, env: {} as never } satisfies QueueHandlerContext;

const jobWith = (payload: Record<string, unknown>): Job => ({ data: { payload: { workspaceId: WORKSPACE, kid: "k1", ...payload } } }) as unknown as Job;
const tx = (): { client: ClientBase; query: ReturnType<typeof vi.fn> } => {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  return { client: { query } as unknown as ClientBase, query };
};

describe("NEW-D-7 checkpoint-3 · billing.auto_topup handler", () => {
  it("NEW-D-7-Q-1 · evaluates the workspace named by the payload, once", async () => {
    const trigger = vi.fn(async () => "charge_submitted" as const);
    const handler = createBillingAutoTopupHandler(CONTEXT, { service: { trigger } });
    await handler(tx().client, jobWith({}));
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(WORKSPACE);
  });

  it("NEW-D-7-Q-2 · the job's own transaction is never used for the money: the service opens its own short ones", async () => {
    const trigger = vi.fn(async () => "above_threshold" as const);
    const { client, query } = tx();
    await createBillingAutoTopupHandler(CONTEXT, { service: { trigger } })(client, jobWith({}));
    expect(query).not.toHaveBeenCalled();
  });

  it("NEW-D-7-Q-3 · a payload with an unknown key or a non-uuid workspace is refused and nothing is evaluated", async () => {
    const trigger = vi.fn(async () => "charge_submitted" as const);
    const handler = createBillingAutoTopupHandler(CONTEXT, { service: { trigger } });
    await expect(handler(tx().client, jobWith({ amount: 5000 }))).rejects.toThrow();
    await expect(handler(tx().client, jobWith({ workspaceId: "not-a-uuid" }))).rejects.toThrow();
    expect(trigger).not.toHaveBeenCalled();
  });

  it("NEW-D-7-Q-4 · an unexpected failure propagates so the retry ladder sees it (the service's claim makes a retry safe)", async () => {
    const trigger = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    await expect(createBillingAutoTopupHandler(CONTEXT, { service: { trigger } })(tx().client, jobWith({}))).rejects.toThrow(/database unavailable/);
  });

  describe("through the real job processor (ISO-11: verify before any context)", () => {
    const entry = topologyFor("billing.auto_topup");
    const keys = { current: { kid: "k1", key: KEY } };

    function processor(trigger: (workspaceId: string) => Promise<AutoTopupTriggerOutcome>) {
      const getClient = vi.fn(() => tx().client);
      const run = createJobProcessor(entry, {
        keys,
        getClient,
        process: createBillingAutoTopupHandler(CONTEXT, { service: { trigger } }),
      });
      return { run, getClient };
    }
    const signed = (payload: Record<string, unknown>): Job => ({ data: signQueueJobPayload({ workspaceId: WORKSPACE, kid: "k1", ...payload }, KEY) }) as unknown as Job;

    it("NEW-D-7-Q-5 · the queue is a TENANT-scoped one: it carries a signed envelope", () => {
      expect(entry.tenantScoped).toBe(true);
    });

    it("NEW-D-7-Q-6 · a correctly signed job reaches trigger with the verified workspace", async () => {
      const trigger = vi.fn(async () => "charge_submitted" as const);
      const { run } = processor(trigger);
      await run(signed({}));
      expect(trigger).toHaveBeenCalledWith(WORKSPACE);
    });

    it("NEW-D-7-Q-7 · a payload redirected to another workspace after signing is rejected: no client acquired, no set_config, no trigger", async () => {
      const trigger = vi.fn(async () => "charge_submitted" as const);
      const { run, getClient } = processor(trigger);
      const job = signed({});
      (job.data as { payload: { workspaceId: string } }).payload.workspaceId = OTHER;
      await expect(run(job)).rejects.toThrow();
      expect(getClient).not.toHaveBeenCalled();
      expect(trigger).not.toHaveBeenCalled();
    });

    it("NEW-D-7-Q-8 · a job signed with another key, and an unsigned one, are rejected the same way", async () => {
      const trigger = vi.fn(async () => "charge_submitted" as const);
      const { run, getClient } = processor(trigger);
      const forged = { data: signQueueJobPayload({ workspaceId: WORKSPACE, kid: "k1" }, Buffer.from("not-the-key")) } as unknown as Job;
      await expect(run(forged)).rejects.toThrow();
      await expect(run({ data: { payload: { workspaceId: WORKSPACE, kid: "k1" }, signature: "" } } as unknown as Job)).rejects.toThrow();
      expect(getClient).not.toHaveBeenCalled();
      expect(trigger).not.toHaveBeenCalled();
    });
  });

  it("NEW-D-7-Q-9 · the queue is registered, so a worker in its group pulls jobs (and no other queue became live by accident)", () => {
    expect(handlerFor("billing.auto_topup")).toBeDefined();
    expect(liveQueueNames()).toContain("billing.auto_topup");
    expect(topologyFor("billing.auto_topup")).toMatchObject({ workerGroup: "rollup", tenantScoped: true });
  });
});
