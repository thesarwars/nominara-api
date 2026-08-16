// STORY-022 — system-architecture.md NFR-ARCH-05: "Every external dependency
// is wrapped in a circuit breaker (50% error threshold, 30 s open, 3-request
// half-open) with a per-dependency health metric on /health." A generic
// primitive here, demonstrated against Postgres (the one real dependency
// this repo has today) by HealthService.

export type CircuitState = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  constructor(dependencyName?: string) {
    super(
      dependencyName
        ? `circuit breaker for '${dependencyName}' is open`
        : "circuit breaker is open",
    );
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerConfig {
  /** NFR-ARCH-05 — a rolling error rate at or above this percentage opens the breaker. */
  readonly errorThresholdPercentage: number;
  /** NFR-ARCH-05 — how long the breaker stays open before trialing again. */
  readonly openDurationMs: number;
  /** NFR-ARCH-05 — consecutive successful trial calls required to close from half-open. */
  readonly halfOpenMaxTrials: number;
  /**
   * Number of most-recent calls the error rate is computed over. NOT a
   * reference constant from NFR-ARCH-05 (which specifies no sample size) —
   * an implementation detail, overridable per instance/test.
   */
  readonly sampleSize: number;
  /** Injectable clock, real Date.now by default — overridden by tests only. */
  readonly clock: () => number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  errorThresholdPercentage: 50,
  openDurationMs: 30_000,
  halfOpenMaxTrials: 3,
  sampleSize: 20,
  clock: () => Date.now(),
};

export interface CircuitBreakerOptions extends Partial<CircuitBreakerConfig> {
  /** Named in the CircuitOpenError message and in HealthService's dependency report. */
  readonly name?: string;
}

export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private readonly dependencyName: string | undefined;
  private internalState: CircuitState = "closed";
  private openedAt: number | undefined;
  private window: boolean[] = [];
  private halfOpenSuccesses = 0;
  // NFR-ARCH-05 "3-request half-open" — an admission cap, not just a
  // close-on-3-successes counter: at most halfOpenMaxTrials CONCURRENT
  // trial calls may reach fn() at once during half-open.
  private halfOpenInFlight = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    const { name, ...configOverrides } = options;
    this.dependencyName = name;
    this.config = { ...DEFAULT_CONFIG, ...configOverrides };
  }

  /** The EFFECTIVE state, computed from the clock — a pure read, never mutates. */
  get state(): CircuitState {
    if (this.internalState === "open" && this.openedAt !== undefined) {
      const elapsed = this.config.clock() - this.openedAt;
      if (elapsed >= this.config.openDurationMs) {
        return "half_open";
      }
    }
    return this.internalState;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const effective = this.state;

    if (effective === "open") {
      throw new CircuitOpenError(this.dependencyName);
    }

    if (effective === "half_open") {
      if (this.internalState === "open") {
        // First trial call after the open duration elapsed — transition now.
        this.internalState = "half_open";
        this.halfOpenSuccesses = 0;
        this.halfOpenInFlight = 0;
      }

      if (this.halfOpenInFlight >= this.config.halfOpenMaxTrials) {
        // Already halfOpenMaxTrials concurrent trials in flight — admit no
        // more, same rejection a fully open breaker gives.
        throw new CircuitOpenError(this.dependencyName);
      }

      this.halfOpenInFlight += 1;
      try {
        const result = await fn();
        // A concurrent trial's failure may have already reopened the
        // breaker (see catch below) — a late success from a DIFFERENT
        // in-flight trial must not then close it back over that.
        if (this.internalState === "half_open") {
          this.halfOpenSuccesses += 1;
          if (this.halfOpenSuccesses >= this.config.halfOpenMaxTrials) {
            this.close();
          }
        }
        return result;
      } catch (error) {
        this.open();
        throw error;
      } finally {
        this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      }
    }

    try {
      const result = await fn();
      this.record(true);
      return result;
    } catch (error) {
      this.record(false);
      throw error;
    }
  }

  private record(success: boolean): void {
    this.window.push(success);
    if (this.window.length > this.config.sampleSize) {
      this.window.shift();
    }
    if (this.window.length === this.config.sampleSize) {
      const failures = this.window.filter((ok) => !ok).length;
      const errorRate = (failures / this.config.sampleSize) * 100;
      if (errorRate >= this.config.errorThresholdPercentage) {
        this.open();
      }
    }
  }

  private open(): void {
    this.internalState = "open";
    this.openedAt = this.config.clock();
    this.window = [];
    this.halfOpenSuccesses = 0;
  }

  private close(): void {
    this.internalState = "closed";
    this.openedAt = undefined;
    this.window = [];
    this.halfOpenSuccesses = 0;
  }
}
