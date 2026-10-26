import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { PG_POOL } from "../../db/pg-pool.js";
import type { EngineKey } from "../../lib/engines/contract.js";

// STORY-031 Phase G stage 5 — `engines` (like `engine_health`) is global,
// not tenant-scoped, so this queries the pool directly. D11: no migration —
// `engines.status` and its `degraded` CHECK value already exist
// (0003_projects_prompts_captures.up.sql).
//
// STORY-031 review fix — `engines.status` IS OPERATOR STATE (migration 0027: "an incident responder sets 'degraded' when a vendor
// is down. Re-seeding it back to 'active' resumes scheduling against a broken vendor, silently"). The ladder evaluator may move
// only what it owns:
//   markDegraded   ONLY `active` -> `degraded`. A `disabled` or `beta` engine is never touched, even though the canary keeps
//                  probing every registry engine whatever its DB status (so a disabled engine's breaker can open).
//   markRecovered  ONLY a `degraded` the LADDER wrote and nobody has touched since. Ownership is a mark on the cache holding the
//                  `updated_at` the ladder's own UPDATE produced (the touch_updated_at trigger stamps every UPDATE, operator
//                  edits included). Recovery is `WHERE status = 'degraded' AND updated_at = <that stamp>`: an operator who
//                  re-asserts `degraded`, or edits the row at all, changes the stamp and so takes ownership. No mark, or a mark
//                  that cannot be read, means "not ours" - the engine stays degraded until an operator flips it, the direction
//                  migration 0027 calls safe. The mark lives on the cache instance (no schema change), so losing the cache's data
//                  strands a ladder-degraded engine in `degraded` until an operator flips it - never guessed past.

/** The ladder's ownership marks: the `updated_at` stamp its own `degraded` write produced, per engine. */
export interface LadderDegradedMarks {
  /** Throws when unreadable (recovery then leaves the engine alone). */
  read(engineKey: EngineKey): Promise<string | null>;
  /** Throws when the mark could not be written (the degraded write is then undone, so no unowned `degraded` is left behind). */
  write(engineKey: EngineKey, stamp: string): Promise<void>;
  clear(engineKey: EngineKey): Promise<void>;
}

/** On the CACHE instance, beside the breaker it describes. No TTL: a mark must outlive any outage it marks. */
export class ValkeyLadderDegradedMarks implements LadderDegradedMarks {
  private static readonly KEY_PREFIX = "engine-ladder:degraded";

  constructor(private readonly redis: Redis) {}

  private key(engineKey: EngineKey): string {
    return `${ValkeyLadderDegradedMarks.KEY_PREFIX}:${engineKey}`;
  }

  read(engineKey: EngineKey): Promise<string | null> {
    return this.redis.get(this.key(engineKey));
  }

  async write(engineKey: EngineKey, stamp: string): Promise<void> {
    await this.redis.set(this.key(engineKey), stamp);
  }

  async clear(engineKey: EngineKey): Promise<void> {
    await this.redis.del(this.key(engineKey));
  }
}

@Injectable()
export class EngineStatusService {
  private readonly logger = new Logger(EngineStatusService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    /** Without marks the ladder can degrade but never recover (it cannot prove a `degraded` is its own). */
    private readonly marks: LadderDegradedMarks | null = null,
  ) {}

  /**
   * `active` -> `degraded`, and nothing else. Returns true only when THIS call changed the row (the stage-5 counter counts
   * transitions). Idempotent: an already-degraded, disabled or beta engine is a no-op. Best-effort: never throws.
   */
  async markDegraded(engineKey: EngineKey): Promise<boolean> {
    let stamp: string;
    try {
      const result = await this.pool.query<{ stamp: string }>(
        "UPDATE engines SET status = 'degraded' WHERE key = $1 AND status = 'active' RETURNING updated_at::text AS stamp",
        [engineKey],
      );
      if (result.rows[0] === undefined) return false;
      stamp = result.rows[0].stamp;
    } catch (error) {
      // D19's spirit extended here — recording degraded status must never
      // fail whatever triggered the detection.
      this.logger.warn(`failed to mark engine '${engineKey}' degraded: ${(error as Error).message}`);
      return false;
    }
    if (this.marks === null) return true;
    try {
      await this.marks.write(engineKey, stamp);
      return true;
    } catch (error) {
      // No mark means recovery could never prove this `degraded` was the ladder's. Undo exactly our own write (same stamp) and let
      // the next tick try again, rather than leave an engine out of planning that nobody owns.
      this.logger.warn(`failed to record the ladder's mark for '${engineKey}'; undoing the degraded write: ${(error as Error).message}`);
      await this.pool
        .query("UPDATE engines SET status = 'active' WHERE key = $1 AND status = 'degraded' AND updated_at = $2::timestamptz", [engineKey, stamp])
        .catch((undo: unknown) => this.logger.warn(`failed to undo the degraded write for '${engineKey}': ${(undo as Error).message}`));
      return false;
    }
  }

  /**
   * STORY-031 AC7 - the ladder's way back: `degraded` -> `active` once the breaker has closed, ONLY for a `degraded` the ladder
   * wrote and nobody has touched since (see the header). Idempotent and best-effort like the mark.
   */
  async markRecovered(engineKey: EngineKey): Promise<void> {
    if (this.marks === null) return;
    try {
      const stamp = await this.marks.read(engineKey);
      if (stamp === null) return;
      await this.pool.query("UPDATE engines SET status = 'active' WHERE key = $1 AND status = 'degraded' AND updated_at = $2::timestamptz", [engineKey, stamp]);
      // Recovered, or the row is no longer the ladder's (an operator changed it): either way the mark has done its job.
      await this.marks.clear(engineKey);
    } catch (error) {
      this.logger.warn(`failed to mark engine '${engineKey}' recovered: ${(error as Error).message}`);
    }
  }
}
