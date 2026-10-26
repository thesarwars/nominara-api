import { Logger } from "@nestjs/common";
import { incrementCounter } from "../telemetry/metrics.js";
import type { EngineKey } from "./contract.js";
import { resolveDegradationStage, type DegradationStage } from "./degradation.js";
import type { EngineBreakerDetail } from "./engine-breaker.js";

// STORY-031 AC6/AC7 — the periodic ladder evaluator, modelled on canary-runtime.ts: it ticks on its own clock in the capture
// worker group, independent of customer traffic, so the ladder advances whether or not anyone is capturing.
//
// Per active engine, each tick:
//   reads the breaker's episode and its rolling block ratio (engine-breaker.ts), resolves the EC-06 stage, and drives
//     stage 3 — `RequestShapingCoordinator.onRatioObserved` (rotates once per breach through the default port until
//               STORY-028/029 bring real shaping profiles; it also resets the breach once the ratio falls back),
//     stage 5 — `engines.status = 'degraded'` once the episode is older than 30 minutes,
//   and hands a degraded engine back to `active` once its breaker has CLOSED. The ladder owns `degraded` in both directions:
//   the planner excludes a degraded engine (`engines.status = 'active'`, plan-cells.ts), so a one-way mark would drop the engine
//   from every future run for good. An operator who wants an engine out uses `disabled`, which this never touches.
//
// Not here: stage 1 is the backoff ladder (backoff.ts), stage 2 is triggered per attempt (capture-engine-gate.ts) and applied at
// the lease, stage 4 is the breaker itself, stage 6 (blackout paging) is STORY-179's monitor. `engine.degraded` is published per
// WORKSPACE from the capture path (capture-execute.handler.ts), where the tenant and its affected projects are known; this
// evaluator holds no tenant context and publishes nothing.
//
// IDEMPOTENT ACROSS REPLICAS, so no election: markDegraded / markRecovered are guarded UPDATEs and the coordinator's breach
// state is shared in Valkey. Best-effort throughout: an engine whose breaker cannot be read is skipped for this tick.

const logger = new Logger("engine-degradation-runtime");

/** How often the ladder is evaluated. Stage 5's threshold is 30 minutes, so a 30-second tick marks within 1/60th of it. */
export const DEGRADATION_POLL_INTERVAL_MS = 30_000;

export interface DegradationRuntimeOptions {
  readonly engines: readonly EngineKey[];
  readonly breakers: { for(engineKey: string): { detail(): Promise<EngineBreakerDetail>; blockRatio(): Promise<number> } };
  readonly status: { markDegraded(engineKey: EngineKey): Promise<void>; markRecovered(engineKey: EngineKey): Promise<void> };
  readonly shaping: { onRatioObserved(engineKey: EngineKey, blockRatio: number): Promise<void> };
  readonly clock?: () => number;
  readonly pollIntervalMs?: number;
}

export class DegradationRuntime {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: DegradationRuntimeOptions) {}

  /** One evaluation of every engine. Never throws; returns the stage each evaluated engine resolved to. */
  async tick(): Promise<Map<EngineKey, DegradationStage | null>> {
    const now = (this.options.clock ?? Date.now)();
    const stages = new Map<EngineKey, DegradationStage | null>();
    for (const engineKey of this.options.engines) {
      try {
        const breaker = this.options.breakers.for(engineKey);
        const [detail, blockRatio] = await Promise.all([breaker.detail(), breaker.blockRatio()]);
        const open = detail.state !== "closed" && detail.since !== null;
        const stage = resolveDegradationStage({ blockRatio, circuitOpenDurationMs: open ? now - detail.since! : null, blackoutDurationMs: null });
        stages.set(engineKey, stage);
        await this.options.shaping.onRatioObserved(engineKey, blockRatio);
        if (stage !== null && stage >= 5) {
          await this.options.status.markDegraded(engineKey);
          incrementCounter("nominara_engine_ladder_stage5_total", { engine_key: engineKey });
        } else if (detail.state === "closed") {
          await this.options.status.markRecovered(engineKey);
        }
      } catch (error) {
        logger.warn(`ladder evaluation skipped for '${engineKey}' this tick: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }
    return stages;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        logger.warn(`unexpected ladder tick error: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.options.pollIntervalMs ?? DEGRADATION_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
