import { describe, expect, it } from "vitest";
import { runFinishedBody } from "./finalize-run.js";

// STORY-089 (PROVISIONAL copy) - the finished-run notification body says what the settlement did.
const progress = { captured: 3, skipped: 1, failed: 2 };

describe("STORY-089 - the finished manual run's notification body", () => {
  it("a partial run that was refunded something says so", () => {
    expect(runFinishedBody("partial", progress, 40)).toMatch(/refunded/i);
  });
  it("a partial run with no refund does not claim one", () => {
    expect(runFinishedBody("partial", progress, 0)).not.toMatch(/refunded/i);
  });
  it("a failed run says it was refunded only when something was", () => {
    expect(runFinishedBody("failed", progress, 100)).toMatch(/refunded in full/i);
    expect(runFinishedBody("failed", progress, 0)).not.toMatch(/refunded/i);
  });
  it("a completed run names the live and the already-fresh counts, 0 included", () => {
    expect(runFinishedBody("completed", { captured: 0, skipped: 0, failed: 0 }, 0)).toBe("0 answers captured live, 0 already fresh.");
  });
});
