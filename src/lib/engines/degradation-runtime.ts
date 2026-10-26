import type { EngineKey } from "./contract.js";
import type { DegradationStage } from "./degradation.js";
import type { EngineBreakerDetail } from "./engine-breaker.js";

// STORY-031 AC6/AC7 — the periodic ladder evaluator. RED: the surface only.

export interface DegradationRuntimeOptions {
  readonly engines: readonly EngineKey[];
  readonly breakers: { for(engineKey: string): { detail(): Promise<EngineBreakerDetail>; blockRatio(): Promise<number> } };
  readonly status: { markDegraded(engineKey: EngineKey): Promise<void>; markRecovered(engineKey: EngineKey): Promise<void> };
  readonly shaping: { onRatioObserved(engineKey: EngineKey, blockRatio: number): Promise<void> };
  readonly clock?: () => number;
  readonly pollIntervalMs?: number;
}

export class DegradationRuntime {
  constructor(private readonly options: DegradationRuntimeOptions) {}

  tick(): Promise<Map<EngineKey, DegradationStage | null>> {
    return Promise.reject(new Error(`not implemented (${String(this.options.engines.length)} engines)`));
  }

  start(): void {}

  stop(): void {}
}
