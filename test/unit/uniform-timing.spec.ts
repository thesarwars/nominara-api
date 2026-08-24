import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withUniformDuration } from "../../src/lib/auth/uniform-timing.js";

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function delayReject(ms: number, error: unknown): Promise<never> {
  return new Promise((_resolve, reject) => setTimeout(() => reject(error), ms));
}

describe("STORY-016 · withUniformDuration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a fast (1ms) body against a 30ms floor resolves only once the floor elapses, value passes through", async () => {
    let settled = false;
    const promise = withUniformDuration(30, () => delay(1, "fast-value")).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(29);
    expect(settled).toBe(true);
    expect(await promise).toBe("fast-value");
  });

  it("a slow (40ms) body against a 30ms floor is not truncated — full duration honored", async () => {
    let settled = false;
    const promise = withUniformDuration(30, () => delay(40, "slow-value")).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(30);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(true);
    expect(await promise).toBe("slow-value");
  });

  it("a body that throws still respects the floor before the rejection propagates", async () => {
    let settled = false;
    let caught: unknown;
    const promise = withUniformDuration(30, () => delayReject(1, new Error("boom")));
    promise.then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        caught = error;
      },
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(29);
    expect(settled).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");
  });

  it("floor is a minimum, not a cap — a rejecting body slower than the floor is not shortened", async () => {
    let settled = false;
    let caught: unknown;
    const promise = withUniformDuration(30, () => delayReject(40, new Error("late-boom")));
    promise.then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        caught = error;
      },
    );

    await vi.advanceTimersByTimeAsync(30);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(true);
    expect((caught as Error).message).toBe("late-boom");
  });
});
