import { describe, expect, it, vi } from "vitest";
import { CanaryRuntime } from "../../../src/lib/engines/canary-runtime.js";

// STORY-031 Phase F — src/worker.ts wires this ONLY for WORKER_GROUP ===
// "capture". A fake pool/redis proves the orchestration (borrow a client,
// BEGIN/COMMIT around the elected round, release) without needing real
// infra — test/integration/canary-runtime-wiring.spec.ts proves the real
// Postgres/Valkey path separately.

function fakePool() {
  const client = {
    query: vi.fn(async (_sql: string) => ({ rows: [] as unknown[], rowCount: 0 })),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) }, client };
}

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    defineCommand: vi.fn(),
  };
}

describe("STORY-031 · CanaryRuntime — orchestrates borrow/BEGIN/elect/COMMIT/release on every tick", () => {
  it("a tick BEGINs, runs the elected round, COMMITs, and releases the client back to the pool", async () => {
    const { pool, client } = fakePool();
    const redis = fakeRedis();

    const runtime = new CanaryRuntime({
      pool: pool as never,
      cacheRedis: redis as never,
      engines: ["chatgpt"],
    });

    await runtime.tick();

    const queries = client.query.mock.calls.map((call) => String(call[0]));
    expect(queries[0]).toMatch(/BEGIN/i);
    expect(queries[queries.length - 1]).toMatch(/COMMIT/i);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("a tick that throws still releases the client — never leaks a pool connection", async () => {
    const { pool, client } = fakePool();
    client.query.mockImplementation(async (sql: string) => {
      if (/BEGIN/i.test(sql)) throw new Error("boom");
      return { rows: [], rowCount: 0 };
    });
    const redis = fakeRedis();

    const runtime = new CanaryRuntime({ pool: pool as never, cacheRedis: redis as never, engines: ["chatgpt"] });

    await expect(runtime.tick()).resolves.toBeUndefined(); // never throws — best-effort, must never crash the worker
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("start() schedules tick() on pollIntervalMs; stop() clears it — no further ticks after stopping", async () => {
    vi.useFakeTimers();
    try {
      const { pool } = fakePool();
      const redis = fakeRedis();
      const runtime = new CanaryRuntime({ pool: pool as never, cacheRedis: redis as never, engines: ["chatgpt"], pollIntervalMs: 1000 });
      const tickSpy = vi.spyOn(runtime, "tick").mockResolvedValue(undefined);

      runtime.start();
      await vi.advanceTimersByTimeAsync(3500);
      expect(tickSpy).toHaveBeenCalledTimes(3);

      runtime.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(tickSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
