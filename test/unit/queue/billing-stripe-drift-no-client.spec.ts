import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { createBillingStripeDriftHandler } from "../../../src/lib/queue/handlers/billing-stripe-drift.handler.js";
import type { QueueHandlerContext } from "../../../src/lib/queue/handlers.js";
import { createJobProcessor } from "../../../src/lib/queue/worker-factory.js";
import { topologyFor } from "../../../src/lib/queue/topology.js";
import { FakeStripeGateway } from "../../support/fake-stripe-gateway.js";
import { Logger } from "@nestjs/common";

// STORY-075 AC11 - the drift tick must not hold a pooled client for its whole run: it talks to Stripe for minutes.
describe("STORY-075 AC11 · billing.stripe_drift holds no pooled client", () => {
  it("[STORY-075 AC11] the worker factory never acquires a client for it, and a normal non-tenant queue still does", async () => {
    const getClient = vi.fn(() => Promise.resolve({} as never));
    const releaseClient = vi.fn();
    const gateway = new FakeStripeGateway();
    gateway.configured = false;
    const handler = createBillingStripeDriftHandler({ pool: undefined as never, env: { DATABASE_URL: "postgres://x" } } as unknown as QueueHandlerContext, { gateway });
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    await createJobProcessor(topologyFor("billing.stripe_drift"), { keys: { current: { kid: "k1", key: Buffer.alloc(32, 1) } }, getClient, releaseClient, process: handler })({ data: {} } as unknown as Job);
    expect(getClient).not.toHaveBeenCalled();
    expect(releaseClient).not.toHaveBeenCalled();

    const plain = vi.fn(() => Promise.resolve());
    await createJobProcessor(topologyFor("retention.purge"), { keys: { current: { kid: "k1", key: Buffer.alloc(32, 1) } }, getClient, releaseClient, process: plain })({ data: {} } as unknown as Job);
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(releaseClient).toHaveBeenCalledTimes(1);
  });

  it("[STORY-075 AC11] an unconfigured Stripe in production logs at error level", async () => {
    const gateway = new FakeStripeGateway();
    gateway.configured = false;
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const make = (nodeEnv: string) =>
      createBillingStripeDriftHandler({ pool: undefined as never, env: { DATABASE_URL: "postgres://x", NODE_ENV: nodeEnv } } as unknown as QueueHandlerContext, { gateway })(undefined as never, {} as Job);
    await make("production");
    expect(JSON.stringify(error.mock.calls)).toContain("stripe_drift_skipped");
    error.mockClear();
    await make("test");
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
