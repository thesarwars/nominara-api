import { describe, expect, it } from "vitest";
import { createBackoffStrategy, delaysMsFor } from "../../../src/lib/queue/backoff.js";

// STORY-030 T5 (RED step) — architecture reference §4's retry-ladder column
// plus edge-cases-and-slos.md EC-06 stage 1, which names capture.execute's
// documented algorithm exactly: "retry with exponential backoff 5 s→120 s
// plus full jitter, max 4 attempts" — AWS's "Full Jitter":
// delay = random_between(0, base). capture.execute is the ONLY queue the
// reference table marks "+ jitter"; every other queue's backoff is the bare
// (unjittered) delaysMs value from topology.ts.
//
// capture.execute's INTERIOR ladder values (attempts 2 and 3) are not
// derivable from anything cited — only the endpoints (5000, 120000) and
// the step count (4) are spec'd. Assertions below check those properties
// (length, first/last value, strictly increasing) plus jitter behavior
// relative to whatever the actual base delay is at each step, rather than
// re-asserting the implementation's own interpolated interior numbers.

describe("STORY-030 · delaysMsFor — reads the documented retry ladder from topology.ts", () => {
  it("returns capture.plan's stated ladder [2000, 4000, 8000]", () => {
    expect(delaysMsFor("capture.plan")).toEqual([2000, 4000, 8000]);
  });

  it("returns capture.execute's ladder matching only what the reference specifies — 4 steps, 5000, 120000, strictly increasing", () => {
    const delaysMs = delaysMsFor("capture.execute");
    expect(delaysMs).toHaveLength(4);
    expect(delaysMs[0]).toBe(5000);
    expect(delaysMs[3]).toBe(120000);
    for (let i = 1; i < delaysMs.length; i++) {
      expect(delaysMs[i]).toBeGreaterThan(delaysMs[i - 1]!);
    }
  });

  it("returns an empty ladder for deploy.cms — no automatic retry", () => {
    expect(delaysMsFor("deploy.cms")).toEqual([]);
  });

  it("throws for an unknown queue name", () => {
    expect(() => delaysMsFor("not.a.real.queue" as never)).toThrow();
  });
});

describe("STORY-030 · createBackoffStrategy — non-jittered queues return the bare delaysMs value", () => {
  it("capture.plan: attempt 1/2/3 return 2000/4000/8000, attempt 4 returns false (ladder exhausted)", () => {
    const strategy = createBackoffStrategy("capture.plan");
    expect(strategy(1)).toBe(2000);
    expect(strategy(2)).toBe(4000);
    expect(strategy(3)).toBe(8000);
    expect(strategy(4)).toBe(false);
  });

  it("deploy.cms: attempt 1 already returns false — a single attempt, no automatic retry", () => {
    const strategy = createBackoffStrategy("deploy.cms");
    expect(strategy(1)).toBe(false);
  });
});

describe("STORY-030 · createBackoffStrategy — capture.execute applies full jitter (AWS Full Jitter: 0 <= delay < base)", () => {
  it("with an injected rng returning a fixed 0.5, each attempt is exactly half ITS OWN base delay from the ladder", () => {
    const baseDelays = delaysMsFor("capture.execute");
    const strategy = createBackoffStrategy("capture.execute", { rng: () => 0.5 });
    baseDelays.forEach((base, index) => {
      expect(strategy(index + 1)).toBe(Math.floor(base * 0.5));
    });
    // The two endpoints ARE spec-derivable — pin those literally.
    expect(strategy(1)).toBe(2500); // floor(5000 * 0.5)
    expect(strategy(4)).toBe(60000); // floor(120000 * 0.5)
  });

  it("with rng returning 0, the jittered delay is exactly 0", () => {
    const strategy = createBackoffStrategy("capture.execute", { rng: () => 0 });
    expect(strategy(1)).toBe(0);
  });

  it("with rng returning just under 1, the jittered delay is strictly less than the base delay (never reaches or exceeds it)", () => {
    const strategy = createBackoffStrategy("capture.execute", { rng: () => 0.999999 });
    const jittered = strategy(1);
    expect(jittered).toBeLessThan(5000);
    expect(jittered).toBeGreaterThanOrEqual(0);
  });

  it("attempt 5 returns false — the ladder is exhausted at 4 attempts, jitter does not extend it", () => {
    const strategy = createBackoffStrategy("capture.execute", { rng: () => 0.5 });
    expect(strategy(5)).toBe(false);
  });

  it("defaults to Math.random when no rng is injected, always within [0, base)", () => {
    const strategy = createBackoffStrategy("capture.execute");
    const delay = strategy(1);
    expect(delay).not.toBe(false);
    expect(delay as number).toBeGreaterThanOrEqual(0);
    expect(delay as number).toBeLessThan(5000);
  });
});
