import { describe, expect, it } from "vitest";
import { FINGERPRINT_BUDGET_MS, fingerprintRequestSchema, fingerprintResponseSchema } from "./index.js";

const complete = { root_url: "https://a.test/", status: "complete", reason: null, category: null, verticals: [], platform: { value: "wordpress", confidence: 0.9 }, not_derived: ["category", "verticals"], duration_ms: 12, credits_charged: 0 };

describe("POST /projects/fingerprint · contract", () => {
  it("FP-C1 the request is strict and takes one http(s) root_url", () => {
    expect(fingerprintRequestSchema.safeParse({ root_url: "https://a.test" }).success).toBe(true);
    expect(fingerprintRequestSchema.safeParse({ root_url: "ftp://a.test" }).success).toBe(false);
    expect(fingerprintRequestSchema.safeParse({ root_url: "https://a.test", name: "x" }).success).toBe(false);
    expect(fingerprintRequestSchema.safeParse({}).success).toBe(false);
  });
  it("FP-C2 the response is free, strict and names a platform only from the closed set", () => {
    expect(fingerprintResponseSchema.safeParse(complete).success).toBe(true);
    expect(fingerprintResponseSchema.safeParse({ ...complete, credits_charged: 1 }).success).toBe(false);
    expect(fingerprintResponseSchema.safeParse({ ...complete, platform: { value: "notion", confidence: 0.9 } }).success).toBe(false);
    expect(fingerprintResponseSchema.safeParse({ ...complete, platform: { value: "wix", confidence: 1.2 } }).success).toBe(false);
  });
  it("FP-C3 a reason is present exactly when the site could not be read, and an unavailable answer carries no suggestion", () => {
    expect(fingerprintResponseSchema.safeParse({ ...complete, reason: "unreachable" }).success).toBe(false);
    expect(fingerprintResponseSchema.safeParse({ ...complete, status: "unavailable" }).success).toBe(false);
    expect(fingerprintResponseSchema.safeParse({ ...complete, status: "unavailable", reason: "unreachable" }).success).toBe(false);
    expect(fingerprintResponseSchema.safeParse({ ...complete, status: "unavailable", reason: "budget_exceeded", platform: null }).success).toBe(true);
  });
  it("FP-C4 the time budget is below the guarded fetcher's 20 s ceiling", () => {
    expect(FINGERPRINT_BUDGET_MS).toBeLessThan(20_000);
  });
});
