import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// STORY-077 R4 / STORY-013 — `runDailyPurgeCycle` HARD-DELETES: projects 30 days after a soft delete, and workspaces
// whose deletion grace has run out. It had no caller. These pin the part that matters most: scheduled is NOT enabled.
// With `RETENTION_PURGE_ENABLED` unset the handler must not so much as open a connection.

const state = vi.hoisted(() => ({
  clients: [] as { ended: boolean }[],
  locked: true,
  cycleCalls: 0,
  cycleOptions: undefined as { deleteWorkspaceObjects?: (id: string) => Promise<void>; deleteObjectPrefix?: (p: string) => Promise<void>; deleteProjectObjectKeys?: (workspaceId: string, keys: readonly string[]) => Promise<void>; objectKeyEnv?: string } | undefined,
  cycleThrows: false,
  result: { projectsPurged: ["p1", "p2"] as string[], workspacesPurged: [] as string[], skipped: [] as { scope: string; scopeId: string; reason: string }[], held: [] as unknown[], failed: 0 },
  unlocked: 0,
  queueRuns: 0,
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
vi.mock("../../../src/lib/compliance/subject-request.js", () => ({
  executePendingErasures: vi.fn(async () => {
    state.queueRuns += 1;
    return { executed: 0, blocked: 0, stillHeld: 0 };
  }),
}));
vi.mock("../../../src/workers/rollup/retention.js", () => ({
  runDailyPurgeCycle: vi.fn(async (_client: unknown, options?: { deleteWorkspaceObjects?: (id: string) => Promise<void> }) => {
    state.cycleCalls += 1;
    state.cycleOptions = options;
    if (state.cycleThrows) throw new Error("purge exploded");
    return state.result;
  }),
}));

import { createRetentionPurgeHandler } from "../../../src/lib/queue/handlers/retention-purge.handler.js";
import { handlerFor, type QueueHandlerContext } from "../../../src/lib/queue/handlers.js";
import { envSchema } from "../../../src/config/env.schema.js";

const contextWith = (flag: string | undefined) =>
  ({ pool: {} as never, env: { DATABASE_URL: "postgres://owner@direct/db", ...(flag !== undefined ? { RETENTION_PURGE_ENABLED: flag } : {}) } }) as unknown as QueueHandlerContext;
const tick = { data: {} } as unknown as Job;
const run = (flag: string | undefined) => createRetentionPurgeHandler(contextWith(flag))({} as never, tick);
const metricNames = (log: { mock: { calls: unknown[][] } }) =>
  log.mock.calls.map((call: unknown[]) => call[0] as Record<string, unknown>).filter((entry) => typeof entry?.metric === "string");

beforeEach(() => {
  state.clients.length = 0;
  state.locked = true;
  state.cycleCalls = 0;
  state.queueRuns = 0;
  state.cycleOptions = undefined;
  state.cycleThrows = false;
  state.result = { projectsPurged: ["p1", "p2"], workspacesPurged: [], skipped: [], held: [], failed: 0 };
  state.unlocked = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("retention.purge — OFF by default", () => {
  it("is registered, so the schedule exists and the cadence is declared in one place", () => {
    expect(handlerFor("retention.purge")).toBeDefined();
  });

  it.each([undefined, "", "false", "1", "yes", "TRUE", "True"])("does NOT run, and opens NO connection, when RETENTION_PURGE_ENABLED is %j", async (flag) => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await run(flag);
    expect(state.cycleCalls).toBe(0);
    expect(state.clients).toHaveLength(0);
    expect(metricNames(log).some((entry) => entry.metric === "nominara_retention_purge_skipped_total" && entry.reason === "disabled")).toBe(true);
  });

  it("the env schema accepts exactly \"true\" and rejects every other spelling at boot", () => {
    const shape = envSchema.shape.RETENTION_PURGE_ENABLED;
    expect(shape.safeParse("true").success).toBe(true);
    expect(shape.safeParse(undefined).success).toBe(true);
    for (const bad of ["1", "yes", "TRUE", "on", ""]) expect(shape.safeParse(bad).success, bad).toBe(false);
  });
});

describe("retention.purge — enabled", () => {
  it("runs the purge cycle on ONE direct owner connection, single-flight, and ends the connection", async () => {
    const { connect } = await import("../../../src/db/client.js");
    await run("true");
    expect(state.cycleCalls).toBe(1);
    expect(connect).toHaveBeenCalledWith("postgres://owner@direct/db#keepalive");
    expect(state.clients).toHaveLength(1);
    expect(state.clients[0]!.ended).toBe(true);
    expect(state.unlocked).toBe(1);
  });

  it("S23 (decision 68b) runs the queued erasures after the purge cycle on the same connection; a yielding tick runs none", async () => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    await run("true");
    expect(state.queueRuns).toBe(1);
    state.locked = false;
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await run("true");
    expect(state.queueRuns).toBe(1);
  });

  it("YIELDS when another replica holds the lock: nothing is purged", async () => {
    state.locked = false;
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    await run("true");
    expect(state.cycleCalls).toBe(0);
    expect(state.clients[0]!.ended).toBe(true);
    expect(metricNames(log).map((entry) => entry.metric)).toContain("nominara_retention_purge_yielded_total");
  });

  it("counts projects and workspaces purged and what was skipped — IDs never appear in the log line", async () => {
    state.result = { projectsPurged: ["p1", "p2"], workspacesPurged: ["w1"], skipped: [{ scope: "project", scopeId: "p3", reason: "export-lock-held" }], held: [], failed: 0 };
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    await run("true");
    const line = log.mock.calls.map((call) => (typeof call[0] === "string" ? call[0] : "")).find((text) => text.includes("retention purge"));
    expect(line).toContain("2 project(s)");
    expect(line).toContain("1 workspace(s)");
    expect(line).toContain("1 skipped");
    expect(line).not.toMatch(/\bp1\b|\bw1\b|\bp3\b/u);
    expect(metricNames(log).map((entry) => entry.metric)).toContain("nominara_retention_purge_runs_total");
  });

  it("lets a cycle that throws fail the job (the retry ladder) and still ends the connection", async () => {
    state.cycleThrows = true;
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    await expect(run("true")).rejects.toThrow(/purge exploded/u);
    expect(state.clients[0]!.ended).toBe(true);
  });
});

describe("retention.purge - STORY-180 r5: workspace erasure deletes the workspace's report files", () => {
  const storageEnv = { STORAGE_BUCKET_RAW: "raw-b", STORAGE_BUCKET_REPORTS: "reports-b", STORAGE_KEY_ENV: "prod", STORAGE_SSE: "AES256" };
  const withStorage = (extra: Record<string, string>) =>
    ({ pool: {} as never, env: { DATABASE_URL: "postgres://owner@direct/db", RETENTION_PURGE_ENABLED: "true", ...extra } }) as unknown as QueueHandlerContext;

  it("hands the purge cycle a deleteWorkspaceObjects hook when object storage is configured", async () => {
    await createRetentionPurgeHandler(withStorage(storageEnv))({} as never, tick);
    expect(typeof state.cycleOptions?.deleteWorkspaceObjects).toBe("function");
  });

  it("[STORY-182 AC3] leaves deleteObjectPrefix unwired: a project prefix would delete nothing (raw keys carry no project); project raw objects go by key instead", async () => {
    await createRetentionPurgeHandler(withStorage(storageEnv))({} as never, tick);
    expect(state.cycleOptions?.deleteObjectPrefix).toBeUndefined();
  });

  it("[STORY-182 decision 69(b)] hands the purge cycle a deleteProjectObjectKeys hook when object storage is configured", async () => {
    await createRetentionPurgeHandler(withStorage(storageEnv))({} as never, tick);
    expect(typeof state.cycleOptions?.deleteProjectObjectKeys).toBe("function");
  });

  it("with object storage NOT configured the cycle runs without the hook, and says so", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await createRetentionPurgeHandler(withStorage({}))({} as never, tick);
    expect(state.cycleOptions?.deleteWorkspaceObjects).toBeUndefined();
    expect(state.cycleOptions?.deleteObjectPrefix).toBeUndefined();
    expect(state.cycleOptions?.deleteProjectObjectKeys).toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).toContain("report_objects_not_deleted");
  });
});

describe("retention.purge - STORY-111: the journal and the compliance exports", () => {
  const storageEnv = { STORAGE_BUCKET_RAW: "raw-b", STORAGE_BUCKET_REPORTS: "reports-b", STORAGE_KEY_ENV: "prod", STORAGE_SSE: "AES256" };
  const withStorage = (extra: Record<string, string>) =>
    ({ pool: {} as never, env: { DATABASE_URL: "postgres://owner@direct/db", RETENTION_PURGE_ENABLED: "true", ...extra } }) as unknown as QueueHandlerContext;

  it("hands the cycle a purge journal and a compliance exporter when object storage is configured", async () => {
    await createRetentionPurgeHandler(withStorage(storageEnv))({} as never, tick);
    const options = state.cycleOptions as { journal?: unknown; exporterFor?: unknown } | undefined;
    expect(options?.journal).toBeDefined();
    expect(typeof options?.exporterFor).toBe("function");
  });

  it("with object storage NOT configured there is no journal, and the handler says so every run", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await createRetentionPurgeHandler(withStorage({}))({} as never, tick);
    expect((state.cycleOptions as { journal?: unknown } | undefined)?.journal).toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).toContain("purge_journal_unavailable");
  });

  it("reports held subjects and failures in counts only, and logs an error when a cycle recorded a failure", async () => {
    state.result = { projectsPurged: [], workspacesPurged: [], skipped: [], held: [{ scope: "project", scopeId: "p9", reason: "legal-hold" }], failed: 2 } as never;
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    await run("true");
    const line = log.mock.calls.map((c) => (typeof c[0] === "string" ? c[0] : "")).find((t) => t.includes("retention purge"));
    expect(line).toContain("1 held");
    expect(line).toContain("2 failed");
    expect(line).not.toMatch(/\bp9\b/u);
    expect(JSON.stringify(error.mock.calls)).toContain("retention_purge_failures");
  });
});
