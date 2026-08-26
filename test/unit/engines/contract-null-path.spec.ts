import { describe, expect, it } from "vitest";
import { captureInputSchema, rawCaptureSchema } from "../../../src/lib/engines/contract.js";

// STORY-027 T18 — null path. Decision (this story's Implementation
// decisions): an optional field may be OMITTED to mean "not provided". An
// explicit `null` is REJECTED — it is not treated as equivalent to absent.
describe("STORY-027 · T18 · null vs absent — an explicit null is rejected, not treated as absence", () => {
  const validInput = {
    promptText: "x",
    locale: "en-US",
    sampleIndex: 0,
    requireCitations: false,
  };

  const validCapture = {
    text: "Answer",
    format: "markdown" as const,
    truncated: false,
    responseTokensEst: 10,
    latencyMs: 100,
    costUsd: 0,
  };

  it("personaHint absent is valid", () => {
    expect(captureInputSchema.safeParse(validInput).success).toBe(true);
  });

  it("personaHint: null is REJECTED", () => {
    expect(captureInputSchema.safeParse({ ...validInput, personaHint: null }).success).toBe(false);
  });

  it("modelFingerprint/vendorRequestId/structuredCitations/structuredElements/flags absent are all valid", () => {
    expect(rawCaptureSchema.safeParse(validCapture).success).toBe(true);
  });

  it.each(["modelFingerprint", "vendorRequestId", "structuredCitations", "structuredElements", "flags"] as const)(
    "%s: null is REJECTED, not treated as equivalent to absent",
    (field) => {
      expect(rawCaptureSchema.safeParse({ ...validCapture, [field]: null }).success).toBe(false);
    },
  );
});
