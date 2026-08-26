import { classifyCaptureFailure, type CaptureFailureCode } from "./failure-taxonomy.js";

// STORY-031 Phase G — EC-06's six-stage mitigation ladder, as a PURE
// resolver: no I/O, no clock of its own. Every signal is supplied by the
// caller (the ratio comes from engine-breaker.ts's own ratio counter, the
// open duration from EngineBreaker.state(), etc.) — this file only decides
// WHICH stage currently applies. Stage 1's actual retry math is NEVER
// reimplemented here — it stays entirely in src/lib/queue/backoff.ts's
// createBackoffStrategy; this resolver only reports that stage 1 applies.

export type DegradationStage = 1 | 2 | 3 | 4 | 5 | 6;

export interface DegradationSignals {
  /** The failure code of the MOST RECENT attempt, if it failed. Undefined for a success. */
  readonly failureCode?: CaptureFailureCode | undefined;
  /** blocks/attempts over engine-breaker.ts's own rolling window — 0 when there have been no attempts at all (never NaN, never a divide-by-zero). */
  readonly blockRatio: number;
  /** How long the circuit has been continuously open, in ms — null if not open. */
  readonly circuitOpenDurationMs: number | null;
  /** How long the engine has captured NOTHING successfully, in ms — null if not currently dark. */
  readonly blackoutDurationMs: number | null;
}

/** EC-06's exact reference constants — pinned, not interpolations. */
export const DEGRADATION_STAGE_3_RATIO_THRESHOLD = 0.10;
export const DEGRADATION_STAGE_4_RATIO_THRESHOLD = 0.25;
export const DEGRADATION_STAGE_5_OPEN_DURATION_MS = 30 * 60 * 1000;
export const DEGRADATION_STAGE_6_BLACKOUT_DURATION_MS = 48 * 60 * 60 * 1000;

/**
 * Highest-applicable-stage-wins: checked from stage 6 down to stage 1, and
 * the FIRST (highest) matching condition is returned. `null` means nothing
 * currently applies — e.g. a clean success, or a terminal failure that is
 * neither `rate_limited` nor a ratio/breaker/blackout breach (this resolver
 * never invents a stage that isn't documented).
 */
export function resolveDegradationStage(signals: DegradationSignals): DegradationStage | null {
  if (signals.blackoutDurationMs !== null && signals.blackoutDurationMs > DEGRADATION_STAGE_6_BLACKOUT_DURATION_MS) {
    return 6;
  }
  if (signals.circuitOpenDurationMs !== null && signals.circuitOpenDurationMs > DEGRADATION_STAGE_5_OPEN_DURATION_MS) {
    return 5;
  }
  if (signals.blockRatio > DEGRADATION_STAGE_4_RATIO_THRESHOLD) {
    return 4;
  }
  if (signals.blockRatio > DEGRADATION_STAGE_3_RATIO_THRESHOLD) {
    return 3;
  }
  if (signals.failureCode === "rate_limited") {
    return 2;
  }
  if (signals.failureCode !== undefined && classifyCaptureFailure(signals.failureCode) === "retryable") {
    return 1;
  }
  return null;
}
