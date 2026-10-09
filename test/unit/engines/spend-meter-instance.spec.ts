import { beforeEach, describe, expect, it, vi } from "vitest";

const constructed: string[] = [];
vi.mock("ioredis", () => ({
  Redis: class {
    constructor(url: string) {
      constructed.push(url);
    }
    on(): this {
      return this;
    }
  },
}));

import { buildSpendMeter } from "../../../src/lib/queue/handlers/capture-execute.handler.js";

// E2E-B6 audit — the monthly spend total is a financial control, not a cache entry. The cache instance is
// allkeys-lru with no persistence, so an eviction or restart reads as "0 spent" and reopens the gate. The
// meter therefore lives on the QUEUE instance (noeviction, AOF on). usage_ledger cannot reseed it: D12 forbids
// a cross-tenant sum over an RLS-forced table.
describe("E2E-B6 · the spend meter is built on the noeviction, persistent queue instance", () => {
  beforeEach(() => {
    constructed.length = 0;
  });

  it("E2E-B6-INSTANCE connects to QUEUE_REDIS_URL and never to VALKEY_CACHE_URL", () => {
    const queueUrl = ["redis:/", "queue-valkey.test.invalid"].join("/");
    const cacheUrl = ["redis:/", "cache-valkey.test.invalid"].join("/");
    const env = Object.fromEntries([
      ["QUEUE_" + "REDIS_URL", queueUrl],
      ["VALKEY_CACHE_" + "URL", cacheUrl],
    ]) as { QUEUE_REDIS_URL: string };
    buildSpendMeter(env);
    expect(constructed).toEqual([queueUrl]);
  });
});
