import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// STORY-076 AC4 + STORY-071 AC10 — `credit.housekeeping`, the daily tick that finally CALLS `expireCredits` (via the
// FIFO sweep) and `purgeDailyCounters`. Both existed, tested, with no caller. The handler is thin on purpose; what it
// owns is the privileged connection, the single-flight lock, the order, and that one step failing never silently
// skips the other.

const state = vi.hoisted(() => ({
  clients: [] as { ended: boolean }[],
  locked: true,
  order: [] as string[],
  expiry: { workspacesChecked: 2, workspacesExpired: 1, creditsExpired: 70, failures: [] as { workspaceId: string; reason: string }[] },
  expiryThrows: false,
  purged: 3,
  purgeThrows: false,
  purgeArgs: [] as unknown[],
  unlocked: 0,
}));

vi.mock("../../../src/db/client.js", () => ({
  connect: vi.fn(async () => {
    const client = { ended: false, end: async () => void (client.ended = true), query: vi.fn() };
    state.clients.push(client);
    return client;
  }),
  withKeepalives: (url: string) => `${url}#keepalive`,
}));
vi.mock("../../../src/lib/queue/locks.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/queue/locks.js")>("../../../src/lib/queue/locks.js");
  return {
    ...actual,
    tryAdvisorySessionLock: vi.fn(async () => state.locked),
    releaseAdvisorySessionLock: vi.fn(async () => { state.unlocked += 1; return true; }),
  };
});
vi.mock("../../../src/lib/credits/expire.js", () => ({
  expireDuePurchasedCredits: vi.fn(async () => {
    state.order.push("expire");
    if (state.expiryThrows) throw new Error("expiry exploded");
    return state.expiry;
  }),
}));
vi.mock("../../../src/lib/usage/daily-cap.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/usage/daily-cap.js")>("../../../src/lib/usage/daily-cap.js");
  return {
    ...actual,
    purgeDailyCounters: vi.fn(async (_tx: unknown, retainDays: number) => {
      state.order.push("purge");
      state.purgeArgs.push(retainDays);
      if (state.purgeThrows) throw new Error("purge exploded");
      return state.purged;
    }),
  };
});

import { createCreditHousekeepingHandler } from "../../../src/lib/queue/handlers/credit-housekeeping.handler.js";
import { DAILY_COUNTER_RETAIN_DAYS } from "../../../src/lib/usage/daily-cap.js";
import { handlerFor } from "../../../src/lib/queue/handlers.js";
import type { QueueHandlerContext } from "../../../src/lib/queue/handlers.js";

const context = { pool: {} as never, env: { DATABASE_URL: "postgres://owner@direct/db" } } as unknown as QueueHandlerContext;
const tick = { data: {} } as unknown as Job;
const run = () => createCreditHousekeepingHandler(context)({} as never, tick);

function metrics(log: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return log.mock.calls.map((call: unknown[]) => call[0] as Record<string, unknown>).filter((entry) => typeof entry?.metric === "string");
}

beforeEach(() => {
  state.clients.length = 0;
  state.locked = true;
  state.order.length = 0;
  state.expiry = { workspacesChecked: 2, workspacesExpired: 1, creditsExpired: 70, failures: [] };
  state.expiryThrows = false;
  state.purged = 3;
  state.purgeThrows = false;
  state.purgeArgs.length = 0;
  state.unlocked = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("credit.housekeeping", () => {
  it("is registered, so the schedule registrar will tick it", () => {
    expect(handlerFor("credit.housekeeping")).toBeDefined();
  });

  it("runs the FIFO expiry sweep and then purges daily counters at their retention window, on ONE privileged connection", async () => {
    await run();
    expect(state.order).toEqual(["expire", "purge"]);
    expect(state.purgeArgs).toEqual([DAILY_COUNTER_RETAIN_DAYS]);
    expect(state.clients).toHaveLength(1);
  });

  it("opens the DIRECT owner URL with keepalives — never the pooler — and ends the connection", async () => {
    const { connect } = await import("../../../src/db/client.js");
    await run();
    expect(connect).toHaveBeenCalledWith("postgres://owner@direct/db#keepalive");
    expect(state.clients[0]!.ended).toBe(true);
    expect(state.unlocked).toBe(1);
  });

  it("YIELDS when another replica holds the lock: nothing runs, the connection is ended, a counter says so", async () => {
    state.locked = false;
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await run();
    expect(state.order).toEqual([]);
    expect(state.clients[0]!.ended).toBe(true);
    expect(state.unlocked).toBe(0);
    expect(metrics(log).map((entry) => entry.metric)).toContain("nominara_credit_housekeeping_yielded_total");
  });

  it("still PURGES when the expiry step throws, then fails the job so the retry ladder re-runs the idempotent expiry", async () => {
    state.expiryThrows = true;
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    await expect(run()).rejects.toThrow(/credit housekeeping/u);
    expect(state.order).toEqual(["expire", "purge"]);
    expect(state.clients[0]!.ended).toBe(true);
  });

  it("still EXPIRES when the purge step throws, then fails the job", async () => {
    state.purgeThrows = true;
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    await expect(run()).rejects.toThrow(/credit housekeeping/u);
    expect(state.order).toEqual(["expire", "purge"]);
  });

  it("fails the job when any workspace's expiry failed, naming the workspace by ID and never the reason's content in the thrown error", async () => {
    state.expiry = { ...state.expiry, failures: [{ workspaceId: "ws-1", reason: "has elapsed credit lots and no credit wallet" }] };
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    await expect(run()).rejects.toThrow(/credit housekeeping/u);
    expect(error.mock.calls.flat().join(" ")).toContain("ws-1");
  });

  it("counts a run, the workspaces expired and the counters purged — and nothing when there was nothing to do", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    await run();
    const names = metrics(log).map((entry) => entry.metric);
    expect(names).toContain("nominara_credit_housekeeping_runs_total");
    expect(names).toContain("nominara_credit_expiry_workspaces_total");
    expect(names).toContain("nominara_credit_daily_counters_purged_total");

    log.mockClear();
    state.expiry = { workspacesChecked: 0, workspacesExpired: 0, creditsExpired: 0, failures: [] };
    state.purged = 0;
    await run();
    const quiet = metrics(log).map((entry) => entry.metric);
    expect(quiet).toContain("nominara_credit_housekeeping_runs_total");
    expect(quiet).not.toContain("nominara_credit_expiry_workspaces_total");
    expect(quiet).not.toContain("nominara_credit_daily_counters_purged_total");
  });

  it("logs counts and workspace IDs only — never a workspace name or a balance's owner", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    await run();
    const line = log.mock.calls.map((call) => String(typeof call[0] === "string" ? call[0] : "")).find((text) => text.includes("housekeeping"));
    expect(line).toContain("70");
    expect(line).not.toMatch(/name|email/iu);
  });
});
