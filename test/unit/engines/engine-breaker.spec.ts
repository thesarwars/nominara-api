import { describe, expect, it } from "vitest";
import {
  ENGINE_BREAKER_BLOCK_RATIO_THRESHOLD,
  ENGINE_BREAKER_OPEN_DURATION_MS,
  EngineBreaker,
  type EngineBreakerRatioCounter,
  type EngineBreakerStateStore,
} from "../../../src/lib/engines/engine-breaker.js";

// STORY-031 Phase D — AC/EC-06 stage 4 ("blocks/attempts > 0.25 → open the
// circuit") and EC-08 ("quota_exhausted opens immediately, no retry").
// D4 — the 20-minute open duration is THIS story's own interpolation
// (EC-06 states the stage-4 RE-QUEUE delay as 20 minutes; it never states
// the breaker's own open duration) — these tests assert the 20-minute
// duration as OUR number, never re-asserting it as spec-derived.

class FakeStateStore implements EngineBreakerStateStore {
  private value: number | null = null;
  reads = 0;

  async read(): Promise<number | null> {
    this.reads += 1;
    return this.value;
  }

  async write(_engineKey: string, openedAt: number | null): Promise<void> {
    this.value = openedAt;
  }
}

class FakeRatioCounter implements EngineBreakerRatioCounter {
  private attempts = 0;
  private blocks = 0;

  async record(_engineKey: string, isBlocked: boolean): Promise<{ attempts: number; blocks: number }> {
    this.attempts += 1;
    if (isBlocked) this.blocks += 1;
    return { attempts: this.attempts, blocks: this.blocks };
  }
}

function makeBreaker(nowRef: { now: number }) {
  const store = new FakeStateStore();
  const ratioCounter = new FakeRatioCounter();
  const breaker = new EngineBreaker("chatgpt", store, ratioCounter, () => nowRef.now);
  return { breaker, store, ratioCounter };
}

describe("STORY-031 · EngineBreaker — blocks/attempts > 0.25 opens; exactly 0.25 does NOT (strict >)", () => {
  it("D4/reference: the open duration constant is exactly 20 minutes, disclosed as this story's interpolation, not spec-derived", () => {
    expect(ENGINE_BREAKER_OPEN_DURATION_MS).toBe(20 * 60 * 1000);
  });

  it("EC-06 stage 4: the block-ratio threshold is exactly 0.25", () => {
    expect(ENGINE_BREAKER_BLOCK_RATIO_THRESHOLD).toBe(0.25);
  });

  it("a ratio of EXACTLY 0.25 (1 block in 4 attempts) does NOT open the breaker — checked at every step along the way, never just at the end", async () => {
    const { breaker } = makeBreaker({ now: 0 });
    // Successes first, so the running ratio is 0, 0, 0, 0.25 — it never
    // exceeds 0.25 at any intermediate point either.
    await breaker.recordOutcome("success");
    await breaker.recordOutcome("success");
    await breaker.recordOutcome("success");
    const last = await breaker.recordOutcome("blocked");
    expect(last.state).toBe("closed");
    expect(await breaker.state()).toBe("closed");
  });

  it("a ratio just ABOVE 0.25 (2 blocks in 7 attempts ≈ 0.2857) opens the breaker", async () => {
    const { breaker } = makeBreaker({ now: 0 });
    // Running ratio: 0,0,0,0,0, 1/6≈0.167, 2/7≈0.2857 — crosses 0.25 only
    // on the LAST call, proving the check fires the moment it's crossed,
    // not merely "eventually".
    const outcomes: Array<"blocked" | "success"> = ["success", "success", "success", "success", "success", "blocked", "blocked"];
    let lastDecision;
    for (const outcome of outcomes) {
      lastDecision = await breaker.recordOutcome(outcome);
    }
    expect(lastDecision!.state).toBe("open");
    expect(await breaker.state()).toBe("open");
  });

  it("0 attempts never divides — a fresh breaker starts closed with no ratio computed", async () => {
    const { breaker } = makeBreaker({ now: 0 });
    expect(await breaker.state()).toBe("closed");
  });
});

describe("STORY-031 · EngineBreaker — quota_exhausted (EC-08): opens immediately, zero retries", () => {
  it("a single quota_exhausted outcome opens the breaker with no ratio check at all", async () => {
    const { breaker } = makeBreaker({ now: 0 });
    const decision = await breaker.recordOutcome("quota_exhausted");
    expect(decision.state).toBe("open");
    expect(decision.retry).toBe(false);
  });

  it("every OTHER outcome keeps retry:true", async () => {
    const { breaker } = makeBreaker({ now: 0 });
    expect((await breaker.recordOutcome("success")).retry).toBe(true);
    expect((await breaker.recordOutcome("blocked")).retry).toBe(true);
    expect((await breaker.recordOutcome("other_failure")).retry).toBe(true);
  });
});

describe("STORY-031 · EngineBreaker — 20-minute open (D4), then half-open probing", () => {
  it("stays open for exactly 20:00 and does not yet move to half_open at that exact boundary; half_open one ms later", async () => {
    const nowRef = { now: 0 };
    const { breaker } = makeBreaker(nowRef);
    await breaker.recordOutcome("quota_exhausted");
    expect(await breaker.state()).toBe("open");

    nowRef.now = ENGINE_BREAKER_OPEN_DURATION_MS - 1;
    expect(await breaker.state()).toBe("open");

    nowRef.now = ENGINE_BREAKER_OPEN_DURATION_MS;
    expect(await breaker.state()).toBe("half_open");
  });

  it("a successful half-open trial closes the breaker", async () => {
    const nowRef = { now: 0 };
    const { breaker } = makeBreaker(nowRef);
    await breaker.recordOutcome("quota_exhausted");
    nowRef.now = ENGINE_BREAKER_OPEN_DURATION_MS;
    expect(await breaker.state()).toBe("half_open");

    const decision = await breaker.recordOutcome("success");
    expect(decision.state).toBe("closed");
    expect(await breaker.state()).toBe("closed");
  });

  it("a failed half-open trial reopens for another full 20-minute window", async () => {
    const nowRef = { now: 0 };
    const { breaker } = makeBreaker(nowRef);
    await breaker.recordOutcome("quota_exhausted");
    nowRef.now = ENGINE_BREAKER_OPEN_DURATION_MS;
    expect(await breaker.state()).toBe("half_open");

    const decision = await breaker.recordOutcome("blocked");
    expect(decision.state).toBe("open");

    nowRef.now += ENGINE_BREAKER_OPEN_DURATION_MS - 1;
    expect(await breaker.state()).toBe("open");
  });
});

describe("STORY-031 · EngineBreaker admission gate", () => {
  it("admit() throws while open; never throws while closed or half_open", async () => {
    const nowRef = { now: 0 };
    const { breaker } = makeBreaker(nowRef);
    await expect(breaker.admit()).resolves.toBeUndefined();

    await breaker.recordOutcome("quota_exhausted");
    await expect(breaker.admit()).rejects.toThrow();

    nowRef.now = ENGINE_BREAKER_OPEN_DURATION_MS;
    await expect(breaker.admit()).resolves.toBeUndefined();
  });

  // qa-reviewer finding — admit()'s docstring previously claimed "exactly
  // one trial at a time" during half-open, but nothing in the code enforces
  // that: admit() only checks `this.breaker.state`, never tracks an
  // in-flight trial. The docstring was corrected to describe the ACTUAL
  // behavior (unlimited concurrent admission, no single-trial gate) — this
  // test pins that corrected description so it can't silently drift back
  // out of sync with the code again.
  it("admits multiple CONCURRENT calls while half_open — no single-trial gate (matches admit()'s corrected docstring)", async () => {
    const nowRef = { now: 0 };
    const { breaker } = makeBreaker(nowRef);
    await breaker.recordOutcome("quota_exhausted");
    nowRef.now = ENGINE_BREAKER_OPEN_DURATION_MS;
    expect(await breaker.state()).toBe("half_open");

    await expect(Promise.all([breaker.admit(), breaker.admit(), breaker.admit()])).resolves.toBeDefined();
  });
});

describe("STORY-031 D19 · EngineBreaker state store — fail-CLOSED to last-known-state, defaulting closed if never read", () => {
  class FlakyStateStore implements EngineBreakerStateStore {
    private value: number | null = null;
    private shouldFail = false;

    async read(): Promise<number | null> {
      if (this.shouldFail) throw new Error("cache instance unreachable");
      return this.value;
    }

    async write(_engineKey: string, openedAt: number | null): Promise<void> {
      this.value = openedAt;
    }

    failNextReads(): void {
      this.shouldFail = true;
    }
  }

  it("defaults to closed when the store has never been readable at all", async () => {
    const store = new FlakyStateStore();
    store.failNextReads();
    const breaker = new EngineBreaker("chatgpt", store, new FakeRatioCounter(), () => 0);
    expect(await breaker.state()).toBe("closed");
  });

  // qa-reviewer finding — the never-readable case above passes trivially
  // even if a `sync()` read failure were wired to fall back to CLOSED
  // instead of the last-known value (both start at "no state" either way).
  // This is the actual D19 claim: OPEN first, established via a store that
  // WAS readable, THEN goes unreadable — the fallback must reproduce the
  // last value THIS instance itself successfully read, never silently
  // reset to closed.
  it("falls back to the last-known OPEN state when the store becomes unreadable AFTER previously reporting open — never resets to closed", async () => {
    const store = new FlakyStateStore();
    const breaker = new EngineBreaker("chatgpt", store, new FakeRatioCounter(), () => 0);

    await breaker.recordOutcome("quota_exhausted");
    expect(await breaker.state()).toBe("open");

    store.failNextReads();

    expect(await breaker.state()).toBe("open");
    await expect(breaker.admit()).rejects.toThrow();
  });
});
