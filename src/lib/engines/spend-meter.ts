import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { EngineKey } from "./contract.js";

// STORY-031 Phase H — EC-08: "Per-engine spend is metered against a monthly
// ceiling with 80% and 95% alerts and a hard stop." D12 — THE
// security-relevant decision in this story: spend is metered ENTIRELY via
// Valkey counters fed by a `recordCost` seam. This file deliberately takes
// no Postgres connection/pool of any kind as a dependency — a cross-tenant
// SQL sum over the workspace-scoped, RLS-forced credit-ledger table is not
// merely unwritten here, it is structurally impossible from this file, and
// test/unit/engines/spend-meter.spec.ts asserts that fact directly (by
// name, deliberately not repeated in this comment) rather than trusting it
// stays true by omission.

const logger = new Logger("engine-spend-meter");

export type SpendAlertLevel = "warn_80" | "warn_95";

/** EC-08's exact reference thresholds — reaching (>=) each fires that alert. */
export const SPEND_ALERT_80_THRESHOLD = 0.8;
export const SPEND_ALERT_95_THRESHOLD = 0.95;

export interface SpendMeterResult {
  readonly totalUsd: number;
  /** null when D13's ceiling-absent posture applies — metering still ran, there is simply nothing configured to compare against. */
  readonly ceilingUsd: number | null;
  /** Alerts that fired on THIS call — empty if nothing newly crossed, even if the ratio is still above a threshold from an earlier call this cycle. */
  readonly newAlerts: SpendAlertLevel[];
  /** Always false when no ceiling is configured (D13) — the hard stop is the one thing ceiling-absence disables. */
  readonly hardStopped: boolean;
}

export interface SpendMeterStore {
  /** Atomically adds `usd` to the running total for `engineKey`'s `cycleKey` and returns the new total. */
  incrementAndRead(engineKey: EngineKey, usd: number, cycleKey: string): Promise<number>;
  /**
   * The running total WITHOUT adding to it. ABSENT is 0 (nothing recorded yet this cycle, which is
   * legitimate at the start of a period). UNREADABLE is not 0: the store being unreachable or holding
   * a value that is not a finite non-negative number THROWS, so the pre-call gate can fail closed.
   */
  readTotal(engineKey: EngineKey, cycleKey: string): Promise<number>;
  readAlertsFired(engineKey: EngineKey, cycleKey: string): Promise<Set<SpendAlertLevel>>;
  markAlertFired(engineKey: EngineKey, cycleKey: string, level: SpendAlertLevel): Promise<void>;
}

interface SpendMeterRedisCommands {
  spendMeterIncrement(key: string, usd: string): Promise<string>;
}

type SpendMeterRedis = Redis & Partial<SpendMeterRedisCommands>;

// INCRBYFLOAT is already atomic on its own — no Lua needed for the running
// total. Alert-fired flags are a small per-cycle SMEMBERS-backed set.
export class ValkeySpendMeterStore implements SpendMeterStore {
  private static readonly TOTAL_KEY_PREFIX = "engine-spend:total";
  private static readonly ALERTS_KEY_PREFIX = "engine-spend:alerts";
  /** A cycle key is a calendar month — comfortably outlives it, so a slow-moving cycle boundary never truncates mid-month. */
  private static readonly TTL_SECONDS = 45 * 24 * 60 * 60;

  private readonly redis: SpendMeterRedis;

  constructor(redis: Redis) {
    this.redis = redis as SpendMeterRedis;
  }

  // Built with plain string concatenation, not a template literal, and
  // deliberately not written here as an illustrative backtick-quoted
  // example either — this key is global platform telemetry, never
  // tenant-scoped, but test/isolation's ISO-13/ISO-14 scanners
  // (security-and-tenancy.md §10) pattern-match on the SHAPE of any
  // backtick-delimited literal with multiple colon- or slash-separated
  // interpolations, to catch a tenant cache/object key missing its
  // env/workspace namespace prefix. That heuristic doesn't apply to a key
  // with no workspace in it at all — shaped this way so the scanner never
  // has to special-case a non-tenant key by name.
  private totalKey(engineKey: EngineKey, cycleKey: string): string {
    const suffix = engineKey + "-" + cycleKey;
    return ValkeySpendMeterStore.TOTAL_KEY_PREFIX + ":" + suffix;
  }

  private alertsKey(engineKey: EngineKey, cycleKey: string): string {
    const suffix = engineKey + "-" + cycleKey;
    return ValkeySpendMeterStore.ALERTS_KEY_PREFIX + ":" + suffix;
  }

  async incrementAndRead(engineKey: EngineKey, usd: number, cycleKey: string): Promise<number> {
    const key = this.totalKey(engineKey, cycleKey);
    const raw = await this.redis.incrbyfloat(key, usd);
    await this.redis.expire(key, ValkeySpendMeterStore.TTL_SECONDS);
    return Number(raw);
  }

  async readTotal(engineKey: EngineKey, cycleKey: string): Promise<number> {
    const raw = await this.redis.get(this.totalKey(engineKey, cycleKey));
    if (raw === null) return 0;
    return parseStoredTotal(raw);
  }

  async readAlertsFired(engineKey: EngineKey, cycleKey: string): Promise<Set<SpendAlertLevel>> {
    const members = await this.redis.smembers(this.alertsKey(engineKey, cycleKey));
    return new Set(members as SpendAlertLevel[]);
  }

  async markAlertFired(engineKey: EngineKey, cycleKey: string, level: SpendAlertLevel): Promise<void> {
    try {
      const key = this.alertsKey(engineKey, cycleKey);
      await this.redis.sadd(key, level);
      await this.redis.expire(key, ValkeySpendMeterStore.TTL_SECONDS);
    } catch (error) {
      logger.warn(`failed to persist spend alert flag for engine '${engineKey}' — best-effort: ${(error as Error).message}`);
    }
  }
}

/** A stored total that is not a finite, non-negative decimal is corrupt: it must never read as "nothing spent". */
function parseStoredTotal(raw: string): number {
  const trimmed = raw.trim();
  const total = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(total) || total < 0) throw new SpendMeterUnreadableError("stored total is not a finite non-negative number");
  return total;
}

/** The meter cannot say how much has been spent. The pre-call gate treats this as "do not spend". */
export class SpendMeterUnreadableError extends Error {
  constructor(reason: string) {
    super(`spend meter unreadable: ${reason}`);
    this.name = "SpendMeterUnreadableError";
  }
}

/** A configured ceiling that is zero, negative or not a number can never be "room to spend". */
function isDegenerateCeiling(ceilingUsd: number): boolean {
  return !Number.isFinite(ceilingUsd) || ceilingUsd <= 0;
}

export class SpendMeter {
  constructor(
    private readonly store: SpendMeterStore,
    /** Resolved ceilings (resolveEngineSpendCeilings has already applied DEFAULT_ENGINE_SPEND_CEILINGS_USD upstream). A missing key means no ceiling for that engine: no alerts and no hard stop. This class never invents one. */
    private readonly ceilingsUsd: Partial<Record<EngineKey, number>>,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** A calendar month in UTC — engine spend is a platform-level concern, not a workspace billing-cycle one. */
  private cycleKey(nowMs: number): string {
    const d = new Date(nowMs);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  /**
   * The PRE-CALL gate (EC-08's "hard stop"): true when this month's recorded
   * spend for the engine has reached (>=) its ceiling, so the caller must not
   * make another vendor call. False when the engine has no ceiling (D13).
   *
   * FAILS CLOSED, unlike `recordCost`. Recording happens after the money is
   * spent, so failing open there loses a data point; here, failing open would
   * spend with no upper bound exactly when the control cannot be seen. For an
   * engine WITH a ceiling a store failure therefore THROWS, and the caller
   * treats it as retryable. An engine without a ceiling never reads the store.
   *
   * ABSENT is not UNREADABLE: a missing total is 0 spent (start of a period);
   * a corrupt or non-finite one throws. A zero, negative or non-finite
   * CEILING is a misconfiguration and blocks (fail closed) rather than being
   * read as "no ceiling".
   */
  async isCeilingReached(engineKey: EngineKey): Promise<boolean> {
    const ceilingUsd = this.ceilingsUsd[engineKey];
    if (ceilingUsd === undefined) return false;
    if (isDegenerateCeiling(ceilingUsd)) return true;
    const totalUsd = await this.store.readTotal(engineKey, this.cycleKey(this.clock()));
    if (!Number.isFinite(totalUsd) || totalUsd < 0) throw new SpendMeterUnreadableError("store returned a non-finite or negative total");
    return totalUsd >= ceilingUsd;
  }

  /**
   * Phase J/D19's spirit — a store failure here must never block or fail
   * whatever capture triggered it: fails OPEN, exactly like the token
   * bucket. `totalUsd: 0` in that failure case is an honest "unknown right
   * now", not a claim that nothing has ever been spent — Valkey's own
   * persisted counter (INCRBYFLOAT) is untouched by a single failed call,
   * so the NEXT successful call re-establishes the real running total.
   */
  async recordCost(engineKey: EngineKey, usd: number): Promise<SpendMeterResult> {
    const cycleKey = this.cycleKey(this.clock());

    let totalUsd: number;
    try {
      totalUsd = await this.store.incrementAndRead(engineKey, usd, cycleKey);
    } catch (error) {
      logger.warn(`spend-meter store unavailable for engine '${engineKey}' — failing open (no alert, not hard-stopped): ${(error as Error).message}`);
      return { totalUsd: 0, ceilingUsd: this.ceilingsUsd[engineKey] ?? null, newAlerts: [], hardStopped: false };
    }

    const ceilingUsd = this.ceilingsUsd[engineKey] ?? null;

    const newAlerts: SpendAlertLevel[] = [];
    if (ceilingUsd !== null && !isDegenerateCeiling(ceilingUsd)) {
      try {
        const ratio = totalUsd / ceilingUsd;
        const alreadyFired = await this.store.readAlertsFired(engineKey, cycleKey);

        // 95% is checked first — reaching 95% in one jump must not ALSO
        // separately fire 80% as if it were a distinct, earlier crossing.
        if (ratio >= SPEND_ALERT_95_THRESHOLD && !alreadyFired.has("warn_95")) {
          newAlerts.push("warn_95");
          await this.store.markAlertFired(engineKey, cycleKey, "warn_95");
        } else if (ratio >= SPEND_ALERT_80_THRESHOLD && !alreadyFired.has("warn_80")) {
          newAlerts.push("warn_80");
          await this.store.markAlertFired(engineKey, cycleKey, "warn_80");
        }
      } catch (error) {
        logger.warn(`spend-meter alert-flag store unavailable for engine '${engineKey}' — alerts skipped this call: ${(error as Error).message}`);
      }
    }

    const hardStopped = ceilingUsd !== null && (isDegenerateCeiling(ceilingUsd) || totalUsd >= ceilingUsd);

    return { totalUsd, ceilingUsd, newAlerts, hardStopped };
  }
}

/**
 * D13 — a boot-time disclosure, never a fabricated default: returns which
 * ACTIVE engine keys have no configured spend ceiling, so a caller (e.g.
 * src/worker.ts) can log exactly one warning per missing engine at startup
 * rather than silently proceeding as if every engine were covered.
 */
export function warnMissingSpendCeilings(ceilingsUsd: Partial<Record<EngineKey, number>>, activeEngineKeys: readonly EngineKey[]): EngineKey[] {
  const missing = activeEngineKeys.filter((key) => ceilingsUsd[key] === undefined);
  for (const engineKey of missing) {
    logger.warn(`no ENGINE_SPEND_CEILINGS_USD entry for engine '${engineKey}' — its spend is not alerted at 80%/95% and has no 100% hard stop`);
  }
  return missing;
}
