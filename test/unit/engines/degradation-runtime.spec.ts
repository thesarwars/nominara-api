import { describe, expect, it } from "vitest";
import type { EngineKey } from "../../../src/lib/engines/contract.js";
import { DEGRADATION_STAGE_5_OPEN_DURATION_MS } from "../../../src/lib/engines/degradation.js";
import { DegradationRuntime } from "../../../src/lib/engines/degradation-runtime.js";
import type { EngineBreakerDetail } from "../../../src/lib/engines/engine-breaker.js";

// STORY-031 AC6/AC7 — "The six-stage ladder is implemented and applied AUTOMATICALLY." Until this every rung above stage 1 was
// a unit-tested module with no runtime caller (status check 2026-10-12). The evaluator ticks on its own clock, independent of
// customer traffic like the canary, reads each engine's breaker, resolves the stage and drives:
//   stage 3 — the request-shaping rotation (through the default port until STORY-028/029 bring profiles),
//   stage 5 — `engines.status = 'degraded'`, and back to `active` once the breaker has closed again.
// Stage 2 is driven at the attempt (capture-engine-gate), stage 4 by the breaker itself, stage 6 is STORY-179's.

const NOW = 50_000_000_000;
const closed: EngineBreakerDetail = { state: "closed", openedAt: null, since: null, reason: null };

function harness(details: Partial<Record<EngineKey, EngineBreakerDetail>>, ratios: Partial<Record<EngineKey, number>> = {}, failing: EngineKey[] = []) {
  const degraded: EngineKey[] = [];
  const recovered: EngineKey[] = [];
  const observed: [EngineKey, number][] = [];
  const runtime = new DegradationRuntime({
    engines: ["gemini", "chatgpt", "claude"],
    breakers: {
      for: (key) => ({
        detail: () => (failing.includes(key as EngineKey) ? Promise.reject(new Error("down")) : Promise.resolve(details[key as EngineKey] ?? closed)),
        blockRatio: () => Promise.resolve(ratios[key as EngineKey] ?? 0),
      }),
    },
    status: {
      markDegraded: (key) => {
        degraded.push(key);
        return Promise.resolve();
      },
      markRecovered: (key) => {
        recovered.push(key);
        return Promise.resolve();
      },
    },
    shaping: {
      onRatioObserved: (key, ratio) => {
        observed.push([key, ratio]);
        return Promise.resolve();
      },
    },
    clock: () => NOW,
  });
  return { runtime, degraded, recovered, observed };
}

describe("STORY-031 AC7 · test scenario 4 — a circuit held open past 30 minutes marks the engine degraded", () => {
  it("marks ONLY the engine whose episode is older than 30 minutes, and leaves the others alone (AC10)", async () => {
    const h = harness({ gemini: { state: "open", openedAt: NOW - 1_000, since: NOW - DEGRADATION_STAGE_5_OPEN_DURATION_MS - 1, reason: "ratio" } });
    const stages = await h.runtime.tick();
    expect(h.degraded).toEqual(["gemini"]);
    expect(stages.get("gemini")).toBe(5);
    expect(stages.get("chatgpt")).toBeNull();
  });

  it("an episode of exactly 30 minutes is not degraded yet", async () => {
    const h = harness({ gemini: { state: "open", openedAt: NOW - 1_000, since: NOW - DEGRADATION_STAGE_5_OPEN_DURATION_MS, reason: "ratio" } });
    await h.runtime.tick();
    expect(h.degraded).toEqual([]);
  });

  it("a half-open breaker still in the same long episode stays degraded (the half-open window is not recovery)", async () => {
    const h = harness({ gemini: { state: "half_open", openedAt: NOW - 1_300_000, since: NOW - 3 * DEGRADATION_STAGE_5_OPEN_DURATION_MS, reason: "ratio" } });
    await h.runtime.tick();
    expect(h.degraded).toEqual(["gemini"]);
    expect(h.recovered).not.toContain("gemini");
  });

  it("a closed breaker hands a degraded engine back to active (the ladder owns `degraded` in both directions)", async () => {
    const h = harness({});
    await h.runtime.tick();
    expect(h.recovered).toEqual(["gemini", "chatgpt", "claude"]);
    expect(h.degraded).toEqual([]);
  });
});

describe("STORY-031 AC6 · stage 3 — the observed block ratio reaches the request-shaping coordinator every tick", () => {
  it("passes each engine's current ratio (the coordinator rotates once per breach and resets below the threshold)", async () => {
    const h = harness({}, { gemini: 0.12, chatgpt: 0.02 });
    const stages = await h.runtime.tick();
    expect(h.observed).toEqual([
      ["gemini", 0.12],
      ["chatgpt", 0.02],
      ["claude", 0],
    ]);
    expect(stages.get("gemini")).toBe(3);
  });
});

describe("STORY-031 · the evaluator is best-effort", () => {
  it("an engine whose breaker cannot be read is skipped; the others are still evaluated", async () => {
    const h = harness({ claude: { state: "open", openedAt: NOW, since: NOW - DEGRADATION_STAGE_5_OPEN_DURATION_MS - 5, reason: "quota" } }, {}, ["gemini"]);
    await expect(h.runtime.tick()).resolves.toBeInstanceOf(Map);
    expect(h.degraded).toEqual(["claude"]);
    expect(h.recovered).toEqual(["chatgpt"]);
  });
});
