import { describe, expect, it, vi } from "vitest";
import { BLACKOUT_THRESHOLD_MS } from "../../../src/lib/engines/blackout.js";
import type { EngineKey } from "../../../src/lib/engines/contract.js";
import { DLQ_DEPTH_SUSTAINED_MS, type Pager } from "../../../src/lib/queue/dead-letter.js";
import { MonitorRuntime, type MonitorState, type MonitorStateStore } from "../../../src/lib/queue/monitor-runtime.js";
import { QUEUE_TOPOLOGY } from "../../../src/lib/queue/topology.js";

// STORY-179 — the elected periodic driver. Pool and Valkey are faked; test/integration/monitor-runtime-election.spec.ts
// proves the real advisory-lock election.

function fakePool() {
  // The election is pg_try_advisory_xact_lock, which answers { locked } — granted by default.
  const client = {
    query: vi.fn(async (sql: string, _params?: unknown[]) => ({
      rows: (/pg_try_advisory_xact_lock/.test(sql) ? [{ locked: true }] : []) as unknown[],
      rowCount: 0,
    })),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) }, client };
}

function memoryStore(initial: MonitorState | null = null) {
  let state = initial;
  const store: MonitorStateStore = {
    load: vi.fn(async () => state),
    save: vi.fn(async (next: MonitorState) => {
      state = next;
    }),
  };
  return { store, current: () => state };
}

function harness(options: { oldestAges?: () => Promise<ReadonlyMap<string, number | null>>; depths?: () => Promise<ReadonlyMap<string, number>>; lastSuccess?: (engines: readonly EngineKey[], db?: unknown) => Promise<ReadonlyMap<EngineKey, number | null>>; store?: MonitorStateStore } = {}) {
  const { pool, client } = fakePool();
  const nowRef = { now: 1_000_000_000 };
  const pages: Array<Record<string, unknown>> = [];
  const pager: Pager = { page: (_m, context) => void pages.push(context) };
  const depth = { value: 0 };
  const mem = memoryStore();
  const runtime = new MonitorRuntime({
    pool: pool as never,
    store: options.store ?? mem.store,
    readDlqDepths: options.depths ?? (async () => new Map(QUEUE_TOPOLOGY.map((entry) => [entry.name, entry.name === "capture.execute" ? depth.value : 0]))),
    readLastSuccess: options.lastSuccess ?? (async () => new Map([["chatgpt", nowRef.now]])),
    ...(options.oldestAges ? { readOldestAges: options.oldestAges } : {}),
    engines: ["chatgpt"],
    pager,
    clock: () => nowRef.now,
  });
  return { runtime, client, nowRef, pages, depth, mem };
}

describe("STORY-179 AC5 · DLQ depth through the driver", () => {
  it("a depth held above 50 for 10 minutes pages once, with the existing alert name, and not again while it stays", async () => {
    const h = harness();
    h.depth.value = 60;
    await h.runtime.tick();
    expect(h.pages).toHaveLength(0);
    h.nowRef.now += DLQ_DEPTH_SUSTAINED_MS;
    await h.runtime.tick();
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toMatchObject({ alertName: "dlq_depth_sustained", queue: "capture.execute", depth: 60 });
    h.nowRef.now += 60_000;
    await h.runtime.tick();
    expect(h.pages).toHaveLength(1);
  });

  it("a short spike that recovers before the window does not page, and a later breach pages again", async () => {
    const h = harness();
    h.depth.value = 500;
    await h.runtime.tick();
    h.nowRef.now += DLQ_DEPTH_SUSTAINED_MS - 1;
    h.depth.value = 3;
    await h.runtime.tick();
    h.nowRef.now += DLQ_DEPTH_SUSTAINED_MS * 2;
    await h.runtime.tick();
    expect(h.pages).toHaveLength(0);

    h.depth.value = 60;
    await h.runtime.tick();
    h.nowRef.now += DLQ_DEPTH_SUSTAINED_MS;
    await h.runtime.tick();
    expect(h.pages).toHaveLength(1);
    h.depth.value = 0;
    await h.runtime.tick();
    h.depth.value = 60;
    await h.runtime.tick();
    h.nowRef.now += DLQ_DEPTH_SUSTAINED_MS;
    await h.runtime.tick();
    expect(h.pages).toHaveLength(2);
  });

  it("a failed depth read is not a depth of 0: the open window survives it", async () => {
    let fail = false;
    const depth = { value: 60 };
    const h = harness({
      depths: async () => {
        if (fail) throw new Error("valkey down");
        return new Map([["capture.execute", depth.value]]);
      },
    });
    await h.runtime.tick();
    fail = true;
    h.nowRef.now += DLQ_DEPTH_SUSTAINED_MS / 2;
    await expect(h.runtime.tick()).resolves.toBeUndefined();
    fail = false;
    h.nowRef.now += DLQ_DEPTH_SUSTAINED_MS / 2;
    await h.runtime.tick();
    expect(h.pages).toHaveLength(1);
  });
});

describe("STORY-179 AC5 · engine blackout through the driver", () => {
  it("an engine whose last success is over 48h old pages once, then respects the cooldown across ticks", async () => {
    const h = harness({ lastSuccess: async () => new Map([["chatgpt", 1_000_000_000 - BLACKOUT_THRESHOLD_MS - 1]]) });
    await h.runtime.tick();
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toMatchObject({ alertName: "engine_blackout", engineKey: "chatgpt" });
    h.nowRef.now += 60_000;
    await h.runtime.tick();
    expect(h.pages).toHaveLength(1);
  });

  it("an engine with no engine_health row (null) does not page on the first look", async () => {
    const h = harness({ lastSuccess: async () => new Map([["chatgpt", null]]) });
    await h.runtime.tick();
    expect(h.pages).toHaveLength(0);
  });
});

describe("STORY-179 AC3 · tick lifecycle and failure handling", () => {
  it("elects under a transaction-scoped advisory lock: BEGIN, lock, COMMIT, release", async () => {
    const h = harness();
    await h.runtime.tick();
    const sql = h.client.query.mock.calls.map((c) => String(c[0]));
    expect(sql[0]).toMatch(/BEGIN/i);
    expect(sql[1]).toMatch(/pg_try_advisory_xact_lock/);
    expect(h.client.query.mock.calls[1]![1]![0]).toBe("queue-lock:monitor.driver:global");
    expect(sql[sql.length - 1]).toMatch(/COMMIT/i);
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });

  it("state is loaded AFTER the lock and saved before COMMIT", async () => {
    const order: string[] = [];
    const h = harness({
      store: {
        load: async () => (order.push("load"), null),
        save: async () => void order.push("save"),
      },
    });
    h.client.query.mockImplementation(async (sql: string) => {
      const isLock = /pg_try_advisory/.test(sql);
      order.push(isLock ? "lock" : sql.trim().split(/\s/)[0]!);
      return { rows: isLock ? [{ locked: true }] : [], rowCount: 0 };
    });
    await h.runtime.tick();
    expect(order).toEqual(["BEGIN", "lock", "load", "save", "COMMIT"]);
  });

  it("a state-store outage skips the tick: nothing is observed, nothing pages, nothing throws, the client is released", async () => {
    const depths = vi.fn(async () => new Map([["capture.execute", 999]]));
    const h = harness({
      depths,
      store: { load: async () => { throw new Error("valkey down"); }, save: async () => undefined },
    });
    await expect(h.runtime.tick()).resolves.toBeUndefined();
    expect(depths).not.toHaveBeenCalled();
    expect(h.client.release).toHaveBeenCalledTimes(1);
    expect(h.client.query.mock.calls.map((c) => String(c[0])).at(-1)).toMatch(/ROLLBACK|COMMIT/);
  });

  it("a pool outage is a skipped tick, never a throw", async () => {
    const h = harness();
    (h.runtime as unknown as { pool: { connect: () => Promise<never> } }).pool = { connect: async () => { throw new Error("pool down"); } };
    await expect(h.runtime.tick()).resolves.toBeUndefined();
  });

  it("STORY-179 review · a lost election is a skipped tick: no state load, no reads, no page, rolled back, released", async () => {
    const depths = vi.fn(async () => new Map([["capture.execute", 999]]));
    const lastSuccess = vi.fn(async () => new Map<EngineKey, number | null>());
    const mem = memoryStore();
    const h = harness({ depths, lastSuccess, store: mem.store });
    h.client.query.mockImplementation(async (sql: string) => ({ rows: /pg_try_advisory_xact_lock/.test(sql) ? [{ locked: false }] : [], rowCount: 0 }));
    await h.runtime.tick();
    expect(mem.store.load).not.toHaveBeenCalled();
    expect(depths).not.toHaveBeenCalled();
    expect(lastSuccess).not.toHaveBeenCalled();
    expect(h.client.query.mock.calls.map((c) => String(c[0])).at(-1)).toMatch(/ROLLBACK|COMMIT/);
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });

  it("STORY-030 review · only the replica that wins the election reads and emits the age, so the series is not duplicated per replica", async () => {
    const oldestAges = vi.fn(async () => new Map<string, number | null>([["lookup.execute", 4]]));
    const h = harness({ oldestAges });
    h.client.query.mockImplementation(async (sql: string) => ({ rows: /pg_try_advisory_xact_lock/.test(sql) ? [{ locked: false }] : [], rowCount: 0 }));
    await h.runtime.tick();
    expect(oldestAges).not.toHaveBeenCalled();
  });

  it("STORY-179 review · a tick that starts while the previous one is still running does not check out a pool connection", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness({ depths: async () => (await gate, new Map()) });
    const first = h.runtime.tick();
    await vi.waitFor(() => expect((h.runtime as unknown as { pool: { connect: ReturnType<typeof vi.fn> } }).pool.connect).toHaveBeenCalledTimes(1));
    await h.runtime.tick();
    await h.runtime.tick();
    expect((h.runtime as unknown as { pool: { connect: ReturnType<typeof vi.fn> } }).pool.connect).toHaveBeenCalledTimes(1);
    release();
    await first;
    await h.runtime.tick();
    expect((h.runtime as unknown as { pool: { connect: ReturnType<typeof vi.fn> } }).pool.connect).toHaveBeenCalledTimes(2);
  });

  it("STORY-179 review · the engine_health read runs on the locked client, so one tick holds one pool connection", async () => {
    const seen: unknown[] = [];
    const h = harness({ lastSuccess: async (_engines, db) => (seen.push(db), new Map<EngineKey, number | null>()) });
    await h.runtime.tick();
    expect(seen).toEqual([h.client]);
  });

  it("start() ticks on the interval and stop() ends it", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const spy = vi.spyOn(h.runtime, "tick").mockResolvedValue(undefined);
      h.runtime.start();
      await vi.advanceTimersByTimeAsync(60_000 * 3 + 10);
      expect(spy).toHaveBeenCalledTimes(3);
      h.runtime.stop();
      await vi.advanceTimersByTimeAsync(60_000 * 3);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("STORY-030 AC8 · the oldest-job-age signal rides the same tick", () => {
  async function metricLines(run: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
    const { Logger } = await import("@nestjs/common");
    const lines: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
      if (typeof message === "object" && message !== null && (message as { metric?: string }).metric === "nominara_queue_oldest_job_age_seconds") {
        lines.push(message as Record<string, unknown>);
      }
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return lines;
  }

  it("logs one structured line per queue per tick, with the queue name and no job data", async () => {
    const h = harness({ oldestAges: async () => new Map([["lookup.execute", 4]]) });
    const lines = await metricLines(() => h.runtime.tick());
    expect(lines).toEqual([{ metric: "nominara_queue_oldest_job_age_seconds", value: 4, queue: "lookup.execute" }]);
  });

  it("an empty queue is logged as value 0 flagged empty, so an autoscaler reads 'no wait' and a reader can still tell it from a real 0s", async () => {
    const h = harness({ oldestAges: async () => new Map([["lookup.execute", null]]) });
    const lines = await metricLines(() => h.runtime.tick());
    expect(lines).toEqual([{ metric: "nominara_queue_oldest_job_age_seconds", value: 0, queue: "lookup.execute", empty: true }]);
  });

  it("an unreadable age emits no line (absent is not 0), does not stop the monitors, and the tick is partial", async () => {
    const h = harness({ oldestAges: async () => { throw new Error("valkey down"); } });
    h.depth.value = 60;
    const lines = await metricLines(async () => {
      await h.runtime.tick();
      h.nowRef.now += DLQ_DEPTH_SUSTAINED_MS;
      await h.runtime.tick();
    });
    expect(lines).toEqual([]);
    expect(h.pages).toHaveLength(1);
  });
});
