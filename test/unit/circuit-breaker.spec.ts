import { describe, expect, it } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../../src/lib/resilience/circuit-breaker.js";

// STORY-022 scenario 3 — "Open a dependency's circuit breaker → Health
// reports it". This file proves the primitive itself trips, blocks, and
// recovers per NFR-ARCH-05's exact numbers (50% error threshold, 30s open,
// 3-request half-open); health.spec.ts proves /health surfaces the state.

function breaker(nowRef: { now: number }) {
  // sampleSize is an implementation detail NFR-ARCH-05 does not pin a number
  // for (only the 50%/30s/3-trial figures are the reference constants) — a
  // small window keeps these tests fast and deterministic without needing
  // hundreds of calls to fill a production-sized sample.
  return new CircuitBreaker({ clock: () => nowRef.now, sampleSize: 4 });
}

describe("STORY-022 · CircuitBreaker — 50% error threshold, 30s open, 3-request half-open", () => {
  it("stays closed while the error rate is below 50%", async () => {
    const nowRef = { now: 0 };
    const cb = breaker(nowRef);
    for (let i = 0; i < 4; i++) {
      await cb.execute(async () => "ok");
    }
    await expect(cb.execute(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(cb.state).toBe("closed");
  });

  it("opens once the error rate reaches 50% at or above the volume threshold", async () => {
    const nowRef = { now: 0 };
    const cb = breaker(nowRef);
    const fail = () => cb.execute(async () => Promise.reject(new Error("boom"))).catch(() => undefined);
    const ok = () => cb.execute(async () => "ok");

    await ok();
    await ok();
    await fail();
    await fail();
    // 4 calls, 2 failures = 50% at the volume threshold (4).
    expect(cb.state).toBe("open");
  });

  it("blocks calls immediately while open, without invoking the wrapped function", async () => {
    const nowRef = { now: 0 };
    const cb = breaker(nowRef);
    for (let i = 0; i < 4; i++) {
      await cb.execute(async () => Promise.reject(new Error("boom"))).catch(() => undefined);
    }
    expect(cb.state).toBe("open");

    let called = false;
    await expect(
      cb.execute(async () => {
        called = true;
        return "unreachable";
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it("stays open until 30s have elapsed, then moves to half-open", async () => {
    const nowRef = { now: 0 };
    const cb = breaker(nowRef);
    for (let i = 0; i < 4; i++) {
      await cb.execute(async () => Promise.reject(new Error("boom"))).catch(() => undefined);
    }
    expect(cb.state).toBe("open");

    nowRef.now += 29_999;
    expect(cb.state).toBe("open");

    nowRef.now += 1;
    expect(cb.state).toBe("half_open");
  });

  it("half-open: 3 consecutive successful trial calls close the breaker", async () => {
    const nowRef = { now: 0 };
    const cb = breaker(nowRef);
    for (let i = 0; i < 4; i++) {
      await cb.execute(async () => Promise.reject(new Error("boom"))).catch(() => undefined);
    }
    nowRef.now += 30_000;
    expect(cb.state).toBe("half_open");

    await cb.execute(async () => "ok");
    await cb.execute(async () => "ok");
    expect(cb.state).toBe("half_open");
    await cb.execute(async () => "ok");
    expect(cb.state).toBe("closed");
  });

  it("half-open: admits at most 3 concurrent trial calls, rejecting a 4th without invoking it", async () => {
    const nowRef = { now: 0 };
    const cb = breaker(nowRef);
    for (let i = 0; i < 4; i++) {
      await cb.execute(async () => Promise.reject(new Error("boom"))).catch(() => undefined);
    }
    nowRef.now += 30_000;
    expect(cb.state).toBe("half_open");

    let admitted = 0;
    const releases: Array<() => void> = [];
    const trial = () =>
      cb.execute(
        () =>
          new Promise<string>((resolve) => {
            admitted += 1;
            releases.push(() => resolve("ok"));
          }),
      );

    // Each call's synchronous prefix (admission check, then invoking fn())
    // runs to completion before returning its pending promise, so these 4
    // calls — made one after another with no await in between — admit or
    // reject deterministically without needing real concurrency.
    const p1 = trial();
    const p2 = trial();
    const p3 = trial();
    const p4 = trial().catch((error: unknown) => error);

    expect(admitted).toBe(3);
    await expect(p4).resolves.toBeInstanceOf(CircuitOpenError);

    releases.forEach((release) => release());
    await Promise.all([p1, p2, p3]);
  });

  it("half-open: a single trial failure reopens the breaker immediately", async () => {
    const nowRef = { now: 0 };
    const cb = breaker(nowRef);
    for (let i = 0; i < 4; i++) {
      await cb.execute(async () => Promise.reject(new Error("boom"))).catch(() => undefined);
    }
    nowRef.now += 30_000;
    expect(cb.state).toBe("half_open");

    await cb.execute(async () => "ok");
    await expect(cb.execute(async () => Promise.reject(new Error("still failing")))).rejects.toThrow(
      "still failing",
    );
    expect(cb.state).toBe("open");
  });
});

// STORY-031 D3 — the engine breaker composes THIS class rather than
// reimplementing a parallel state machine, by adding ONE new public method.
// Every test above this point must stay green, UNCHANGED, proving the
// Postgres breaker's own behavior is byte-identical after this addition.
describe("STORY-031 D3 · CircuitBreaker.forceOpen() — a new addition, no existing behavior changed", () => {
  it("forces a closed breaker open immediately, with no prior failures at all", async () => {
    const nowRef = { now: 0 };
    const cb = breaker(nowRef);
    expect(cb.state).toBe("closed");

    cb.forceOpen();
    expect(cb.state).toBe("open");

    let called = false;
    await expect(
      cb.execute(async () => {
        called = true;
        return "unreachable";
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it("accepts an explicit `at` timestamp — the breaker computes open/half_open from THAT moment, not from when forceOpen() was called", () => {
    const nowRef = { now: 10_000 };
    const cb = breaker(nowRef);

    // Force-opened as if it happened 30s in the past — already past the
    // default 30s openDurationMs, so it should read as half_open right away.
    cb.forceOpen(nowRef.now - 30_000);
    expect(cb.state).toBe("half_open");
  });

  it("forceOpen() with no argument defaults to the injected clock — same as the existing open() default", () => {
    const nowRef = { now: 5_000 };
    const cb = breaker(nowRef);
    cb.forceOpen();
    expect(cb.state).toBe("open");

    nowRef.now += 29_999;
    expect(cb.state).toBe("open");
    nowRef.now += 1;
    expect(cb.state).toBe("half_open");
  });

  it("forceOpen() resets any prior rolling window — a subsequent success doesn't inherit stale failure history", async () => {
    const nowRef = { now: 0 };
    const cb = breaker(nowRef);
    await cb.execute(async () => Promise.reject(new Error("one"))).catch(() => undefined);
    await cb.execute(async () => Promise.reject(new Error("two"))).catch(() => undefined);
    expect(cb.state).toBe("closed"); // below the 50%-of-4 volume threshold

    cb.forceOpen();
    nowRef.now += 30_000;
    expect(cb.state).toBe("half_open");

    // Half-open recovery is unaffected by the pre-forceOpen() history.
    await cb.execute(async () => "ok");
    await cb.execute(async () => "ok");
    await cb.execute(async () => "ok");
    expect(cb.state).toBe("closed");
  });
});
