import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SchedulerSweepRuntime,
  nextSweepAfter,
  runSchedulerSweep,
  sweepIdempotencyKey,
} from "../../src/lib/capture/scheduler-sweep.js";
import { downgradeNoticeJobKey } from "../../src/lib/billing/downgrade-notice-outbox.js";
import { downgradeNoticeRelayJobKey } from "../../src/lib/billing/downgrade-notice-relay.js";

// NEW-A-13 — the sweep's clock and its dedup identity, with no database.

describe("NEW-A-13 · the sweep fires hourly at :05 UTC", () => {
  it("NEW-A-13 AC4 · nextSweepAfter returns the next :05 UTC strictly after now", () => {
    const at = (iso: string) => nextSweepAfter(new Date(iso)).toISOString();
    expect(at("2026-10-08T10:00:00.000Z")).toBe("2026-10-08T10:05:00.000Z");
    expect(at("2026-10-08T10:04:59.999Z")).toBe("2026-10-08T10:05:00.000Z");
    // Exactly on the boundary the NEXT one is returned, never now: a tick that
    // fires and re-arms on :05:00.000 must not re-arm for the same instant.
    expect(at("2026-10-08T10:05:00.000Z")).toBe("2026-10-08T11:05:00.000Z");
    expect(at("2026-10-08T10:05:00.001Z")).toBe("2026-10-08T11:05:00.000Z");
    expect(at("2026-10-08T23:59:59.000Z")).toBe("2026-10-09T00:05:00.000Z");
    expect(at("2026-12-31T23:30:00.000Z")).toBe("2027-01-01T00:05:00.000Z");
  });

  it("NEW-A-13 AC4 · the schedule is UTC whatever the process time zone", () => {
    const original = process.env.TZ;
    process.env.TZ = "Asia/Kolkata"; // +05:30: a local-time implementation would answer :05 local = :35 UTC
    try {
      expect(nextSweepAfter(new Date("2026-10-08T10:00:00.000Z")).toISOString()).toBe("2026-10-08T10:05:00.000Z");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("NEW-A-13 · dedup key", () => {
  it("NEW-A-13 AC2 · the key is run:{project}:{next_run_at} and changes when next_run_at does", () => {
    const at = new Date("2026-10-08T10:00:00.000Z");
    expect(sweepIdempotencyKey("p1", at)).toBe("run:p1:2026-10-08T10:00:00.000Z");
    expect(sweepIdempotencyKey("p1", at)).toBe(sweepIdempotencyKey("p1", new Date(at)));
    expect(sweepIdempotencyKey("p1", at)).not.toBe(sweepIdempotencyKey("p1", new Date(at.getTime() + 1)));
    expect(sweepIdempotencyKey("p1", at)).not.toBe(sweepIdempotencyKey("p2", at));
  });
});

describe("NEW-A-13 · the in-process runtime", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function runtimeAt(iso: string) {
    vi.setSystemTime(new Date(iso));
    const connects: string[] = [];
    const runtime = new SchedulerSweepRuntime({
      connect: async () => {
        connects.push(new Date().toISOString());
        throw new Error("no database in a unit test");
      },
      enqueue: async () => undefined,
    });
    return { runtime, connects };
  }

  it("NEW-A-13 AC1 · start() arms the next :05 UTC, ticks there, and re-arms for the following hour", async () => {
    const { runtime, connects } = runtimeAt("2026-10-08T10:00:00.000Z");
    runtime.start();
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 59_000);
    expect(connects).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connects).toEqual(["2026-10-08T10:05:00.000Z"]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(connects).toEqual(["2026-10-08T10:05:00.000Z", "2026-10-08T11:05:00.000Z"]);
    runtime.stop();
  });

  it("NEW-A-13 AC1 · stop() cancels the pending tick and start() twice arms only one", async () => {
    const { runtime, connects } = runtimeAt("2026-10-08T10:00:00.000Z");
    runtime.start();
    runtime.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(connects).toHaveLength(1);
    runtime.stop();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(connects).toHaveLength(1);
  });

  it("NEW-A-13 AC1 · a tick that cannot reach the database is best-effort: it does not throw and the next hour still fires", async () => {
    const { runtime, connects } = runtimeAt("2026-10-08T10:00:00.000Z");
    await expect(runtime.tick()).resolves.toBeNull();
    runtime.start();
    await vi.advanceTimersByTimeAsync(65 * 60_000);
    expect(connects.length).toBeGreaterThanOrEqual(2); // the direct tick, then the :05 one
    runtime.stop();
  });
});

// CHECKPOINT-3 blocker — the sweep held up to 500 project row locks across a
// Valkey call with no time limit; a stalled Valkey stopped scheduling for good.
// Every wait the sweep makes is now bounded, and the tick as a whole is bounded
// so arm() always runs again.
describe("NEW-A-13 checkpoint-3 · every wait the sweep makes is bounded", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const NEXT_RUN = new Date("2026-10-08T09:00:00.000Z");

  /** A client that answers the sweep's statements and records them; `hang` makes the named statement never answer. */
  function fakeClient(options: { rows?: number; hang?: "claim" | "any" } = {}) {
    const statements: Array<{ sql: string; params: unknown[] | undefined }> = [];
    let ended = 0;
    const rows = Array.from({ length: options.rows ?? 1 }, (_, i) => ({
      id: `project-${i}`,
      workspace_id: `workspace-${i}`,
      cadence: "daily",
      next_run_at: NEXT_RUN,
    }));
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        statements.push({ sql, params });
        if (options.hang === "any") return new Promise(() => undefined);
        if (sql.includes("pg_roles")) return { rows: [{ can_see: true, who: "owner" }] };
        if (sql.includes("FOR UPDATE OF p")) {
          if (options.hang === "claim") return new Promise(() => undefined);
          return { rows };
        }
        return { rows: [] };
      },
      end: async () => {
        ended += 1;
      },
    };
    return { client, statements, ended: () => ended };
  }

  const never = () => new Promise<void>(() => undefined);

  it("NEW-A-13 CP3-1a · an enqueue that never resolves is abandoned after enqueueTimeoutMs and counted as a failed enqueue (partial)", async () => {
    const { client } = fakeClient();
    const promise = runSchedulerSweep(client as never, never, new Date("2026-10-08T10:00:00.000Z"), {
      enqueueTimeoutMs: 500,
      transactionBudgetMs: 10_000,
      lockTimeoutMs: 1_000,
      idleInTransactionTimeoutMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toEqual({ status: "partial", claimed: 1, enqueued: 0, failed: 1 });
  });

  it("NEW-A-13 CP3-1b · the transaction sets lock_timeout and idle_in_transaction_session_timeout transaction-locally, after BEGIN and before the claim", async () => {
    const { client, statements } = fakeClient();
    await runSchedulerSweep(client as never, async () => undefined, new Date("2026-10-08T10:00:00.000Z"), {
      enqueueTimeoutMs: 500,
      transactionBudgetMs: 10_000,
      lockTimeoutMs: 1_234,
      idleInTransactionTimeoutMs: 5_678,
    });
    const sqls = statements.map((s) => s.sql);
    const begin = sqls.findIndex((sql) => sql.trim() === "BEGIN");
    const claim = sqls.findIndex((sql) => sql.includes("FOR UPDATE OF p"));
    const setConfigs = statements
      .map((s, index) => ({ ...s, index }))
      .filter((s) => /set_config/i.test(s.sql));
    expect(setConfigs).toHaveLength(2);
    for (const call of setConfigs) {
      expect(call.index).toBeGreaterThan(begin);
      expect(call.index).toBeLessThan(claim);
      expect(call.sql, "is_local => true: a session-level setting would leak (KAD-03)").toMatch(/set_config\(\$1,\s*\$2,\s*true\)/i);
    }
    expect(setConfigs.map((c) => c.params)).toEqual([
      ["lock_timeout", "1234ms"],
      ["idle_in_transaction_session_timeout", "5678ms"],
    ]);
    expect(sqls.some((sql) => /^\s*SET\s/i.test(sql))).toBe(false);
  });

  it("NEW-A-13 CP3-1c · the transaction as a whole is budgeted: once transactionBudgetMs is spent no further row is attempted, and every unsent row is counted failed", async () => {
    const { client } = fakeClient({ rows: 5 });
    const attempts: string[] = [];
    const promise = runSchedulerSweep(
      client as never,
      (job) => {
        attempts.push(job.projectId);
        return never();
      },
      new Date("2026-10-08T10:00:00.000Z"),
      { enqueueTimeoutMs: 50, transactionBudgetMs: 80, lockTimeoutMs: 1_000, idleInTransactionTimeoutMs: 2_000 },
    );
    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toEqual({ status: "partial", claimed: 5, enqueued: 0, failed: 5 });
    expect(attempts, "t=0 and t=50 are inside the 80 ms budget; t=100 is not").toEqual(["project-0", "project-1"]);
  });

  function runtimeWith(connect: () => Promise<never>, extra: Record<string, number> = {}) {
    vi.setSystemTime(new Date("2026-10-08T10:00:00.000Z"));
    return new SchedulerSweepRuntime({
      connect,
      enqueue: never,
      limits: {
        enqueueTimeoutMs: 60_000,
        transactionBudgetMs: 60_000,
        lockTimeoutMs: 5_000,
        idleInTransactionTimeoutMs: 15_000,
        tickTimeoutMs: 1_000,
        connectTimeoutMs: 500,
        ...extra,
      },
    } as never);
  }

  it("NEW-A-13 CP3-3a · a connect that never answers (blackholed Postgres) is abandoned, and the next :05 tick still fires", async () => {
    const connects: string[] = [];
    const runtime = runtimeWith(() => {
      connects.push(new Date().toISOString());
      return new Promise<never>(() => undefined);
    }, { tickTimeoutMs: 90 * 60_000 }); // the tick bound is out of play: connectTimeoutMs alone must free it
    runtime.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 2_000);
    expect(connects).toEqual(["2026-10-08T10:05:00.000Z"]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(connects).toEqual(["2026-10-08T10:05:00.000Z", "2026-10-08T11:05:00.000Z"]);
    runtime.stop();
  });

  it("NEW-A-13 CP3-3b · a tick that stalls on Postgres is abandoned at tickTimeoutMs, its connection is ended (releasing the row locks), and the next :05 tick still fires", async () => {
    const clients: Array<ReturnType<typeof fakeClient>> = [];
    const runtime = runtimeWith(async () => {
      const made = fakeClient({ hang: "claim" });
      clients.push(made);
      return made.client as never;
    });
    runtime.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 2_000);
    expect(clients).toHaveLength(1);
    expect(clients[0]!.ended(), "the stalled tick's connection is ended so Postgres drops its locks").toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(clients).toHaveLength(2);
    runtime.stop();
  });

  it("NEW-A-13 CP3-3c · tick() resolves null (never pends forever) when the sweep stalls, and ends its connection", async () => {
    const made = fakeClient({ hang: "any" });
    const runtime = runtimeWith(async () => made.client as never);
    const promise = runtime.tick();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBeNull();
    expect(made.ended()).toBeGreaterThanOrEqual(1);
  });

  it("NEW-A-13 CP3-obs · a timed-out tick and a timed-out enqueue are counted and logged with ids only", async () => {
    const lines: unknown[] = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => void lines.push(message));
    }
    const made = fakeClient({ hang: "any" });
    const runtime = runtimeWith(async () => made.client as never);
    const promise = runtime.tick();
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;
    expect(lines.find((l) => (l as { metric?: string }).metric === "nominara_capture_scheduler_sweeps_total")).toMatchObject({
      status: "timed_out",
    });
    expect(lines.find((l) => (l as { event?: string }).event === "capture.scheduler.tick_timed_out")).toBeDefined();

    lines.length = 0;
    const other = fakeClient();
    const swept = runSchedulerSweep(other.client as never, never, new Date("2026-10-08T10:00:00.000Z"), {
      enqueueTimeoutMs: 100,
      transactionBudgetMs: 10_000,
      lockTimeoutMs: 1_000,
      idleInTransactionTimeoutMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(100);
    await swept;
    expect(lines.find((l) => (l as { metric?: string }).metric === "nominara_capture_scheduler_enqueue_failures_total")).toBeDefined();
    expect(lines.find((l) => (l as { event?: string }).event === "capture.scheduler.enqueue_failed")).toMatchObject({
      workspace_id: "workspace-0",
      project_id: "project-0",
      error: "EnqueueTimeoutError",
    });
  });
});

// STORY-077 review round 2 (major) — the downgrade-notice RELAY rides this hourly tick (the owner connection it already
// opens sees across tenants). It runs AFTER the claim transaction, best-effort: a relay failure never fails the sweep.
describe("STORY-077 · the hourly tick relays unsent downgrade notices", () => {
  afterEach(() => vi.restoreAllMocks());

  function relayClient(options: { failRelay?: boolean } = {}) {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("pg_roles")) return { rows: [{ can_see: true, who: "owner" }] };
        if (sql.includes("FROM downgrade_notices") && sql.includes("sent_at IS NULL") && /^\s*SELECT\s+id/i.test(sql)) {
          if (options.failRelay === true) throw new Error("relay read failed");
          return { rows: [{ id: "55555555-5555-7555-8555-555555555555", workspace_id: "11111111-1111-7111-8111-111111111111", request_id: "evt_1", kind: "paused" }] };
        }
        return { rows: [], rowCount: 0 };
      },
      end: async () => undefined,
    };
    return { client, statements };
  }

  it("with a notice enqueuer, one tick re-enqueues each unsent notice on billing.downgrade_notice under an hour-suffixed key", async () => {
    const { client } = relayClient();
    const calls: unknown[][] = [];
    const runtime = new SchedulerSweepRuntime({
      connect: async () => client as never,
      enqueue: async () => undefined,
      enqueueDowngradeNotice: async (...args) => void calls.push(args),
      clock: () => new Date("2026-10-23T10:05:00.000Z"),
    });
    await runtime.tick();
    expect(calls).toHaveLength(1);
    const [queue, workspaceId, payload, options] = calls[0] as [string, string, unknown, { idempotencyKey: string }];
    expect([queue, workspaceId, payload]).toEqual(["billing.downgrade_notice", "11111111-1111-7111-8111-111111111111", { noticeId: "55555555-5555-7555-8555-555555555555" }]);
    expect(options.idempotencyKey).toMatch(/^dgnotice:11111111-1111-7111-8111-111111111111:[0-9a-f]+:paused$/);
    expect(options.idempotencyKey).not.toBe(downgradeNoticeJobKey("11111111-1111-7111-8111-111111111111", "evt_1", "paused"));
  });

  it("a relay failure is logged and never fails the sweep", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { client } = relayClient({ failRelay: true });
    const runtime = new SchedulerSweepRuntime({
      connect: async () => client as never,
      enqueue: async () => undefined,
      enqueueDowngradeNotice: async () => undefined,
      clock: () => new Date("2026-10-23T10:05:00.000Z"),
    });
    await expect(runtime.tick()).resolves.toMatchObject({ status: "complete" });
  });

  it("the relay key is stable within an hour and new each hour", () => {
    const at = (iso: string) => downgradeNoticeRelayJobKey("11111111-1111-7111-8111-111111111111", "evt_1", "paused", new Date(iso));
    expect(at("2026-10-23T10:05:00.000Z")).toBe(at("2026-10-23T10:59:59.000Z"));
    expect(at("2026-10-23T10:05:00.000Z")).not.toBe(at("2026-10-23T11:05:00.000Z"));
  });
});
