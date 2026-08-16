import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from "@nestjs/common";
import { HealthCheckService, HealthIndicatorService, type HealthCheckResult } from "@nestjs/terminus";
import type { Pool } from "pg";
import type {
  DependencyHealth,
  LivenessResponse,
  QueueDepth,
  ReadinessResponse,
} from "../../../contracts/common/health.schema.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { appliedMigrationNames, listMigrationFiles } from "../../db/migrate-runner.js";
import { CircuitBreaker } from "../../lib/resilience/circuit-breaker.js";

// STORY-022 — HealthModule (system-architecture.md §5): "Liveness,
// readiness, circuit-breaker state, queue depth" with `@nestjs/terminus` as
// its key dependency. Liveness never touches Postgres — it answers only "is
// the process up" (scenario 1). Readiness additionally fails until the
// applied migration set matches what this build expects (NFR-ARCH-06,
// scenario 2), and reports the Postgres circuit breaker's state
// (NFR-ARCH-05, scenario 3) — via a real Terminus health indicator
// (HealthIndicatorService), not a hand-rolled equivalent.

interface MigrationState {
  applied: string | null;
  expected: string | null;
  matches: boolean;
}

// Overridable in tests (e.g. the rollback-superset boundary case, which
// points this at an isolated directory with a deliberately older/smaller
// migration set than what the real database has already applied) — not
// bound to a value anywhere except HealthModule, which defaults it to the
// real MIGRATIONS_DIR.
export const MIGRATIONS_DIR_TOKEN = Symbol("HEALTH_MIGRATIONS_DIR");

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  // NFR-ARCH-05's exact numbers (50% error threshold, 30s open, 3-request
  // half-open) — sampleSize is this class's own implementation detail, not
  // one of those reference constants.
  private readonly postgresBreaker = new CircuitBreaker({ name: "postgres" });
  private lastMigrationState: MigrationState = { applied: null, expected: null, matches: false };

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Optional() @Inject(MIGRATIONS_DIR_TOKEN) private readonly migrationsDir: string | undefined,
    private readonly healthCheckService: HealthCheckService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  liveness(): LivenessResponse {
    return { status: "ok" };
  }

  async readiness(): Promise<ReadinessResponse> {
    let result: HealthCheckResult;
    try {
      result = await this.healthCheckService.check([() => this.postgresIndicator()]);
    } catch (error) {
      // HealthCheckService.check() throws ServiceUnavailableException with
      // the same result shape once any indicator reports "down" — caught
      // here so this method can still return our own contract shape
      // (readinessResponseSchema) instead of Terminus's default response.
      if (error instanceof ServiceUnavailableException) {
        result = error.getResponse() as HealthCheckResult;
      } else {
        throw error;
      }
    }

    const postgresDetail = result.details["postgres"] as { status: "up" | "down" } | undefined;
    const dependencies: DependencyHealth[] = [
      {
        name: "postgres",
        state: this.postgresBreaker.state,
        healthy: postgresDetail?.status === "up",
      },
    ];
    // STORY-022-E-5 — reserved, always empty until STORY-030 wires BullMQ.
    const queues: QueueDepth[] = [];

    const ready = result.status === "ok" && this.lastMigrationState.matches;
    this.logger.log(`readiness check: ${ready ? "ready" : "not_ready"}`);

    return {
      status: ready ? "ready" : "not_ready",
      migrationVersion: this.lastMigrationState,
      dependencies,
      queues,
    };
  }

  /**
   * The Postgres dependency as a Terminus health indicator. The circuit
   * breaker (NFR-ARCH-05) still owns open/closed/half-open bookkeeping —
   * this only reports through HealthIndicatorService the same way any
   * other Terminus indicator would.
   */
  private async postgresIndicator() {
    const indicator = this.healthIndicatorService.check("postgres");
    const state: MigrationState = { applied: null, expected: null, matches: false };

    try {
      await this.postgresBreaker.execute(() => this.checkMigrationState(state));
      this.lastMigrationState = state;
      return indicator.up({ breakerState: this.postgresBreaker.state });
    } catch (error) {
      this.lastMigrationState = state;
      return indicator.down({ breakerState: this.postgresBreaker.state, message: (error as Error).message });
    }
  }

  /**
   * expected = the newest migration file this BUILD knows about.
   * matches = every migration file this build knows about is applied — a
   * database that has additionally applied a NEWER migration than this
   * build's own directory (the rollback-superset boundary case: an older
   * build still running during/after a rolling deploy) still counts as
   * ready, since migrations are expand/contract only and therefore
   * backward-compatible.
   */
  private async checkMigrationState(state: MigrationState): Promise<void> {
    const client = await this.pool.connect();
    try {
      const files = await listMigrationFiles(this.migrationsDir);
      const expectedNames = files.map((f) => f.name);
      state.expected = expectedNames.length > 0 ? expectedNames[expectedNames.length - 1]! : null;

      const appliedSet = await appliedMigrationNames(client);
      const appliedSorted = Array.from(appliedSet).sort();
      state.applied = appliedSorted.length > 0 ? appliedSorted[appliedSorted.length - 1]! : null;
      state.matches = expectedNames.every((name) => appliedSet.has(name));
    } finally {
      client.release();
    }
  }
}
