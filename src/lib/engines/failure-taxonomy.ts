import { z } from "zod";
import type { EngineKey } from "./contract.js";

// tracking-engine.md §2 "Failure taxonomy" — fixed because the circuit
// breaker and retry ladder branch on it (STORY-031, out of scope here).
export const CAPTURE_FAILURE_CODES = [
  "rate_limited",
  "auth_failed",
  "blocked",
  "timeout",
  "malformed_response",
  "content_policy_refusal",
  "upstream_5xx",
  "quota_exhausted",
] as const;

export const captureFailureCodeSchema = z.enum(CAPTURE_FAILURE_CODES);
export type CaptureFailureCode = z.infer<typeof captureFailureCodeSchema>;

export class CaptureFailureError extends Error {
  readonly code: CaptureFailureCode;
  readonly engineKey: EngineKey;

  constructor(code: CaptureFailureCode, engineKey: EngineKey, message?: string) {
    super(message ?? `capture failed for '${engineKey}': ${code}`);
    this.name = "CaptureFailureError";
    this.code = code;
    this.engineKey = engineKey;
  }
}

// D7 (STORY-027 Implementation decisions) — this retryable/terminal split is
// a provisional first cut, not a ratified retry policy: STORY-031 owns the
// actual breaker/retry-ladder decision and may re-bucket any of these codes
// (e.g. whether quota_exhausted is retryable after a cooldown). Only the
// content_policy_refusal -> null half of this function is load-bearing for
// this story (NFR-SIM-07 — it is data, never a failure, never retried);
// STORY-031 must review the rest before depending on it, not inherit it
// silently.
const RETRYABLE_TRANSPORT_CODES: ReadonlySet<CaptureFailureCode> = new Set([
  "rate_limited",
  "timeout",
  "upstream_5xx",
]);

const TERMINAL_CODES: ReadonlySet<CaptureFailureCode> = new Set([
  "auth_failed",
  "blocked",
  "quota_exhausted",
  "malformed_response",
]);

export type CaptureFailureClassification = "retryable" | "terminal";

/**
 * Pure three-way split. `content_policy_refusal` returns `null`:
 * tracking-engine.md §2/NFR-SIM-07 — it is data, not a failure, and is
 * never retried. No breaker, no retry loop here (STORY-031).
 */
export function classifyCaptureFailure(code: CaptureFailureCode): CaptureFailureClassification | null {
  if (RETRYABLE_TRANSPORT_CODES.has(code)) {
    return "retryable";
  }
  if (TERMINAL_CODES.has(code)) {
    return "terminal";
  }
  return null;
}
