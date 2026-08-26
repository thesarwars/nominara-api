import type { EngineKey } from "./contract.js";
import type { EngineDegradedEmitter } from "./ports.js";

// STORY-031 Phase G stage 5 — the AC's "coalesced <=1/min/engine"
// requirement. In-process dedup, same shape as DlqDepthMonitor's own
// "pages exactly once per sustained breach" (src/lib/queue/dead-letter.ts)
// — a plain Map, not Valkey-shared: an emission burst is a UX/noise
// concern, not a correctness one, so per-replica dedup is sufficient here.

/** 1 minute — the AC's own stated coalescing window. */
export const DEGRADED_EMIT_COALESCE_WINDOW_MS = 60_000;

export class CoalescingEngineDegradedEmitter implements EngineDegradedEmitter {
  private readonly lastEmittedAtMs = new Map<EngineKey, number>();

  constructor(
    private readonly inner: EngineDegradedEmitter,
    private readonly coalesceWindowMs: number = DEGRADED_EMIT_COALESCE_WINDOW_MS,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  emit(engineKey: EngineKey): void {
    const now = this.clock();
    const last = this.lastEmittedAtMs.get(engineKey);
    if (last !== undefined && now - last < this.coalesceWindowMs) {
      return;
    }
    this.lastEmittedAtMs.set(engineKey, now);
    this.inner.emit(engineKey);
  }
}
