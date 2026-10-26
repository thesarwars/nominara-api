import { Logger } from "@nestjs/common";
import type { EngineHealthEvent, EngineHealthOutcome } from "../../modules/health/engine-health.service.js";
import { incrementCounter } from "../telemetry/metrics.js";
import type { EngineKey } from "./contract.js";
import type { EngineBreakerDecision, EngineBreakerDetail, EngineOutcome } from "./engine-breaker.js";
import { DEGRADATION_STAGE_5_OPEN_DURATION_MS } from "./degradation.js";
import type { CaptureFailureCode } from "./failure-taxonomy.js";

// STORY-031 AC3/AC4/AC6/AC7/AC8 — the customer capture path's view of the engine breaker and the health telemetry.
//
// Until this, the breaker and the `engine_health` buckets were fed ONLY by the canary (status check 2026-10-12): an open breaker
// did not stop a customer dispatch, and customer attempts were invisible to both. The capture handler now asks `admit` before the
// vendor call and reports every attempt to `record` after it, both in its RUN phase, which holds no transaction (ADR-0003).
//
// WHAT AN OPEN BREAKER MEANS FOR A CELL, by the breaker's episode:
//   opened on quota_exhausted (EC-08)   -> SKIP: "remaining cells are re-queued for the next window rather than failed". The cell
//                                          settles as `blocked` / `quota_exhausted`, the run completes, and the next scheduled
//                                          window captures it naturally (planner recommendation (b), D1 plan).
//   open for > 30 min (EC-06 stage 5)   -> SKIP as `engine_degraded`: "runs complete as partial rather than failing".
//   otherwise (EC-06 stage 4)           -> RE-DELAY by 20 minutes: "all in-flight cells for it are re-queued with a 20-minute
//                                          delay". The lease turns EngineRedelayError into a BullMQ delay that spends no attempt.
// A skipped cell is `blocked`, not `skipped`: `skipped` is the reuse vocabulary (L1/L2 suppressed rows) and counts as a
// MEASUREMENT in every rollup; "we could not ask" is exactly what `blocked` means (execute-cell.ts).
//
// FAILS OPEN on a cache outage, like the breaker itself (D19): an unreadable breaker admits, and recording never throws.

const logger = new Logger("capture.engine-gate");

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

  private now(): number {
    return (this.deps.clock ?? Date.now)();
  }

  async admit(engineKey: EngineKey): Promise<EngineAdmission> {
    let detail: EngineBreakerDetail;
    try {
      detail = await this.deps.breakers.for(engineKey).detail();
    } catch (error) {
      logger.warn(`breaker unreadable for '${engineKey}'; admitting (fail open): ${error instanceof Error ? error.message : "unknown"}`);
      return { kind: "admit" };
    }
    if (detail.state !== "open") return { kind: "admit" };
    const since = detail.since ?? detail.openedAt ?? this.now();
    let admission: EngineAdmission;
    if (detail.reason === "quota") admission = { kind: "skip", errorCode: ENGINE_SKIP_QUOTA_EXHAUSTED, since: new Date(since) };
    else if (this.now() - since > DEGRADATION_STAGE_5_OPEN_DURATION_MS) admission = { kind: "skip", errorCode: ENGINE_SKIP_DEGRADED, since: new Date(since) };
    else admission = { kind: "redelay", delayMs: ENGINE_BREAKER_REQUEUE_DELAY_MS };
    incrementCounter("nominara_capture_engine_unavailable_total", { engine_key: engineKey, action: admission.kind === "skip" ? admission.errorCode : "redelay" });
    return admission;
  }

  async record(engineKey: EngineKey, attempt: CaptureAttempt): Promise<void> {
    const code = attempt.outcome === "failure" ? attempt.code : undefined;
    const breakerOutcome: EngineOutcome = code === undefined ? "success" : code === "blocked" ? "blocked" : code === "quota_exhausted" ? "quota_exhausted" : "other_failure";
    const healthOutcome: EngineHealthOutcome =
      code === undefined ? "success" : code === "blocked" || code === "timeout" || code === "rate_limited" ? code : "other_failure";
    let circuitState: EngineBreakerDecision["state"] = "closed";
    try {
      circuitState = (await this.deps.breakers.for(engineKey).recordOutcome(breakerOutcome)).state;
    } catch (error) {
      logger.warn(`failed to record a breaker outcome for '${engineKey}': ${error instanceof Error ? error.message : "unknown"}`);
    }
    if (code === "rate_limited") {
      await this.deps.refill.trigger(engineKey).catch((error: unknown) => {
        logger.warn(`failed to trigger the refill reduction for '${engineKey}': ${error instanceof Error ? error.message : "unknown"}`);
      });
    }
    await this.deps.health
      .recordAttempt({
        engineKey,
        atMs: this.now(),
        outcome: healthOutcome,
        ...(attempt.outcome === "success" ? { latencyMs: attempt.latencyMs } : {}),
        circuitState,
      })
      .catch((error: unknown) => {
        logger.warn(`failed to record engine health for '${engineKey}': ${error instanceof Error ? error.message : "unknown"}`);
      });
  }
}
