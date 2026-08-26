import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { DEGRADATION_STAGE_3_RATIO_THRESHOLD } from "./degradation.js";
import type { EngineKey } from "./contract.js";
import type { RequestShapingRotator } from "./ports.js";

// STORY-031 Phase G stage 3 — EC-06: "blocks/attempts > 0.10 → rotate the
// request-shaping profile." Rotates AT MOST ONCE per sustained breach — the
// same "pages exactly once per sustained breach... a later breach pages
// again" shape DlqDepthMonitor already establishes (src/lib/queue/dead-letter.ts),
// applied here to a rotation instead of a page.

const logger = new Logger("engine-request-shaping-coordinator");

export interface BreachTrackerStore {
  read(engineKey: EngineKey): Promise<boolean>;
  write(engineKey: EngineKey, inBreach: boolean): Promise<void>;
}

/** D5-style shared state — a rotation triggered by one replica's observation must be visible fleet-wide, so a DIFFERENT replica's next observation doesn't redundantly rotate again for the SAME breach episode. */
export class ValkeyBreachTrackerStore implements BreachTrackerStore {
  private static readonly KEY_PREFIX = "engine-shaping-breach";
  private static readonly TTL_SECONDS = 60 * 60;

  constructor(private readonly redis: Redis) {}

  async read(engineKey: EngineKey): Promise<boolean> {
    const raw = await this.redis.get(`${ValkeyBreachTrackerStore.KEY_PREFIX}:${engineKey}`);
    return raw === "1";
  }

  async write(engineKey: EngineKey, inBreach: boolean): Promise<void> {
    try {
      const key = `${ValkeyBreachTrackerStore.KEY_PREFIX}:${engineKey}`;
      if (inBreach) {
        await this.redis.set(key, "1", "EX", ValkeyBreachTrackerStore.TTL_SECONDS);
      } else {
        await this.redis.del(key);
      }
    } catch (error) {
      logger.warn(`failed to persist shaping-breach state for engine '${engineKey}' — best-effort: ${(error as Error).message}`);
    }
  }
}

export class RequestShapingCoordinator {
  constructor(
    private readonly rotator: RequestShapingRotator,
    private readonly store: BreachTrackerStore,
  ) {}

  /**
   * Call with the CURRENT blocks/attempts ratio each time an outcome is
   * recorded. Phase J/D19's spirit — a read failure never throws: it falls
   * back to "not yet rotated", so a genuine breach still triggers a
   * rotation (a redundant rotation attempt is harmless; silently skipping
   * one during a real breach is not).
   */
  async onRatioObserved(engineKey: EngineKey, blockRatio: number): Promise<void> {
    const currentlyInBreach = blockRatio > DEGRADATION_STAGE_3_RATIO_THRESHOLD;
    let alreadyRotatedForThisBreach = false;
    try {
      alreadyRotatedForThisBreach = await this.store.read(engineKey);
    } catch (error) {
      logger.warn(`failed to read shaping-breach state for engine '${engineKey}' — assuming not yet rotated: ${(error as Error).message}`);
    }

    if (currentlyInBreach && !alreadyRotatedForThisBreach) {
      this.rotator.rotate(engineKey);
      await this.persist(engineKey, true);
    } else if (!currentlyInBreach && alreadyRotatedForThisBreach) {
      await this.persist(engineKey, false);
    }
  }

  private async persist(engineKey: EngineKey, inBreach: boolean): Promise<void> {
    try {
      await this.store.write(engineKey, inBreach);
    } catch (error) {
      logger.warn(`failed to persist shaping-breach state for engine '${engineKey}' — best-effort: ${(error as Error).message}`);
    }
  }
}
