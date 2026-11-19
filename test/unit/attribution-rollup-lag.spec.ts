import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

// STORY-114 AC6 / owner decision 107(c): the attribution rollup lag objective is <= 2 hours, measured from the newest ingested
// beacon/citation to its appearance (the commit) in the attribution rollup. At the START of each run the lag is now minus the OLDEST
// ingest time among rows not yet included in a committed rollup of the project (the per-project marker projects.attribution_rolled_up_at):
// a quiet site with nothing pending is no figure and no breach, and a stalled rollup shows in the "seconds since last committed rollup" gauge.

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

  it("STORY-114-AC6 · lag is run time minus the oldest pending ingest, in seconds", () => {
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

describe("STORY-114-AC6 · the handler measures the oldest pending row at the start of the run", () => {
  beforeEach(() => {
    deferred.length = 0;
    vi.mocked(observeValue).mockClear();
    vi.mocked(incrementCounter).mockClear();
  });

  const txWith = (pending: { oldest: Date | null; lastCommit: Date | null }): ClientBase =>
    ({
      query: vi.fn(async (sql: string) => ({
        rows: /oldest pending ingest/.test(sql) ? [{ oldest_pending: pending.oldest, last_committed: pending.lastCommit }] : [],
      })),
    }) as unknown as ClientBase;

  const lagCalls = () => vi.mocked(observeValue).mock.calls.filter(([name]) => name === "nominara_rollup_attribution_lag_seconds");
  const sinceCalls = () => vi.mocked(observeValue).mock.calls.filter(([name]) => name === "nominara_rollup_attribution_since_last_commit_seconds");
  const run = async (tx: ClientBase) => {
    await createAttributionRollupHandler({ pool: {} as never, env: {} as never })(tx, job);
    deferred.forEach((t) => t());
  };

  it("STORY-114-AC6 · nothing is emitted before the commit, and one lag observation is emitted after it", async () => {
    await createAttributionRollupHandler({ pool: {} as never, env: {} as never })(txWith({ oldest: new Date(Date.now() - 60_000), lastCommit: new Date() }), job);
    expect(lagCalls()).toHaveLength(0);
    deferred.forEach((t) => t());
    expect(lagCalls()).toHaveLength(1);
    const value = lagCalls()[0]![1];
    expect(value).toBeGreaterThanOrEqual(60);
    expect(value).toBeLessThan(70);
  });

  it("STORY-114-AC6 · pending rows older than 7200 s are a breach", async () => {
    await run(txWith({ oldest: new Date(Date.now() - 7_300_000), lastCommit: new Date(Date.now() - 7_300_000) }));
    expect(vi.mocked(incrementCounter)).toHaveBeenCalledWith("nominara_rollup_attribution_lag_observations_total", { within_objective: "false" });
  });

  it("STORY-114-AC6 · a quiet site (old data, nothing pending) is no observation and not a breach", async () => {
    await run(txWith({ oldest: null, lastCommit: new Date(Date.now() - 3 * 86_400_000) }));
    expect(lagCalls()).toHaveLength(0);
    expect(vi.mocked(incrementCounter)).not.toHaveBeenCalledWith("nominara_rollup_attribution_lag_observations_total", expect.anything());
  });

  it("STORY-114-AC6 · nothing ingested and nothing committed: no lag observation", async () => {
    await run(txWith({ oldest: null, lastCommit: null }));
    expect(lagCalls()).toHaveLength(0);
    expect(sinceCalls()).toHaveLength(0);
  });

  it("STORY-114-AC6 · the seconds since the last committed rollup are emitted, so a stall is visible even with nothing pending", async () => {
    await run(txWith({ oldest: null, lastCommit: new Date(Date.now() - 3_600_000) }));
    expect(sinceCalls()).toHaveLength(1);
    expect(sinceCalls()[0]![1]).toBeGreaterThanOrEqual(3600);
  });

  it("STORY-114-AC6 · the lag is read before the windows are computed, and the marker is advanced in the same transaction", async () => {
    const order: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string) => {
        if (/oldest pending ingest/.test(sql)) order.push("measure");
        if (/SET attribution_rolled_up_at/.test(sql)) order.push("marker");
        return { rows: [] };
      }),
    } as unknown as ClientBase;
    await createAttributionRollupHandler({ pool: {} as never, env: {} as never })(tx, job);
    expect(order).toEqual(["measure", "marker"]);
  });
});
