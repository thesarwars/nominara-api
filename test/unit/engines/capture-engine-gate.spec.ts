import { describe, expect, it } from "vitest";
import type { EngineHealthEvent } from "../../../src/modules/health/engine-health.service.js";
import {
  BreakerCaptureEngineGate,
  ENGINE_BREAKER_REQUEUE_DELAY_MS,
  ENGINE_SKIP_DEGRADED,
  ENGINE_SKIP_QUOTA_EXHAUSTED,
  type EngineBreakerView,
} from "../../../src/lib/engines/capture-engine-gate.js";
import type { EngineBreakerDetail, EngineOutcome } from "../../../src/lib/engines/engine-breaker.js";
import { DEGRADATION_STAGE_5_OPEN_DURATION_MS } from "../../../src/lib/engines/degradation.js";

// STORY-031 — what the CUSTOMER capture path asks the breaker before it dispatches a cell, and what it tells the breaker and
// the health buckets after. Until this, only the canary fed either (status check 2026-10-12, AC3/AC4).

const NOW = 10_000_000_000;

function fakeBreaker(detail: EngineBreakerDetail, recorded: EngineOutcome[] = [], failing = false): EngineBreakerView {
  return {
    detail: () => (failing ? Promise.reject(new Error("valkey down")) : Promise.resolve(detail)),
    recordOutcome: (outcome) => {
      recorded.push(outcome);
      if (failing) return Promise.reject(new Error("valkey down"));
      return Promise.resolve({ state: outcome === "quota_exhausted" ? "open" : detail.state, retry: outcome !== "quota_exhausted" });
    },
  };
}

function gate(detail: EngineBreakerDetail, over: { recorded?: EngineOutcome[]; health?: EngineHealthEvent[]; refill?: string[]; failing?: boolean } = {}) {
  const health = over.health ?? [];
  const refill = over.refill ?? [];
  return new BreakerCaptureEngineGate({
    breakers: { for: () => fakeBreaker(detail, over.recorded, over.failing) },
    health: {
      recordAttempt: (event) => {
        health.push(event);
        return over.failing ? Promise.reject(new Error("pg down")) : Promise.resolve();
      },
    },
    refill: {
      trigger: (engineKey) => {
        refill.push(engineKey);
        return over.failing ? Promise.reject(new Error("valkey down")) : Promise.resolve();
      },
    },
    clock: () => NOW,
  });
}

const closed: EngineBreakerDetail = { state: "closed", openedAt: null, since: null, reason: null };

describe("STORY-031 AC3 · admission before dispatch", () => {
  it("a closed breaker admits", async () => {
    expect(await gate(closed).admit("gemini")).toEqual({ kind: "admit" });
  });

  it("a half-open breaker admits (the probe)", async () => {
    expect(await gate({ state: "half_open", openedAt: NOW - 1, since: NOW - 1, reason: "ratio" }).admit("gemini")).toEqual({ kind: "admit" });
  });

  it("[EC-06 stage 4] a ratio-opened breaker re-queues the cell with the 20-minute delay rather than failing it", async () => {
    expect(ENGINE_BREAKER_REQUEUE_DELAY_MS).toBe(20 * 60 * 1000);
    const admission = await gate({ state: "open", openedAt: NOW - 60_000, since: NOW - 60_000, reason: "ratio" }).admit("gemini");
    expect(admission).toEqual({ kind: "redelay", delayMs: ENGINE_BREAKER_REQUEUE_DELAY_MS });
  });

  it("[EC-08] a quota-opened breaker skips the cell (held for the next window), never re-queues it inside this run", async () => {
    const admission = await gate({ state: "open", openedAt: NOW - 1_000, since: NOW - 1_000, reason: "quota" }).admit("gemini");
    expect(admission).toEqual({ kind: "skip", errorCode: ENGINE_SKIP_QUOTA_EXHAUSTED, since: new Date(NOW - 1_000) });
  });

  it("[EC-06 stage 5] a breaker open for MORE than 30 minutes skips the cell as engine_degraded, so the run completes as partial", async () => {
    const since = NOW - DEGRADATION_STAGE_5_OPEN_DURATION_MS - 1;
    const admission = await gate({ state: "open", openedAt: NOW - 1_000, since, reason: "ratio" }).admit("gemini");
    expect(admission).toEqual({ kind: "skip", errorCode: ENGINE_SKIP_DEGRADED, since: new Date(since) });
  });

  it("exactly 30 minutes is not yet stage 5 (strict >)", async () => {
    const admission = await gate({ state: "open", openedAt: NOW - 1_000, since: NOW - DEGRADATION_STAGE_5_OPEN_DURATION_MS, reason: "ratio" }).admit("gemini");
    expect(admission.kind).toBe("redelay");
  });

  it("an unreadable breaker admits: capture is never stopped by a cache outage (D19)", async () => {
    expect(await gate(closed, { failing: true }).admit("gemini")).toEqual({ kind: "admit" });
  });
});

describe("STORY-031 AC3/AC4/AC6 · every customer attempt feeds the breaker and the health buckets", () => {
  it("a capture is a breaker success and a health success with its latency", async () => {
    const recorded: EngineOutcome[] = [];
    const health: EngineHealthEvent[] = [];
    await gate(closed, { recorded, health }).record("gemini", { outcome: "success", latencyMs: 812 });
    expect(recorded).toEqual(["success"]);
    expect(health).toEqual([{ engineKey: "gemini", atMs: NOW, outcome: "success", latencyMs: 812, circuitState: "closed" }]);
  });

  it("quota_exhausted opens the breaker (EC-08) and is an other_failure in the health buckets", async () => {
    const recorded: EngineOutcome[] = [];
    const health: EngineHealthEvent[] = [];
    await gate(closed, { recorded, health }).record("gemini", { outcome: "failure", code: "quota_exhausted" });
    expect(recorded).toEqual(["quota_exhausted"]);
    expect(health).toEqual([{ engineKey: "gemini", atMs: NOW, outcome: "other_failure", circuitState: "open" }]);
  });

  it("blocked feeds the block ratio; timeout and rate_limited land in their own health counters", async () => {
    const recorded: EngineOutcome[] = [];
    const health: EngineHealthEvent[] = [];
    const g = gate(closed, { recorded, health });
    await g.record("gemini", { outcome: "failure", code: "blocked" });
    await g.record("gemini", { outcome: "failure", code: "timeout" });
    await g.record("gemini", { outcome: "failure", code: "rate_limited" });
    await g.record("gemini", { outcome: "failure", code: "upstream_5xx" });
    expect(recorded).toEqual(["blocked", "other_failure", "other_failure", "other_failure"]);
    expect(health.map((e) => e.outcome)).toEqual(["blocked", "timeout", "rate_limited", "other_failure"]);
  });

  it("[EC-06 stage 2] rate_limited halves the engine's refill; nothing else does", async () => {
    const refill: string[] = [];
    const g = gate(closed, { refill });
    await g.record("gemini", { outcome: "failure", code: "timeout" });
    await g.record("gemini", { outcome: "failure", code: "rate_limited" });
    expect(refill).toEqual(["gemini"]);
  });

  it("recording never throws, whatever is down (it must never fail the cell that was just captured)", async () => {
    await expect(gate(closed, { failing: true }).record("gemini", { outcome: "failure", code: "rate_limited" })).resolves.toBeUndefined();
    await expect(gate(closed, { failing: true }).record("gemini", { outcome: "success", latencyMs: 1 })).resolves.toBeUndefined();
  });
});
