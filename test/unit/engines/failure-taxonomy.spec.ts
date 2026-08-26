import { describe, expect, it } from "vitest";
import {
  CAPTURE_FAILURE_CODES,
  CaptureFailureError,
  classifyCaptureFailure,
  type CaptureFailureCode,
} from "../../../src/lib/engines/failure-taxonomy.js";

// STORY-027 · scenario 5 — "Each failure class -> Mapped to its taxonomy
// value." tracking-engine.md §2's "Failure taxonomy" is fixed because the
// circuit breaker and retry ladder branch on it (STORY-031, out of scope
// here — only the taxonomy and a pure classifier land in this story).
describe("STORY-027 · scenario 5 · every failure class maps to its taxonomy value", () => {
  const EXPECTED: readonly CaptureFailureCode[] = [
    "rate_limited",
    "auth_failed",
    "blocked",
    "timeout",
    "malformed_response",
    "content_policy_refusal",
    "upstream_5xx",
    "quota_exhausted",
  ];

  it("the taxonomy is exactly these 8 codes, set-equal, length 8", () => {
    expect(CAPTURE_FAILURE_CODES).toHaveLength(8);
    expect(new Set(CAPTURE_FAILURE_CODES)).toEqual(new Set(EXPECTED));
  });

  it.each(EXPECTED)("%s round-trips through CaptureFailureError with .code preserved, is an Error, non-empty message, engine key attached", (code) => {
    const error = new CaptureFailureError(code, "perplexity");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.engineKey).toBe("perplexity");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("classifies rate_limited, timeout, upstream_5xx as retryable transport failures", () => {
    for (const code of ["rate_limited", "timeout", "upstream_5xx"] as const) {
      expect(classifyCaptureFailure(code), code).toBe("retryable");
    }
  });

  it("classifies auth_failed, blocked, quota_exhausted, malformed_response as terminal failures", () => {
    for (const code of ["auth_failed", "blocked", "quota_exhausted", "malformed_response"] as const) {
      expect(classifyCaptureFailure(code), code).toBe("terminal");
    }
  });

  it("content_policy_refusal classifies as neither retryable nor terminal — it is not in the failure set at all (NFR-SIM-07)", () => {
    const classification = classifyCaptureFailure("content_policy_refusal");
    expect(classification).not.toBe("retryable");
    expect(classification).not.toBe("terminal");
    expect(classification).toBeNull();
  });

  it("every code classifies to exactly one of retryable/terminal, except content_policy_refusal which classifies to neither", () => {
    for (const code of EXPECTED) {
      const classification = classifyCaptureFailure(code);
      if (code === "content_policy_refusal") {
        expect(classification).toBeNull();
      } else {
        expect(["retryable", "terminal"]).toContain(classification);
      }
    }
  });
});
