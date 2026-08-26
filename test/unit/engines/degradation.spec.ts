import { describe, expect, it } from "vitest";
import { resolveDegradationStage, type DegradationSignals } from "../../../src/lib/engines/degradation.js";

// STORY-031 Phase G — EC-06's six-stage ladder. A PURE resolver: no I/O, no
// clock of its own — every signal (ratio, open duration, blackout duration,
// failure code) is supplied by the caller. "Highest-applicable-stage-wins"
// when several conditions are simultaneously true. Boundary values are
// asserted with strict `>` per the reference table — exactly 0.10/0.25 must
// NOT fire.

const BASE: DegradationSignals = {
  failureCode: undefined,
  blockRatio: 0,
  circuitOpenDurationMs: null,
  blackoutDurationMs: null,
};

describe("STORY-031 · resolveDegradationStage — six stages, highest wins, strict boundaries", () => {
  it("nothing applies (a clean success, no breach) → null, not stage 1", () => {
    expect(resolveDegradationStage(BASE)).toBeNull();
  });

  it("stage 1 — a retryable transient failure code (rate_limited/timeout/upstream_5xx) with no other breach", () => {
    expect(resolveDegradationStage({ ...BASE, failureCode: "timeout" })).toBe(1);
    expect(resolveDegradationStage({ ...BASE, failureCode: "upstream_5xx" })).toBe(1);
  });

  it("a non-retryable, non-blocked terminal failure with no ratio/breaker/blackout breach → null (never invents a stage)", () => {
    expect(resolveDegradationStage({ ...BASE, failureCode: "auth_failed" })).toBeNull();
  });

  it("stage 2 — rate_limited specifically, distinct from the generic stage-1 transient-failure case", () => {
    expect(resolveDegradationStage({ ...BASE, failureCode: "rate_limited" })).toBe(2);
  });

  it("stage 3 — blocks/attempts > 0.10; EXACTLY 0.10 does NOT fire (strict >)", () => {
    expect(resolveDegradationStage({ ...BASE, blockRatio: 0.10 })).toBeNull();
    expect(resolveDegradationStage({ ...BASE, blockRatio: 0.100001 })).toBe(3);
  });

  it("stage 4 — blocks/attempts > 0.25; EXACTLY 0.25 does NOT fire (strict >)", () => {
    expect(resolveDegradationStage({ ...BASE, blockRatio: 0.25 })).toBe(3); // still only stage 3 — 0.25 has not been EXCEEDED
    expect(resolveDegradationStage({ ...BASE, blockRatio: 0.250001 })).toBe(4);
  });

  it("stage 5 — circuit open > 30 minutes; EXACTLY 30:00 does NOT yet degrade (strict >)", () => {
    const THIRTY_MIN_MS = 30 * 60 * 1000;
    expect(resolveDegradationStage({ ...BASE, circuitOpenDurationMs: THIRTY_MIN_MS })).toBeNull();
    expect(resolveDegradationStage({ ...BASE, circuitOpenDurationMs: THIRTY_MIN_MS + 1 })).toBe(5);
  });

  it("stage 6 — blackout > 48 hours; EXACTLY 48:00:00 does NOT yet page (strict >)", () => {
    const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
    expect(resolveDegradationStage({ ...BASE, blackoutDurationMs: FORTY_EIGHT_HOURS_MS })).toBeNull();
    expect(resolveDegradationStage({ ...BASE, blackoutDurationMs: FORTY_EIGHT_HOURS_MS + 1 })).toBe(6);
  });

  it("highest-applicable-stage-wins: blackout, breaker-open, AND high ratio all true simultaneously → stage 6, not 4 or 5", () => {
    const everything: DegradationSignals = {
      failureCode: "blocked",
      blockRatio: 0.9,
      circuitOpenDurationMs: 60 * 60 * 1000,
      blackoutDurationMs: 49 * 60 * 60 * 1000,
    };
    expect(resolveDegradationStage(everything)).toBe(6);
  });

  it("highest-applicable-stage-wins: breaker open > 30 min AND high ratio, no blackout → stage 5, not 4", () => {
    expect(
      resolveDegradationStage({ ...BASE, blockRatio: 0.9, circuitOpenDurationMs: 31 * 60 * 1000 }),
    ).toBe(5);
  });

  it("highest-applicable-stage-wins: ratio > 0.25 AND rate_limited both true → stage 4, not 2", () => {
    expect(resolveDegradationStage({ ...BASE, failureCode: "rate_limited", blockRatio: 0.3 })).toBe(4);
  });

  it("0/0 attempts (blockRatio supplied as 0, no attempts at all) never fires stage 3/4 — 0 is not > 0.10", () => {
    expect(resolveDegradationStage({ ...BASE, blockRatio: 0 })).toBeNull();
  });
});
