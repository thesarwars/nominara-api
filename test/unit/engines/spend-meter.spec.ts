import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SpendMeter, warnMissingSpendCeilings, type SpendAlertLevel, type SpendMeterStore } from "../../../src/lib/engines/spend-meter.js";

// STORY-031 Phase H / D12 — THE security-relevant decision in this story:
// per-engine spend is metered via Valkey counters fed by a `recordCost`
// seam, NEVER by a cross-tenant SQL sum over `usage_ledger` (workspace-
// scoped, RLS-forced). This rejection must be explicit and testable, not
// merely "absent from what we wrote" — the structural test below fails
// loudly the day anyone tries to add such a query back in.

const SPEND_METER_SOURCE_PATH = fileURLToPath(new URL("../../../src/lib/engines/spend-meter.ts", import.meta.url));

describe("STORY-031 D12 · spend-meter.ts structurally never touches Postgres or usage_ledger", () => {
  const source = readFileSync(SPEND_METER_SOURCE_PATH, "utf8");

  it("never imports from 'pg', the db module, or PG_POOL", () => {
    expect(source).not.toMatch(/from ["']pg["']/);
    expect(source).not.toMatch(/db\/pg-pool/);
    expect(source).not.toMatch(/PG_POOL/);
  });

  it("never references usage_ledger — the workspace-scoped, RLS-forced table this story refuses to cross-tenant-sum", () => {
    expect(source).not.toMatch(/usage_ledger/);
  });
});

class InMemorySpendMeterStore implements SpendMeterStore {
  private totals = new Map<string, number>();
  private alertsFired = new Map<string, Set<SpendAlertLevel>>();

  async incrementAndRead(engineKey: string, usd: number, cycleKey: string): Promise<number> {
    const key = `${engineKey}:${cycleKey}`;
    const next = (this.totals.get(key) ?? 0) + usd;
    this.totals.set(key, next);
    return next;
  }

  async readTotal(engineKey: string, cycleKey: string): Promise<number> {
    return this.totals.get(`${engineKey}:${cycleKey}`) ?? 0;
  }

  async readAlertsFired(engineKey: string, cycleKey: string): Promise<Set<SpendAlertLevel>> {
    return this.alertsFired.get(`${engineKey}:${cycleKey}`) ?? new Set();
  }

  async markAlertFired(engineKey: string, cycleKey: string, level: SpendAlertLevel): Promise<void> {
    const key = `${engineKey}:${cycleKey}`;
    const set = this.alertsFired.get(key) ?? new Set();
    set.add(level);
    this.alertsFired.set(key, set);
  }
}

describe("STORY-031 · SpendMeter — 80%/95% alerts once per cycle, 100% hard stop, D13 ceiling-absent posture", () => {
  it("with NO ceiling configured (D13): metering still runs, alerts never fire, hard stop is always disabled", async () => {
    const meter = new SpendMeter(new InMemorySpendMeterStore(), {}, () => Date.UTC(2026, 0, 15));
    const result = await meter.recordCost("chatgpt", 1_000_000);
    expect(result.totalUsd).toBe(1_000_000);
    expect(result.ceilingUsd).toBeNull();
    expect(result.newAlerts).toEqual([]);
    expect(result.hardStopped).toBe(false);
  });

  it("below 80% of the ceiling → no alerts, not hard-stopped", async () => {
    const meter = new SpendMeter(new InMemorySpendMeterStore(), { chatgpt: 100 }, () => Date.UTC(2026, 0, 15));
    const result = await meter.recordCost("chatgpt", 79.99);
    expect(result.newAlerts).toEqual([]);
    expect(result.hardStopped).toBe(false);
  });

  it("crossing exactly 80% fires warn_80 exactly once, even across many further calls in the same cycle", async () => {
    const meter = new SpendMeter(new InMemorySpendMeterStore(), { chatgpt: 100 }, () => Date.UTC(2026, 0, 15));
    const first = await meter.recordCost("chatgpt", 80);
    expect(first.newAlerts).toEqual(["warn_80"]);

    const second = await meter.recordCost("chatgpt", 1);
    expect(second.newAlerts).toEqual([]); // already fired this cycle
  });

  it("crossing exactly 95% fires warn_95 exactly once, distinct from warn_80", async () => {
    const meter = new SpendMeter(new InMemorySpendMeterStore(), { chatgpt: 100 }, () => Date.UTC(2026, 0, 15));
    await meter.recordCost("chatgpt", 80); // warn_80
    const result = await meter.recordCost("chatgpt", 15); // total 95 → warn_95
    expect(result.newAlerts).toEqual(["warn_95"]);

    const again = await meter.recordCost("chatgpt", 1);
    expect(again.newAlerts).toEqual([]);
  });

  it("reaching 100% of the ceiling hard-stops", async () => {
    const meter = new SpendMeter(new InMemorySpendMeterStore(), { chatgpt: 100 }, () => Date.UTC(2026, 0, 15));
    const result = await meter.recordCost("chatgpt", 100);
    expect(result.hardStopped).toBe(true);
  });

  it("just under 100% never hard-stops", async () => {
    const meter = new SpendMeter(new InMemorySpendMeterStore(), { chatgpt: 100 }, () => Date.UTC(2026, 0, 15));
    const result = await meter.recordCost("chatgpt", 99.99);
    expect(result.hardStopped).toBe(false);
  });

  it("each engine's spend and alert state is tracked independently", async () => {
    const meter = new SpendMeter(new InMemorySpendMeterStore(), { chatgpt: 100, claude: 100 }, () => Date.UTC(2026, 0, 15));
    await meter.recordCost("chatgpt", 90);
    const claudeResult = await meter.recordCost("claude", 10);
    expect(claudeResult.newAlerts).toEqual([]);
    expect(claudeResult.totalUsd).toBe(10);
  });

  it("a new billing cycle (a different calendar month) resets both spend and alert state", async () => {
    const nowRef = { now: Date.UTC(2026, 0, 31) };
    const meter = new SpendMeter(new InMemorySpendMeterStore(), { chatgpt: 100 }, () => nowRef.now);
    await meter.recordCost("chatgpt", 95); // fires warn_80 and warn_95 in January

    nowRef.now = Date.UTC(2026, 1, 1); // February
    const result = await meter.recordCost("chatgpt", 10);
    expect(result.totalUsd).toBe(10); // NOT 105 — a fresh cycle
    expect(result.newAlerts).toEqual([]); // below 80% of a fresh cycle
  });
});

describe("STORY-031 Phase J · SpendMeter — D19's spirit extended: a store failure never blocks a capture", () => {
  class FailingStore implements SpendMeterStore {
    async incrementAndRead(): Promise<number> {
      throw new Error("cache instance unreachable");
    }
    async readTotal(): Promise<number> {
      throw new Error("cache instance unreachable");
    }
    async readAlertsFired(): Promise<Set<SpendAlertLevel>> {
      throw new Error("cache instance unreachable");
    }
    async markAlertFired(): Promise<void> {
      throw new Error("cache instance unreachable");
    }
  }

  it("recordCost never throws when the store is entirely unreachable — fails open (no alert, not hard-stopped)", async () => {
    const meter = new SpendMeter(new FailingStore(), { chatgpt: 100 }, () => Date.UTC(2026, 0, 15));
    const result = await meter.recordCost("chatgpt", 50);
    expect(result.newAlerts).toEqual([]);
    expect(result.hardStopped).toBe(false);
  });
});

describe("STORY-031 D13 · warnMissingSpendCeilings — boot-time disclosure, never a fabricated default", () => {
  it("returns the active engine keys that have no configured ceiling", () => {
    const missing = warnMissingSpendCeilings({ chatgpt: 100 }, ["chatgpt", "claude", "gemini"]);
    expect(missing.sort()).toEqual(["claude", "gemini"]);
  });

  it("returns an empty array when every active engine has a ceiling configured", () => {
    expect(warnMissingSpendCeilings({ chatgpt: 100, claude: 50 }, ["chatgpt", "claude"])).toEqual([]);
  });
});

describe("E2E-B6e · SpendMeter.isCeilingReached — the pre-call gate", () => {
  const clock = () => Date.UTC(2026, 0, 15);
  it("is false below the ceiling, true at it (>=) and above it", async () => {
    const store = new InMemorySpendMeterStore();
    const meter = new SpendMeter(store, { gemini: 10 }, clock);
    expect(await meter.isCeilingReached("gemini")).toBe(false);
    await meter.recordCost("gemini", 9.99);
    expect(await meter.isCeilingReached("gemini")).toBe(false);
    await meter.recordCost("gemini", 0.01);
    expect(await meter.isCeilingReached("gemini")).toBe(true);
  });

  it("is always false for an engine with no ceiling (D13), however much it has spent", async () => {
    const meter = new SpendMeter(new InMemorySpendMeterStore(), {}, clock);
    await meter.recordCost("chatgpt", 1_000_000);
    expect(await meter.isCeilingReached("chatgpt")).toBe(false);
  });

  it("fails CLOSED when the store cannot be read and the engine has a ceiling; open when it has none", async () => {
    const broken = new InMemorySpendMeterStore();
    broken.readTotal = async () => { throw new Error("down"); };
    await expect(new SpendMeter(broken, { gemini: 10 }, clock).isCeilingReached("gemini")).rejects.toThrow();
    expect(await new SpendMeter(broken, {}, clock).isCeilingReached("gemini")).toBe(false);
  });
});
