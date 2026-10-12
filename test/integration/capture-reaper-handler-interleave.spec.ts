import type { Client } from "pg";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
import { readWallet } from "../../src/lib/credits/wallet.js";
import { reapStuckRuns } from "../../src/lib/capture/stuck-run-reaper.js";
import {
  CHARGE,
  addPrompt,
  addRun,
  addTenant,
  captureCount,
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
} from "../support/run-race-fixture.js";

// SCANFIX D5 - the stuck-run reaper and a cell that is STILL RUNNING must be kept apart.
//
// The hazard: the handler read the run with a plain `SELECT status` (no lock) and its only
// later write, `UPDATE ... WHERE status = 'queued'`, locks nothing once the run is
// `running`. So the reaper's `FOR UPDATE` did not wait for a cell whose vendor call was
// still in progress: it counted that cell as lost, finalised the run `failed`, refunded the
// FULL charge and committed - and the cell then committed a captured answer on a refunded
// run. Reachable through the incident's own recovery path: a run idle for more than 6 h with
// its cells in the DLQ, an operator replays one (admin DLQ replay), the sweep ticks mid-call.
//
// The vendor is the only fake; the handler, the reaper, the row locks and the ledger are real,
// on separate connections to one Postgres.

const adapter = vi.hoisted(() => ({
  calls: [] as string[],
  run: (_text: string): Promise<unknown> => Promise.resolve(undefined),
}));

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
      capture: (input: { promptText: string }) => {
        adapter.calls.push(input.promptText);
        return adapter.run(input.promptText);
      },
    }),
  };
});

const ANSWER = { text: "answer", format: "markdown", truncated: false, responseTokensEst: 1, latencyMs: 5, costUsd: 0 };

describe("SCANFIX-D5 · the reaper never finalises a run out from under a cell that is mid-call", () => {
  let rig: RaceDb;
  let db: Client;
  let owner: Client; // the sweep's connection
  let probe: Client;
  let operator: Client; // stands in for "another transaction holding the run's lock"
  let emitted: Emitted[];
  const rollups: unknown[] = [];
  const enqueueRollup = (_queue: string, _ws: string, payload: unknown): Promise<void> => {
    rollups.push(payload);
    return Promise.resolve();
  };

  beforeAll(async () => {
    rig = await startRaceDb();
    db = rig.db;
    [owner, probe, operator] = await Promise.all([rig.connect(), rig.connect(), rig.connect()]);
  }, 300_000);

  afterAll(async () => {
    await rig.stop();
  });

  beforeEach(async () => {
    await truncateAll(db);
    emitted = [];
    rollups.length = 0;
    adapter.calls.length = 0;
    adapter.run = () => Promise.resolve(ANSWER);
  });

  it("SCANFIX-D5a · a cell mid-vendor-call holds the reaper off: the idle run is NOT finalised or refunded, and the answer lands on a live run", async () => {
    const t = await addTenant(db);
    const run = await addRun(db, t, { ageHours: 30, planned: 3, status: "running" });
    await chargeRun(db, t, run);
    const prompt = await addPrompt(db, t, "slow");

    const inVendorCall = deferred();
    const vendorAnswers = deferred();
    adapter.run = async () => {
      inVendorCall.resolve();
      await vendorAnswers.promise;
      return ANSWER;
    };

    const cell = executeOn(db, t, jobFor(t, run, prompt, "slow"), emitted);
    await inVendorCall.promise;

    let reaperDone = false;
    const reaper = reapStuckRuns(owner, new Date(), { enqueueRollup }).finally(() => {
      reaperDone = true;
    });
    const reaperWaited = await someoneWaitsOnALock(probe, () => reaperDone);

    vendorAnswers.resolve();
    await cell;
    const reaped = await reaper;

    // The money is the point: nothing may be refunded on a run that then delivers an answer.
    expect(await refundsFor(db, t.ws)).toEqual([]);
    expect(await readWallet(db, t.ws)).toMatchObject({ includedBalance: 1_000 - CHARGE });
    expect(await verifyWorkspaceWallet(db, t.ws)).toBeNull();
    expect(await captureCount(db, run)).toBe(1);
    expect(await runRow(db, run)).toMatchObject({ status: "running", failed_cells: 0, captured_cells: 1 });
    expect(reaped).toEqual({ finalized: 0 });
    expect(rollups).toEqual([]);
    expect(reaperWaited, "the reaper must WAIT for the in-flight cell, not race past it").toBe(true);
  });

  it("SCANFIX-D5b · a cell that arrives while the reaper holds the run waits for it, then skips the finalised run: no vendor call, no row, no double count", async () => {
    const t = await addTenant(db);
    const run = await addRun(db, t, { ageHours: 30, planned: 3, status: "running" });
    const prompt = await addPrompt(db, t, "late");

    // The reaper's transaction, frozen after it took the lock.
    await operator.query("BEGIN");
    await operator.query("SELECT id FROM capture_runs WHERE id = $1 FOR UPDATE", [run]);

    let cellDone = false;
    const cell = executeOn(db, t, jobFor(t, run, prompt, "late"), emitted).finally(() => {
      cellDone = true;
    });
    const cellWaited = await someoneWaitsOnALock(probe, () => cellDone);

    await operator.query("UPDATE capture_runs SET status = 'partial', finished_at = now(), failed_cells = 3 WHERE id = $1", [run]);
    await operator.query("COMMIT");
    await cell;

    expect(adapter.calls, "a paid vendor call on a finalised run").toEqual([]);
    expect(await captureCount(db, run)).toBe(0);
    expect(await runRow(db, run)).toMatchObject({ status: "partial", captured_cells: 0, failed_cells: 3 });
    expect(emitted).toEqual([]);
    expect(cellWaited, "the cell must queue behind the reaper's lock").toBe(true);
  });

  it.each(["completed", "partial", "failed", "canceled"])(
    "SCANFIX-D5c · a late or replayed cell on a run already %s is skipped: it does not call the vendor, write a row, or count",
    async (status) => {
      const t = await addTenant(db);
      const run = await addRun(db, t, { ageHours: 1, planned: 2, status });
      const prompt = await addPrompt(db, t, "replay");

      const logged: unknown[] = [];
      const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((line: unknown) => {
        logged.push(line);
      });
      try {
        await executeOn(db, t, jobFor(t, run, prompt, "replay"), emitted);
      } finally {
        spy.mockRestore();
      }

      // Observable: a counter, and a log line carrying the workspace ID and nothing from the prompt.
      expect(logged).toContainEqual({ metric: "nominara_capture_cells_skipped_terminal_run_total", value: 1, status });
      expect(logged).toContainEqual({ event: "capture.cell.skipped_terminal_run", workspace_id: t.ws, run_id: run, status });
      expect(adapter.calls).toEqual([]);
      expect(await captureCount(db, run)).toBe(0);
      expect(await runRow(db, run)).toMatchObject({ status, captured_cells: 0, failed_cells: 0 });
      expect(emitted).toEqual([]);
    },
  );
});
