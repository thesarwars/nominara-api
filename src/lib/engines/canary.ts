import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { ClientBase } from "pg";
import { withGlobalQueueLock } from "../queue/locks.js";
import type { EngineKey } from "./contract.js";

// STORY-031 Phase F — D2/EC-06: "a per-engine synthetic canary every 5
// minutes independent of customer load". This is ONLY that 5-minute
// engine-health canary — NOT ci-cd-and-environments.md:167's different
// 15-minute parse-fidelity canary (STORY-028/029's scope). A plain
// injectable-clock class matching DlqDepthMonitor's existing style
// (src/lib/queue/dead-letter.ts): passive, invoked externally on whatever
// schedule the caller runs (a real setInterval in production,
// probeAllIfDue() called directly in tests) — it decides internally
// whether a round is actually DUE, rather than self-scheduling a timer.

const logger = new Logger("engine-canary");

/** EC-06 — the exact reference constant. */
export const CANARY_INTERVAL_MS = 5 * 60 * 1000;

export interface CanaryProbeResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly detail?: string;
}

export interface CanaryDueStore {
  /** Last successful round's start time (epoch ms), or null if none yet. */
  read(): Promise<number | null>;
  write(atMs: number): Promise<void>;
}

/**
 * D9 — no 22nd queue; this is a plain interval-runner primitive, not a
 * BullMQ queue/worker. Cross-replica election (D9: "elected across
 * replicas via withGlobalQueueLock") is composed OUTSIDE this class by the
 * caller — see runElectedCanaryRound() below — this class only decides
 * "is a round due right now", so that a replica which loses the election
 * and only gets its turn AFTER another replica already ran one sees "not
 * due" and skips, rather than double-probing.
 */
export class EngineCanary {
  constructor(
    private readonly engines: readonly EngineKey[],
    private readonly probeEngine: (engineKey: EngineKey) => Promise<CanaryProbeResult>,
    private readonly onResult: (engineKey: EngineKey, result: CanaryProbeResult) => Promise<void> | void,
    private readonly dueStore: CanaryDueStore,
    private readonly intervalMs: number = CANARY_INTERVAL_MS,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Returns true if a round actually ran (probed every configured engine
   * once), false if it wasn't due yet. Phase J/D19's spirit — a due-store
   * read failure fails OPEN (assumes due, runs the round anyway) rather
   * than silently disabling detection for however long the store stays
   * down: a probe round is cheap, and AC8's whole point is that detection
   * must not depend on anything else working perfectly either.
   */
  async probeAllIfDue(): Promise<boolean> {
    let lastProbedAtMs: number | null;
    try {
      lastProbedAtMs = await this.dueStore.read();
    } catch (error) {
      logger.warn(`canary due-store unreadable — failing open (running this round): ${(error as Error).message}`);
      lastProbedAtMs = null;
    }

    const now = this.clock();
    if (lastProbedAtMs !== null && now - lastProbedAtMs < this.intervalMs) {
      return false;
    }

    await this.dueStore.write(now).catch((error: unknown) => {
      logger.warn(`canary due-store unwritable — best-effort: ${error instanceof Error ? error.message : String(error)}`);
    });

    for (const engineKey of this.engines) {
      let result: CanaryProbeResult;
      try {
        result = await this.probeEngine(engineKey);
      } catch (error) {
        // D10 — a probe failure is data (it moves the block rate), never a
        // silently-swallowed exception that vanishes the canary itself.
        result = { ok: false, latencyMs: 0, detail: (error as Error).message };
      }
      try {
        await this.onResult(engineKey, result);
      } catch (error) {
        logger.warn(`canary onResult handler failed for engine '${engineKey}': ${(error as Error).message}`);
      }
    }

    return true;
  }
}

/**
 * D9 — the cross-replica election itself: `client` must already be inside
 * an open transaction (same precondition as every other `withGlobalQueueLock`
 * caller). Not a new 22nd queue — "engine.canary" here is only an advisory
 * lock NAMESPACE string, never registered in topology.ts. Two replicas
 * calling this concurrently SERIALIZE (one waits for the other's
 * transaction to commit); it is the shared `CanaryDueStore` behind
 * `canary.probeAllIfDue()` that then makes the loser's turn a no-op rather
 * than a second, redundant probe round.
 */
export async function runElectedCanaryRound(client: ClientBase, canary: EngineCanary): Promise<boolean> {
  return withGlobalQueueLock(client, "engine.canary", () => canary.probeAllIfDue());
}

const DUE_STORE_KEY = "engine-canary:last-probed-at";
/** Comfortably longer than the interval so a legitimate "last probed" marker is never evicted mid-window; an eviction just means the next check runs a round early (harmless — the canary is meant to run often anyway). */
const DUE_STORE_TTL_SECONDS = 60 * 60;

/** D5-style — shared across every replica via Valkey, so the "is it due" decision is fleet-wide, not per-process. */
export class ValkeyCanaryDueStore implements CanaryDueStore {
  constructor(private readonly redis: Redis) {}

  async read(): Promise<number | null> {
    const raw = await this.redis.get(DUE_STORE_KEY);
    return raw === null ? null : Number(raw);
  }

  async write(atMs: number): Promise<void> {
    try {
      await this.redis.set(DUE_STORE_KEY, String(atMs), "EX", DUE_STORE_TTL_SECONDS);
    } catch (error) {
      // Best-effort — D19's spirit: a store outage here just means the NEXT
      // replica to check also sees "due" and probes again — a harmless
      // extra round, never a failure of anything else.
      logger.warn(`failed to persist canary due-state — best-effort: ${(error as Error).message}`);
    }
  }
}
