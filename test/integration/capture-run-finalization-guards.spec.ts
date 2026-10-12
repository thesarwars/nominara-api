import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeRun } from "../../src/lib/capture/finalize-run.js";
import { readRunProgress } from "../../src/lib/capture/run-progress.js";
import { reapStuckRuns } from "../../src/lib/capture/stuck-run-reaper.js";
import { refundCredits } from "../../src/lib/credits/balance.js";
import { verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
import { settleFinishedRunCredits } from "../../src/lib/credits/run-settlement.js";
import { readWallet } from "../../src/lib/credits/wallet.js";
import { CaptureFailureError } from "../../src/lib/engines/failure-taxonomy.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import {
  CHARGE,
  addCapture,
  addPrompt,
  addRun,
  addTenant,
  chargeRun,
  deferred,
  executeOn,
  jobFor,
  refundsFor,
  runRow,
  someoneWaitsOnALock,
  startRaceDb,
  truncateAll,
  type Emitted,
  type RaceDb,
  type Tenant,
} from "../support/run-race-fixture.js";

// SCANFIX D6 - every guard against a double finalisation or a double refund, pinned so that
// removing ANY ONE of them turns a test red. The code is correct through layered protection,
// and layers hide each other: delete the status predicate and the ledger's key still stops a
// second refund; change the key and the early-out still does. So each layer gets a test in
// which the OTHER layers cannot help:
//   - finalizeRun's `status IN ('queued','running')`  -> the second call's RETURN VALUE (null)
//   - settlement's `alreadyRefunded` early-out        -> a prior refund under a DIFFERENT key
//   - the debit's idempotency key per bucket          -> two transactions that BOTH pass the
//                                                        early-out before either commits
//   - the reaper's under-lock re-check                -> D5a (a cell commits between the
//                                                        reaper's SELECT and its lock)

const adapter = vi.hoisted(() => ({ run: (_text: string): Promise<unknown> => Promise.resolve(undefined) }));

vi.mock("../../src/lib/engines/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/engines/registry.js")>();
  return {
    ...actual,
    resolveEngine: () => ({
      engineKey: "gemini",
      captureMode: "api",
      adapterVersion: "1.0.0",
      supportsCitations: true,
      concurrencyPerTask: 1,
      healthProbe: () => Promise.resolve({ ok: true, latencyMs: 1 }),
      capture: (input: { promptText: string }) => adapter.run(input.promptText),
    }),
  };
});

const ANSWER = { text: "answer", format: "markdown", truncated: false, responseTokensEst: 1, latencyMs: 5, costUsd: 0 };

describe("SCANFIX-D6 · a run is finalised once and refunded at most once, however it is reached", () => {
  let rig: RaceDb;
  let db: Client;
  let second: Client;
  let probe: Client;
  let emitted: Emitted[];
  const enqueueRollup = (): Promise<void> => Promise.resolve();

  beforeAll(async () => {
    rig = await startRaceDb();
    db = rig.db;
    [second, probe] = await Promise.all([rig.connect(), rig.connect()]);
  }, 300_000);

  afterAll(async () => {
    await rig.stop();
  });

  beforeEach(async () => {
    await truncateAll(db);
    emitted = [];
    adapter.run = () => Promise.resolve(ANSWER);
  });

  const ctx = (t: Tenant) => ({ workspaceId: t.ws, actorId: SYSTEM_ACTOR_ID });
  const finalise = (client: Client, t: Tenant, runId: string) =>
    withTenantContext(client, ctx(t), async (tx) => finalizeRun(tx, t.ws, await readRunProgress(tx, runId)));

  it("SCANFIX-D6a · finalising a run that delivered nothing twice: the second call is a no-op (null), and the charge is refunded once", async () => {
    const t = await addTenant(db);
    const run = await addRun(db, t, { planned: 2 });
    await chargeRun(db, t, run);
    await db.query("UPDATE capture_runs SET failed_cells = 2 WHERE id = $1", [run]);

    const first = await finalise(db, t, run);
    const finishedAt = (await runRow(db, run)).finished_at;
    const again = await finalise(db, t, run);

    expect(first).toMatchObject({ status: "failed", refunded: CHARGE });
    expect(again, "a second finalisation must report that it did nothing").toBeNull();
    expect((await runRow(db, run)).finished_at).toEqual(finishedAt);
    expect(await refundsFor(db, t.ws)).toEqual([CHARGE]);
    expect(await verifyWorkspaceWallet(db, t.ws)).toBeNull();
  });

  it("SCANFIX-D6b · finalising a PARTIAL run twice (the case the handler's skip cannot reach): the status and finish time stay put, and nothing is refunded", async () => {
    const t = await addTenant(db);
    const run = await addRun(db, t, { planned: 2 });
    await chargeRun(db, t, run);
    await addCapture(db, t, run, await addPrompt(db, t), { sampleIndex: 0 });
    await db.query("UPDATE capture_runs SET failed_cells = 1 WHERE id = $1", [run]);

    const first = await finalise(db, t, run);
    const row = await runRow(db, run);
    // The run is partial; a second finalisation computed from different numbers must not rewrite it.
    await db.query("UPDATE capture_runs SET failed_cells = 0 WHERE id = $1", [run]);
    const again = await finalise(db, t, run);

    expect(first).toMatchObject({ status: "partial", refunded: 0 });
    expect(again).toBeNull();
    expect(await runRow(db, run)).toMatchObject({ status: "partial", finished_at: row.finished_at });
    expect(await refundsFor(db, t.ws)).toEqual([]);
  });

  it("SCANFIX-D6c · settlement: a refund already recorded under ANOTHER key is not topped up by the failure refund", async () => {
    const t = await addTenant(db);
    const run = await addRun(db, t, { planned: 1 });
    await chargeRun(db, t, run);
    await db.query("BEGIN");
    await refundCredits(db, { workspaceId: t.ws, idempotencyKey: "manual-goodwill:included", actorId: t.user, actorType: "user", referenceType: "run", referenceId: run }, "included", CHARGE);
    await db.query("COMMIT");

    const outcome = await withTenantContext(db, ctx(t), (tx) => settleFinishedRunCredits(tx, { workspaceId: t.ws, runId: run, deliveredCells: 0 }));

    expect(outcome).toEqual({ refunded: 0 });
    expect(await refundsFor(db, t.ws)).toEqual([CHARGE]);
    expect(await readWallet(db, t.ws)).toMatchObject({ includedBalance: 1_000 });
    expect(await verifyWorkspaceWallet(db, t.ws)).toBeNull();
  });

  it("SCANFIX-D6d · settlement: two transactions that both pass the early-out before either commits refund ONCE - the per-bucket idempotency key is the guarantee", async () => {
    const t = await addTenant(db);
    const run = await addRun(db, t, { planned: 1 });
    await chargeRun(db, t, run);

    const firstHasRefunded = deferred();
    const firstMayCommit = deferred();
    const first = withTenantContext(db, ctx(t), async (tx) => {
      const outcome = await settleFinishedRunCredits(tx, { workspaceId: t.ws, runId: run, deliveredCells: 0 });
      firstHasRefunded.resolve();
      await firstMayCommit.promise;
      return outcome;
    });
    await firstHasRefunded.promise;

    // The second begins while the first's refund is uncommitted: it cannot see it, so the
    // `alreadyRefunded` early-out says no and it goes on to refund - and must be stopped by the key.
    let secondDone = false;
    const secondRun = withTenantContext(second, ctx(t), (tx) => settleFinishedRunCredits(tx, { workspaceId: t.ws, runId: run, deliveredCells: 0 })).finally(() => {
      secondDone = true;
    });
    const secondWaited = await someoneWaitsOnALock(probe, () => secondDone);
    firstMayCommit.resolve();
    const [a, b] = await Promise.all([first, secondRun]);

    expect(secondWaited, "the test must really interleave the two transactions").toBe(true);
    expect(a.refunded + b.refunded).toBe(CHARGE);
    expect(await refundsFor(db, t.ws)).toEqual([CHARGE]);
    expect(await readWallet(db, t.ws)).toMatchObject({ includedBalance: 1_000 });
    expect(await verifyWorkspaceWallet(db, t.ws)).toBeNull();
  });

  it("SCANFIX-D6e · the last cell and a reaper pass at the same moment: exactly one run.completed, one refund, a clean wallet", async () => {
    const t = await addTenant(db);
    // Idle for 30 h with its other cell long since failed: the reaper has every reason to take it.
    const run = await addRun(db, t, { ageHours: 30, planned: 2 });
    await chargeRun(db, t, run);
    await addCapture(db, t, run, await addPrompt(db, t), { ageHours: 29, status: "failed", sampleIndex: 0 });
    const prompt = await addPrompt(db, t, "boom");

    const inVendorCall = deferred();
    const vendorFails = deferred();
    adapter.run = async () => {
      inVendorCall.resolve();
      await vendorFails.promise;
      throw new CaptureFailureError("rate_limited", "gemini");
    };
    const cell = executeOn(db, t, jobFor(t, run, prompt, "boom", { sampleIndex: 1, final: true }), emitted);
    await inVendorCall.promise;

    let reaperDone = false;
    const reaper = reapStuckRuns(second, new Date(), { enqueueRollup }).finally(() => {
      reaperDone = true;
    });
    const reaperWaited = await someoneWaitsOnALock(probe, () => reaperDone);
    vendorFails.resolve();
    await cell;
    const reaped = await reaper;

    expect(reaperWaited).toBe(true);
    expect(emitted.filter((e) => e.event === "run.completed")).toHaveLength(1);
    expect(reaped).toEqual({ finalized: 0 }); // the cell finished the run first; the reaper found it terminal
    expect(await runRow(db, run)).toMatchObject({ status: "failed", failed_cells: 0 });
    expect(await refundsFor(db, t.ws)).toEqual([CHARGE]);
    expect(await verifyWorkspaceWallet(db, t.ws)).toBeNull();
  });

  it("SCANFIX-D6f · N final cells racing repeated reaper passes: one terminal state, at most one run.completed, at most one refund, planned never exceeded, wallet clean", async () => {
    const CELLS = 6;
    const t = await addTenant(db);
    const run = await addRun(db, t, { ageHours: 30, planned: CELLS });
    await chargeRun(db, t, run);
    const prompts = await Promise.all(Array.from({ length: CELLS }, (_, i) => addPrompt(db, t, `boom${String(i)}`)));
    adapter.run = () => Promise.reject(new CaptureFailureError("rate_limited", "gemini"));
    const cellClients = await Promise.all(Array.from({ length: CELLS }, () => rig.connect()));
    const reaperClient = await rig.connect();

    // graceMs 0: every run counts as idle, so the reaper contests the run at every moment.
    let cellsDone = false;
    const reaperPasses = (async () => {
      let finalized = 0;
      while (!cellsDone) finalized += (await reapStuckRuns(reaperClient, new Date(), { enqueueRollup, graceMs: 0 })).finalized;
      finalized += (await reapStuckRuns(reaperClient, new Date(), { enqueueRollup, graceMs: 0 })).finalized;
      return finalized;
    })();
    const cells = await Promise.allSettled(prompts.map((p, i) => executeOn(cellClients[i]!, t, jobFor(t, run, p, "boom", { sampleIndex: i, final: true }), emitted)));
    cellsDone = true;
    const reaperFinalized = await reaperPasses;
    // A cell that threw (a deadlock between two cells, say) is a failure of the run, not a detail.
    expect(cells.filter((c) => c.status === "rejected").map((c) => String((c as PromiseRejectedResult).reason))).toEqual([]);

    const row = await runRow(db, run);
    const progress = await withTenantContext(db, ctx(t), (tx) => readRunProgress(tx, run));
    expect(row.status).toBe("failed");
    expect(emitted.filter((e) => e.event === "run.completed").length + reaperFinalized, "finalised exactly once, by one party").toBe(1);
    expect(progress.captured + progress.skipped + progress.failed, "a lost-cell count plus real rows never exceeds planned").toBeLessThanOrEqual(CELLS);
    expect(await refundsFor(db, t.ws)).toEqual([CHARGE]);
    expect(await readWallet(db, t.ws)).toMatchObject({ includedBalance: 1_000, reserved: 0 });
    expect(await verifyWorkspaceWallet(db, t.ws)).toBeNull();
  }, 60_000);
});
