import { describe, expect, it, vi } from "vitest";
import { BILLING_WRITE_POOL_MAX, BILLING_WRITE_CONNECT_TIMEOUT_MS, connectForWrite, createBillingWritePool } from "./billing-write-pool.js";

// STORY-075a / STORY-076a / STORY-076b checkpoint-4 — the small, bounded pool a billing request uses for its short independent writes, so
// the holder of a main-pool connection never waits on the main pool.

const counter = vi.hoisted(() => vi.fn((..._args: unknown[]) => undefined));
vi.mock("../../lib/telemetry/metrics.js", () => ({ incrementCounter: counter }));

describe("STORY-076b checkpoint-4 · billing write pool", () => {
  it("AC-pool-bounds . is a separate, small pool with a real connection timeout (it can never wait forever)", async () => {
    const pool = createBillingWritePool("postgres://u:p@localhost:1/db");
    try {
      const options = (pool as unknown as { options: { max: number; connectionTimeoutMillis: number } }).options;
      expect(options.max).toBe(BILLING_WRITE_POOL_MAX);
      expect(options.connectionTimeoutMillis).toBe(BILLING_WRITE_CONNECT_TIMEOUT_MS);
      expect(BILLING_WRITE_POOL_MAX).toBeLessThan(10); // the main pool's default max
      expect(BILLING_WRITE_CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  it("AC-pool-timeout . a connection that cannot be had in time is a retryable 503 `degraded` (never a hang or a 500), counted, with no connection text", async () => {
    const starved = { connect: () => Promise.reject(new Error("timeout exceeded when trying to connect to postgres://u:secret@host/db")) } as never;
    const err = await connectForWrite(starved).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "degraded" });
    expect(JSON.stringify(err)).not.toContain("secret");
    expect(counter).toHaveBeenCalledWith("nominara_billing_write_pool_timeout_total", {});
  });

  it("AC-pool-timeout . a connection that is available is returned as it is", async () => {
    const client = { release: () => undefined };
    expect(await connectForWrite({ connect: () => Promise.resolve(client) } as never)).toBe(client);
  });
});
