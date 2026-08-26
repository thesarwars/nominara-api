import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "../../db/pg-pool.js";
import type { EngineKey } from "../../lib/engines/contract.js";

// STORY-031 Phase G stage 5 — `engines` (like `engine_health`) is global,
// not tenant-scoped, so this queries the pool directly. D11: no migration —
// `engines.status` and its `degraded` CHECK value already exist
// (0003_projects_prompts_captures.up.sql).

@Injectable()
export class EngineStatusService {
  private readonly logger = new Logger(EngineStatusService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Idempotent: a WHERE guard means re-marking an already-degraded engine is a no-op, never a redundant write. */
  async markDegraded(engineKey: EngineKey): Promise<void> {
    try {
      await this.pool.query("UPDATE engines SET status = 'degraded' WHERE key = $1 AND status != 'degraded'", [engineKey]);
    } catch (error) {
      // D19's spirit extended here — recording degraded status must never
      // fail whatever triggered the detection.
      this.logger.warn(`failed to mark engine '${engineKey}' degraded: ${(error as Error).message}`);
    }
  }
}
