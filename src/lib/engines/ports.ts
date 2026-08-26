import { Logger } from "@nestjs/common";
import { incrementCounter } from "../telemetry/metrics.js";
import type { EngineKey } from "./contract.js";

// STORY-031 D14 — ports, not integrations (same posture as STORY-030's D10
// Pager port, src/lib/queue/dead-letter.ts). No real backend exists yet for
// any of these three seams:
//   - EngineDegradedEmitter: no per-channel realtime emitter exists yet.
//   - RequestShapingRotator: no shaping profiles exist until STORY-028/029.
//   - CellRequeuePort: no in-flight cell registry exists until STORY-032.
// Every default implementation only logs and increments a counter — never
// a network call, never a thrown error.

const logger = new Logger("engine-ports");

export interface EngineDegradedEmitter {
  emit(engineKey: EngineKey): void;
}

export const defaultEngineDegradedEmitter: EngineDegradedEmitter = {
  emit(engineKey: EngineKey): void {
    logger.warn({ message: "engine marked degraded", engineKey });
    incrementCounter("nominara_engine_degraded_total", { engine_key: engineKey });
  },
};

export interface RequestShapingRotator {
  rotate(engineKey: EngineKey): void;
}

export const defaultRequestShapingRotator: RequestShapingRotator = {
  rotate(engineKey: EngineKey): void {
    logger.warn({ message: "request-shaping profile rotation requested", engineKey });
    incrementCounter("nominara_engine_shaping_rotation_total", { engine_key: engineKey });
  },
};

export interface CellRequeuePort {
  requeue(engineKey: EngineKey, delayMs: number): void;
}

export const defaultCellRequeuePort: CellRequeuePort = {
  requeue(engineKey: EngineKey, delayMs: number): void {
    logger.warn({ message: "in-flight cell requeue requested", engineKey, delayMs });
    incrementCounter("nominara_engine_cell_requeue_total", { engine_key: engineKey });
  },
};
