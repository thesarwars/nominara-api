import type { EngineHealthEvent } from "../../modules/health/engine-health.service.js";
import type { EngineKey } from "./contract.js";
import type { EngineBreakerDecision, EngineBreakerDetail, EngineOutcome } from "./engine-breaker.js";
import type { CaptureFailureCode } from "./failure-taxonomy.js";

// STORY-031 AC3/AC4/AC6/AC7/AC8 — the customer capture path's view of the engine breaker and the health telemetry.
// RED: the surface only; the implementation lands with the next commit.

/** EC-06 stage 4: "all in-flight cells for it are re-queued with a 20-minute delay". The reference constant. */
export const ENGINE_BREAKER_REQUEUE_DELAY_MS = 20 * 60 * 1000;

/** The `error_code` of a cell skipped because its engine's breaker is open on `quota_exhausted` (EC-08). */
export const ENGINE_SKIP_QUOTA_EXHAUSTED = "quota_exhausted";
/** The `error_code` of a cell skipped because its engine is degraded (EC-06 stage 5: circuit open > 30 min). */
export const ENGINE_SKIP_DEGRADED = "engine_degraded";
/** The blocked-cell codes that mean "the engine was unavailable, we never asked" - the cells a paid deep scan refunds. */
export const ENGINE_UNAVAILABLE_SKIP_CODES = [ENGINE_SKIP_QUOTA_EXHAUSTED, ENGINE_SKIP_DEGRADED] as const;
export type EngineUnavailableSkipCode = (typeof ENGINE_UNAVAILABLE_SKIP_CODES)[number];

export type EngineAdmission =
  | { readonly kind: "admit" }
  | { readonly kind: "redelay"; readonly delayMs: number }
  | { readonly kind: "skip"; readonly errorCode: EngineUnavailableSkipCode; readonly since: Date };

export type CaptureAttempt =
  | { readonly outcome: "success"; readonly latencyMs: number }
  | { readonly outcome: "failure"; readonly code: CaptureFailureCode };

export interface CaptureEngineGate {
  admit(engineKey: EngineKey): Promise<EngineAdmission>;
  record(engineKey: EngineKey, attempt: CaptureAttempt): Promise<void>;
}

/** Thrown from the capture handler's run phase; `withEngineLease` turns it into a BullMQ delay that spends no attempt. */
export class EngineRedelayError extends Error {
  constructor(
    readonly engineKey: EngineKey,
    readonly delayMs: number,
  ) {
    super(`engine '${engineKey}' is unavailable; cell re-queued in ${String(delayMs)} ms`);
    this.name = "EngineRedelayError";
  }
}

/** The two calls the gate makes on a breaker (EngineBreaker implements both). */
export interface EngineBreakerView {
  detail(): Promise<EngineBreakerDetail>;
  recordOutcome(outcome: EngineOutcome): Promise<EngineBreakerDecision>;
}

export interface CaptureEngineGateDeps {
  readonly breakers: { for(engineKey: string): EngineBreakerView };
  readonly health: { recordAttempt(event: EngineHealthEvent): Promise<void> };
  /** EC-06 stage 2: a `rate_limited` attempt halves the engine's refill for 15 minutes. */
  readonly refill: { trigger(engineKey: EngineKey): Promise<void> };
  readonly clock?: () => number;
}

export class BreakerCaptureEngineGate implements CaptureEngineGate {
  constructor(private readonly deps: CaptureEngineGateDeps) {}

  admit(_engineKey: EngineKey): Promise<EngineAdmission> {
    return Promise.reject(new Error("not implemented"));
  }

  record(_engineKey: EngineKey, _attempt: CaptureAttempt): Promise<void> {
    return Promise.reject(new Error("not implemented"));
  }
}
