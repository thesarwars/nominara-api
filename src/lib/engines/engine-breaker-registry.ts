import type { Redis } from "ioredis";
import {
  EngineBreaker,
  ENGINE_BREAKER_RATIO_WINDOW_MS,
  ValkeyEngineBreakerRatioCounter,
  ValkeyEngineBreakerStateStore,
} from "./engine-breaker.js";
import type { EngineKey } from "./contract.js";
import { resolveEngine } from "./registry.js";

// STORY-031 Phase D — AC9 ("one engine's breaker opening leaves the others
// capturing"). Isolation is automatic: every engine's breaker state lives
// under its OWN Valkey key (engine-breaker:state:<engineKey>,
// engine-breaker:ratio:<engineKey> — see engine-breaker.ts), so there is no
// shared mutable state ACROSS engines to leak between them, only within one.
//
// Cross-PROCESS sharing (D5) is Valkey itself, not this registry: each
// process constructs its OWN EngineBreakerRegistry instance (its in-memory
// Map below is purely a per-process memoization of EngineBreaker objects,
// never shared state), and every one of them reads/writes the SAME Valkey
// keys — that is what makes one process's open state visible to another's,
// and what makes it survive a process restart.

export class EngineBreakerRegistry {
  private readonly breakers = new Map<EngineKey, EngineBreaker>();

  constructor(
    private readonly redis: Redis,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Throws EngineRefusalError (via resolveEngine) for an unknown or disabled engine key — a breaker for a non-dispatching engine makes no sense. */
  for(engineKey: string): EngineBreaker {
    resolveEngine(engineKey);
    const key = engineKey as EngineKey;

    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new EngineBreaker(
        key,
        new ValkeyEngineBreakerStateStore(this.redis),
        new ValkeyEngineBreakerRatioCounter(this.redis, ENGINE_BREAKER_RATIO_WINDOW_MS, this.clock),
        this.clock,
      );
      this.breakers.set(key, breaker);
    }
    return breaker;
  }
}
