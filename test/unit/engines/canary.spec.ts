import { describe, expect, it } from "vitest";
import { CANARY_INTERVAL_MS, EngineCanary, type CanaryDueStore } from "../../../src/lib/engines/canary.js";
import { ACTIVE_ENGINE_KEYS } from "../../../src/lib/engines/registry.js";
import type { EngineKey } from "../../../src/lib/engines/contract.js";

// STORY-031 Phase F — EC-06: "a per-engine synthetic canary every 5 minutes
// independent of customer load". Fake clock, in-memory due-store — no real
// timer, no I/O — proving the pure due/tick decision: every engine probed
// once per 5-minute tick, and not again before the next one.

class InMemoryDueStore implements CanaryDueStore {
  private lastProbedAtMs: number | null = null;
  async read(): Promise<number | null> {
    return this.lastProbedAtMs;
  }
  async write(atMs: number): Promise<void> {
    this.lastProbedAtMs = atMs;
  }
}

describe("STORY-031 · EngineCanary — every engine probed once per 5-minute tick, zero customer jobs involved", () => {
  it("EC-06's exact interval is 5 minutes", () => {
    expect(CANARY_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it("the first call is always due and probes every active engine exactly once", async () => {
    const nowRef = { now: 0 };
    const probed: EngineKey[] = [];
    const canary = new EngineCanary(
      ACTIVE_ENGINE_KEYS,
      async (engineKey) => {
        probed.push(engineKey);
        return { ok: true, latencyMs: 10 };
      },
      () => undefined,
      new InMemoryDueStore(),
      CANARY_INTERVAL_MS,
      () => nowRef.now,
    );

    const ran = await canary.probeAllIfDue();
    expect(ran).toBe(true);
    expect(probed.sort()).toEqual([...ACTIVE_ENGINE_KEYS].sort());
    expect(probed).toHaveLength(6);
  });

  it("a second call before 5 minutes have elapsed does nothing — no customer traffic needed to prove this", async () => {
    const nowRef = { now: 0 };
    let probeCount = 0;
    const canary = new EngineCanary(
      ACTIVE_ENGINE_KEYS,
      async () => {
        probeCount += 1;
        return { ok: true, latencyMs: 10 };
      },
      () => undefined,
      new InMemoryDueStore(),
      CANARY_INTERVAL_MS,
      () => nowRef.now,
    );

    await canary.probeAllIfDue();
    expect(probeCount).toBe(6);

    nowRef.now += CANARY_INTERVAL_MS - 1;
    const ranAgainTooSoon = await canary.probeAllIfDue();
    expect(ranAgainTooSoon).toBe(false);
    expect(probeCount).toBe(6); // unchanged
  });

  it("exactly at the 5-minute mark, a new round runs — every engine probed again, once each", async () => {
    const nowRef = { now: 0 };
    let probeCount = 0;
    const canary = new EngineCanary(
      ACTIVE_ENGINE_KEYS,
      async () => {
        probeCount += 1;
        return { ok: true, latencyMs: 10 };
      },
      () => undefined,
      new InMemoryDueStore(),
      CANARY_INTERVAL_MS,
      () => nowRef.now,
    );

    await canary.probeAllIfDue();
    expect(probeCount).toBe(6);

    nowRef.now += CANARY_INTERVAL_MS;
    const ran = await canary.probeAllIfDue();
    expect(ran).toBe(true);
    expect(probeCount).toBe(12);
  });

  it("reports every probe result via onResult, ok and failing alike — a probe failure is not swallowed", async () => {
    const nowRef = { now: 0 };
    const results: Array<{ engineKey: EngineKey; ok: boolean }> = [];
    const canary = new EngineCanary(
      ["chatgpt", "claude"],
      async (engineKey) => (engineKey === "chatgpt" ? { ok: false, latencyMs: 5, detail: "blocked" } : { ok: true, latencyMs: 8 }),
      (engineKey, result) => {
        results.push({ engineKey, ok: result.ok });
      },
      new InMemoryDueStore(),
      CANARY_INTERVAL_MS,
      () => nowRef.now,
    );

    await canary.probeAllIfDue();
    expect(results).toEqual([
      { engineKey: "chatgpt", ok: false },
      { engineKey: "claude", ok: true },
    ]);
  });

  it("zero engines enabled — probeAllIfDue runs a due round with no probes and no error", async () => {
    const canary = new EngineCanary([], async () => ({ ok: true, latencyMs: 1 }), () => undefined, new InMemoryDueStore());
    const ran = await canary.probeAllIfDue();
    expect(ran).toBe(true);
  });
});

describe("STORY-031 Phase J · EngineCanary — D19's spirit extended: a due-store read failure fails OPEN (still runs the round) rather than silently disabling detection", () => {
  class FailingDueStore implements CanaryDueStore {
    async read(): Promise<number | null> {
      throw new Error("cache instance unreachable");
    }
    async write(): Promise<void> {
      throw new Error("cache instance unreachable");
    }
  }

  it("probeAllIfDue never throws and still probes every engine when the due-store is unreadable", async () => {
    const probed: EngineKey[] = [];
    const canary = new EngineCanary(
      ["chatgpt", "claude"],
      async (engineKey) => {
        probed.push(engineKey);
        return { ok: true, latencyMs: 1 };
      },
      () => undefined,
      new FailingDueStore(),
    );

    const ran = await canary.probeAllIfDue();
    expect(ran).toBe(true);
    expect(probed.sort()).toEqual(["chatgpt", "claude"]);
  });
});
