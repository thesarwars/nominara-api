import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

// STORY-114 AC6 / owner decision 107(c): the attribution rollup lag objective is <= 2 hours, measured from the newest ingested
// beacon/citation (the ingest watermark) to its appearance (the commit) in the attribution rollup.

const deferred: Array<() => void> = [];
vi.mock("../../src/tenancy/tenant-context.js", () => ({
  currentTenantStore: () => ({}),
  afterCommit: (task: () => void) => void deferred.push(task),
}));
vi.mock("../../src/lib/attribution/attribution-rollup.js", () => ({
  addDays: (d: string) => d,
  localToday: async () => "2026-11-16",
  projectTimezone: async () => "UTC",
  purgeProjectRollups: async () => 0,
  rollUpWindow: async () => [],
}));
vi.mock("../../src/lib/attribution/substitution-alert.js", () => ({ raiseSubstitutionAlerts: async () => ({ raised: 0 }) }));
vi.mock("../../src/lib/queue/locks.js", () => ({ withProjectQueueLock: async (_tx: unknown, _q: string, _p: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("../../src/lib/telemetry/metrics.js", () => ({ incrementCounter: vi.fn(), observeValue: vi.fn() }));

import { ATTRIBUTION_LAG_OBJECTIVE_SECONDS, attributionLagSeconds } from "../../src/lib/attribution/rollup-lag.js";
import { createAttributionRollupHandler } from "../../src/lib/queue/handlers/attribution-rollup.handler.js";
import { observeValue, incrementCounter } from "../../src/lib/telemetry/metrics.js";

const WS = "11111111-1111-7111-8111-111111111111";
const PROJECT = "0f9e2a7c-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
const job = { data: { payload: { workspaceId: WS, kid: "k", projectId: PROJECT } } } as unknown as Job;

describe("STORY-114-AC6 · the objective and the pure measurement", () => {
  it("STORY-114-AC6 · the objective is 7200 seconds (2 hours)", () => {
    expect(ATTRIBUTION_LAG_OBJECTIVE_SECONDS).toBe(7200);
  });

  it("STORY-114-AC6 · lag is commit time minus the newest ingest, in seconds", () => {
    expect(attributionLagSeconds(1_000_000, 1_000_000 + 90_000)).toEqual({ lagSeconds: 90, withinObjective: true });
  });

  it("STORY-114-AC6 · boundary: exactly 7200 s is within the objective; 7200.001 s is not", () => {
    expect(attributionLagSeconds(0, 7_200_000)?.withinObjective).toBe(true);
    expect(attributionLagSeconds(0, 7_200_001)?.withinObjective).toBe(false);
  });

  it("STORY-114-AC6 · a watermark in the future (clock skew) is a lag of 0, not negative", () => {
    expect(attributionLagSeconds(5_000, 1_000)?.lagSeconds).toBe(0);
  });

  it("STORY-114-AC6 · no ingested data at all means no figure (null), never 0", () => {
    expect(attributionLagSeconds(null, 1_000)).toBeNull();
  });
});

describe("STORY-114-AC6 · the handler emits the lag after commit", () => {
  beforeEach(() => {
    deferred.length = 0;
    vi.mocked(observeValue).mockClear();
    vi.mocked(incrementCounter).mockClear();
  });

  const txWith = (watermark: Date | null): ClientBase =>
    ({ query: vi.fn(async (sql: string) => ({ rows: /ingest watermark/.test(sql) ? [{ watermark }] : [] })) }) as unknown as ClientBase;

  const lagCalls = () => vi.mocked(observeValue).mock.calls.filter(([name]) => name === "nominara_rollup_attribution_lag_seconds");

  it("STORY-114-AC6 · nothing is emitted before the commit, and one observation is emitted after it", async () => {
    const handler = createAttributionRollupHandler({ pool: {} as never, env: {} as never });
    await handler(txWith(new Date(Date.now() - 60_000)), job);
    expect(lagCalls()).toHaveLength(0);
    deferred.forEach((t) => t());
    expect(lagCalls()).toHaveLength(1);
    const [, value] = lagCalls()[0]!;
    expect(value).toBeGreaterThanOrEqual(60);
    expect(value).toBeLessThan(70);
  });

  it("STORY-114-AC6 · a lag above 7200 s is counted as outside the objective", async () => {
    const handler = createAttributionRollupHandler({ pool: {} as never, env: {} as never });
    await handler(txWith(new Date(Date.now() - 7_300_000)), job);
    deferred.forEach((t) => t());
    expect(vi.mocked(incrementCounter)).toHaveBeenCalledWith("nominara_rollup_attribution_lag_observations_total", { within_objective: "false" });
  });

  it("STORY-114-AC6 · no ingested data: no observation at all", async () => {
    const handler = createAttributionRollupHandler({ pool: {} as never, env: {} as never });
    await handler(txWith(null), job);
    deferred.forEach((t) => t());
    expect(lagCalls()).toHaveLength(0);
  });
});
