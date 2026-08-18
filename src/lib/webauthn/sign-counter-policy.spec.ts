import { describe, expect, it } from "vitest";
import { nextCounter } from "./sign-counter-policy.js";

describe("STORY-014 · sign-counter policy", () => {
  it("accepts a lower-than-stored counter as a clone signal (test scenario 4)", () => {
    expect(nextCounter(10n, 5n, true)).toBe("clone-signal");
  });

  it("accepts a counter of zero from an authenticator that always reports zero (test scenario 5)", () => {
    expect(nextCounter(0n, 0n, false)).toBe("accept");
    expect(nextCounter(0n, 0n, false)).toBe("accept");
  });

  it("accepts the first nonzero report from an authenticator that has always reported zero, and it becomes the new floor (test scenario 15)", () => {
    expect(nextCounter(0n, 7n, false)).toBe("accept");
  });

  it("rejects a non-increasing (equal) counter once an authenticator has ever reported nonzero", () => {
    expect(nextCounter(7n, 7n, true)).toBe("clone-signal");
  });

  it("rejects a report of zero from an authenticator that has previously reported nonzero", () => {
    expect(nextCounter(7n, 0n, true)).toBe("clone-signal");
  });

  it("accepts a strictly greater counter once an authenticator has reported nonzero", () => {
    expect(nextCounter(7n, 8n, true)).toBe("accept");
  });

  it("is a pure function with no I/O or randomness", () => {
    expect(nextCounter.constructor.name).toBe("Function");
    expect(nextCounter(3n, 4n, true)).toBe(nextCounter(3n, 4n, true));
  });
});
