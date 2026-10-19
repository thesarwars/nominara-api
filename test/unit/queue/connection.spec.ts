import { describe, expect, it } from "vitest";
import { createQueueMonitorConnection, queueKeyPrefix } from "../../../src/lib/queue/connection.js";
import { DEAD_VALKEY_URL } from "../../support/test-valkey.js";

// STORY-030 Phase B — Phase A decision D7: BullMQ's own `prefix` option
// namespaces the whole queue instance per NODE_ENV, so `development`,
// `test`, and `production` processes never collide when pointed at the same
// Valkey deployment.
describe("STORY-030 · queueKeyPrefix", () => {
  it.each(["development", "test", "production"])("derives a distinct, deterministic prefix for NODE_ENV=%s", (nodeEnv) => {
    expect(queueKeyPrefix(nodeEnv)).toBe(`nominara-queue-${nodeEnv}`);
  });

  it("never collides across environments", () => {
    const prefixes = new Set(["development", "test", "production"].map((env) => queueKeyPrefix(env)));
    expect(prefixes.size).toBe(3);
  });
});

// STORY-179 review — the monitor driver runs for the life of the process, so its connection must keep reconnecting. The
// reader factory gives up after one retry (right for a boot-time read) and ioredis then leaves it closed for good.
describe("STORY-179 · createQueueMonitorConnection", () => {
  it("never gives up reconnecting, backs off to a bounded delay, and still fails each command fast", () => {
    const connection = createQueueMonitorConnection(DEAD_VALKEY_URL);
    try {
      const strategy = connection.options.retryStrategy!;
      for (const attempt of [1, 2, 3, 10, 1_000, 1_000_000]) {
        const delay = strategy(attempt);
        expect(delay, `attempt ${String(attempt)} must keep retrying`).toBeTypeOf("number");
        expect(delay as number).toBeLessThanOrEqual(5_000);
      }
      expect(connection.options.maxRetriesPerRequest).toBe(1);
      expect(connection.options.lazyConnect).toBe(true);
      expect(connection.options.commandTimeout).toBeGreaterThan(0);
    } finally {
      connection.disconnect();
    }
  });
});
