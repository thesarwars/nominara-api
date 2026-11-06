import { Logger } from "@nestjs/common";
import { UnrecoverableError, type Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletMismatch } from "../../../src/lib/credits/replay.js";

// STORY-073 AC4 / scenario 6 - `credit.verify`, the nightly tick for NFR-CRD-03 ("a nightly job asserts equality and pages on
// mismatch"). `verifyAllWallets` existed, tested, and ran only as `pnpm credits:verify`. What this file pins is everything that
// makes it a JOB: that it is registered, opens the owner connection, single-flights, pages OUTSIDE the lock, emits a metric and an
// error log (the hook while there is no pager - decision 45), and FAILS UNRECOVERABLY on a mismatch so the dead-letter queue has
// exactly one entry for it.

const MISMATCH: WalletMismatch = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  seq: "7",
  reason: "included balance diverges from the replayed ledger",
  wallet: { included: 90, purchased: 0, reserved: 0 },
  replayed: { included: 100, purchased: 0, reserved: 0 },
  counter: null,
};

const state = vi.hoisted(() => ({
  clients: [] as { ended: boolean }[],
  locked: true,
  unlocked: 0,
  result: { checked: 3, mismatch: null as unknown },
  throws: null as Error | null,
  lockHeldWhenPaged: [] as boolean[],
  pages: [] as unknown[],
  heldNow: false,
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
    tryAdvisorySessionLock: vi.fn(async () => {
      state.heldNow = state.locked;
      return state.locked;
    }),
    releaseAdvisorySessionLock: vi.fn(async () => {
      state.unlocked += 1;
      state.heldNow = false;
      return true;
    }),
  };
});
vi.mock("../../../src/workers/rollup/credit-verify.js", () => ({
  verifyAllWallets: vi.fn(async (_client: unknown, notifier: { page(m: unknown): Promise<void> }) => {
    if (state.throws !== null) throw state.throws;
    if (state.result.mismatch !== null) await notifier.page(state.result.mismatch);
    return state.result;
  }),
}));
vi.mock("../../../src/modules/credits/adapters/logging-wallet-paging-notifier.js", () => ({
  LoggingWalletPagingNotifier: class {
    async page(mismatch: unknown): Promise<void> {
      state.lockHeldWhenPaged.push(state.heldNow);
      state.pages.push(mismatch);
    }
  },
}));
vi.mock("../../../src/lib/alerts/alerts.js", () => ({ drainAlertEmails: vi.fn(async () => undefined) }));

import { createCreditVerifyHandler } from "../../../src/lib/queue/handlers/credit-verify.handler.js";
import { handlerFor } from "../../../src/lib/queue/handlers.js";
import type { QueueHandlerContext } from "../../../src/lib/queue/handlers.js";

const context = { pool: {} as never, env: { DATABASE_URL: "postgres://owner@direct/db" } } as unknown as QueueHandlerContext;
const tick = { data: {} } as unknown as Job;
const run = () => createCreditVerifyHandler(context)({} as never, tick);

function metrics(log: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return log.mock.calls.map((call: unknown[]) => call[0] as Record<string, unknown>).filter((entry) => typeof entry?.metric === "string");
}

beforeEach(() => {
  state.clients.length = 0;
  state.locked = true;
  state.unlocked = 0;
  state.result = { checked: 3, mismatch: null };
  state.throws = null;
  state.lockHeldWhenPaged.length = 0;
  state.pages.length = 0;
  state.heldNow = false;
});
afterEach(() => vi.restoreAllMocks());

describe("STORY-073 AC4 · credit.verify", () => {
  it("is registered, so the schedule registrar will tick it", () => {
    expect(handlerFor("credit.verify")).toBeDefined();
  });

  it("opens the DIRECT owner URL with keepalives - never the pooler - and ends the connection and releases the lock", async () => {
    const { connect } = await import("../../../src/db/client.js");
    await run();
    expect(connect).toHaveBeenCalledWith("postgres://owner@direct/db#keepalive");
    expect(state.clients).toHaveLength(1);
    expect(state.clients[0]!.ended).toBe(true);
    expect(state.unlocked).toBe(1);
  });

  it("resolves quietly on a clean estate, pages no one, and counts the run", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    await expect(run()).resolves.toBeUndefined();
    expect(state.pages).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
    expect(metrics(log).map((m) => m.metric)).toContain("nominara_credit_wallet_verify_runs_total");
    expect(metrics(log).map((m) => m.metric)).not.toContain("nominara_credit_wallet_mismatch_total");
  });

  it("YIELDS when another replica holds the lock: nothing is verified, the connection is ended, a counter says so", async () => {
    state.locked = false;
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { verifyAllWallets } = await import("../../../src/workers/rollup/credit-verify.js");
    vi.mocked(verifyAllWallets).mockClear();
    await run();
    expect(verifyAllWallets).not.toHaveBeenCalled();
    expect(state.clients[0]!.ended).toBe(true);
    expect(state.unlocked).toBe(0);
    expect(metrics(log).map((m) => m.metric)).toContain("nominara_credit_wallet_verify_yielded_total");
  });

  it("scenario 6 · a mismatch FAILS THE JOB with UnrecoverableError (one dead-letter entry, no re-walk), pages, counts and logs the workspace ID", async () => {
    state.result = { checked: 1, mismatch: MISMATCH };
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const failure = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(UnrecoverableError);
    expect((failure as Error).message).toContain(MISMATCH.workspaceId);
    expect(state.pages).toEqual([MISMATCH]);
    const counted = metrics(log).find((m) => m.metric === "nominara_credit_wallet_mismatch_total");
    expect(counted).toBeDefined();
    expect(error.mock.calls.flat().join(" ")).toContain(MISMATCH.workspaceId);
  });

  it("⚠ the page is sent AFTER the lock is released and the connection ended - never under the estate-wide lock", async () => {
    state.result = { checked: 1, mismatch: MISMATCH };
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    await run().catch(() => undefined);
    expect(state.lockHeldWhenPaged).toEqual([false]);
    expect(state.clients[0]!.ended).toBe(true);
  });

  it("an unexpected error (e.g. migration 0023 missing) propagates, ends the connection and releases the lock - it is never reported as clean", async () => {
    state.throws = new Error("credit_ledger has no seq column");
    await expect(run()).rejects.toThrow(/seq column/u);
    expect(state.clients[0]!.ended).toBe(true);
    expect(state.unlocked).toBe(1);
  });

  it("logs the workspace ID and counts only - never a name or an email", async () => {
    state.result = { checked: 1, mismatch: MISMATCH };
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    await run().catch(() => undefined);
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/name|email/iu);
  });
});
