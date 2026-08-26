import { describe, expect, it } from "vitest";
import {
  applyRefillReduction,
  REFILL_REDUCTION_DURATION_MS,
  REFILL_REDUCTION_FACTOR,
  RefillReductionTracker,
  type RefillReductionStore,
} from "../../../src/lib/engines/refill-reduction.js";
import type { TokenBucketConfig } from "../../../src/lib/engines/token-bucket.js";

// STORY-031 Phase G stage 2 — EC-06: "reduce the engine's token-bucket
// refill by 50% for 15 minutes". "Restores exactly" is proven by never
// mutating the base config at all — the reduction is a pure runtime
// multiplier applied only while the 15-minute window is active; the base
// config is always the untouched source of truth.

const BASE: TokenBucketConfig = { capacity: 10, refillPerSecond: 4 };

class InMemoryRefillReductionStore implements RefillReductionStore {
  private reducedUntilMs = new Map<string, number>();
  async read(engineKey: string): Promise<number | null> {
    return this.reducedUntilMs.get(engineKey) ?? null;
  }
  async write(engineKey: string, reducedUntilMs: number): Promise<void> {
    this.reducedUntilMs.set(engineKey, reducedUntilMs);
  }
}

describe("STORY-031 · applyRefillReduction — pure, no I/O", () => {
  it("exactly 50% and exactly 15 minutes are the reference constants", () => {
    expect(REFILL_REDUCTION_FACTOR).toBe(0.5);
    expect(REFILL_REDUCTION_DURATION_MS).toBe(15 * 60 * 1000);
  });

  it("no reduction in effect (null) returns the base config completely unchanged", () => {
    expect(applyRefillReduction(BASE, null, 1000)).toEqual(BASE);
  });

  it("an active reduction halves refillPerSecond, capacity unchanged", () => {
    const result = applyRefillReduction(BASE, 5000, 1000);
    expect(result.refillPerSecond).toBe(2);
    expect(result.capacity).toBe(10);
  });

  it("once the reduction window has elapsed, the config reverts to EXACTLY the original base — never a decayed/compounded value", () => {
    const reduced = applyRefillReduction(BASE, 5000, 1000);
    expect(reduced.refillPerSecond).toBe(2);
    const restored = applyRefillReduction(BASE, 5000, 5001); // now >= reducedUntilMs
    expect(restored).toEqual(BASE);
  });

  it("exactly AT the reducedUntilMs boundary, the reduction has already ended (>=, not >)", () => {
    const atBoundary = applyRefillReduction(BASE, 5000, 5000);
    expect(atBoundary).toEqual(BASE);
  });
});

describe("STORY-031 · RefillReductionTracker — trigger() then effectiveConfig()", () => {
  it("before any trigger, effectiveConfig returns the base config unchanged", async () => {
    const nowRef = { now: 0 };
    const tracker = new RefillReductionTracker(new InMemoryRefillReductionStore(), () => nowRef.now);
    expect(await tracker.effectiveConfig("chatgpt", BASE)).toEqual(BASE);
  });

  it("after trigger(), refill is halved for exactly 15 minutes, then restores exactly", async () => {
    const nowRef = { now: 0 };
    const tracker = new RefillReductionTracker(new InMemoryRefillReductionStore(), () => nowRef.now);

    await tracker.trigger("chatgpt");
    expect((await tracker.effectiveConfig("chatgpt", BASE)).refillPerSecond).toBe(2);

    nowRef.now = REFILL_REDUCTION_DURATION_MS - 1;
    expect((await tracker.effectiveConfig("chatgpt", BASE)).refillPerSecond).toBe(2);

    nowRef.now = REFILL_REDUCTION_DURATION_MS;
    expect(await tracker.effectiveConfig("chatgpt", BASE)).toEqual(BASE);
  });

  it("a reduction for one engine never affects another engine's config", async () => {
    const nowRef = { now: 0 };
    const tracker = new RefillReductionTracker(new InMemoryRefillReductionStore(), () => nowRef.now);
    await tracker.trigger("chatgpt");
    expect(await tracker.effectiveConfig("claude", BASE)).toEqual(BASE);
  });
});

describe("STORY-031 Phase J · RefillReductionTracker — D19's spirit extended: a store read failure never blocks/throws, falls back to the base config", () => {
  class FailingStore implements RefillReductionStore {
    async read(): Promise<number | null> {
      throw new Error("cache instance unreachable");
    }
    async write(): Promise<void> {
      throw new Error("cache instance unreachable");
    }
  }

  it("effectiveConfig() never throws and returns the base config unchanged when the store is unreadable", async () => {
    const tracker = new RefillReductionTracker(new FailingStore(), () => 0);
    await expect(tracker.effectiveConfig("chatgpt", BASE)).resolves.toEqual(BASE);
  });

  it("trigger() never throws even when the store is unwritable", async () => {
    const tracker = new RefillReductionTracker(new FailingStore(), () => 0);
    await expect(tracker.trigger("chatgpt")).resolves.toBeUndefined();
  });
});
