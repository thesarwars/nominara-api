import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { reapStuckRun, STUCK_RUN_GRACE_MS } from "../../src/lib/capture/stuck-run-reaper.js";
import {
  addCapture,
  addPrompt,
  addRun,
  addTenant,
  chargeRun,
  runRow,
  startRaceDb,
  truncateAll,
  type RaceDb,
} from "../support/run-race-fixture.js";

// SCANFIX D7 - the reaper's per-run transaction, run as the RUNTIME role.
//
// The reaper's other specs connect as the testcontainers superuser, which bypasses RLS, so a
// reaper that wrote under the wrong `withTenantContext` workspace - or with none - would still
// pass them. This one connects as `nominara_worker` (the role the capture worker runs as;
// NOT BYPASSRLS, asserted below so the test cannot go vacuous) and shows that:
//   - with the right context the reaper can do its whole job, writes and refund included
//     (the positive control: a mutation that makes the context wrong turns this red), and
//   - with a context that does not own the run, the database refuses everything and not one
//     row of `capture_runs` or `credit_ledger` changes.

describe("SCANFIX-D7 · the stuck-run reaper's per-run transaction under RLS, as the runtime role", () => {
  let rig: RaceDb;
  let worker: Client;
  const enqueueRollup = (): Promise<void> => Promise.resolve();
  const NOW = () => new Date();
  const cutoff = () => new Date(Date.now() - STUCK_RUN_GRACE_MS);

  beforeAll(async () => {
    rig = await startRaceDb();
    const password = resolvePassword("nominara_worker", {});
    await rig.db.query(`ALTER ROLE nominara_worker PASSWORD ${rig.db.escapeLiteral(password)}`);
    worker = new Client({
      host: rig.container.getHost(),
      port: rig.container.getMappedPort(5432),
      database: rig.container.getDatabase(),
      user: "nominara_worker",
      password,
    });
    await worker.connect();
  }, 300_000);

  afterAll(async () => {
    await worker.end();
    await rig.stop();
  });

  beforeEach(async () => {
    await truncateAll(rig.db);
  });

  const ledgerRows = async () => Number((await rig.db.query<{ n: string }>("SELECT count(*)::text AS n FROM credit_ledger WHERE entry_type = 'refund'")).rows[0]!.n);

  it("SCANFIX-D7a · the connection really is subject to RLS (so the cases below cannot pass vacuously)", async () => {
    const role = await worker.query<{ rolbypassrls: boolean; rolsuper: boolean }>("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user");
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it("SCANFIX-D7b · positive control: in its OWN workspace's context the runtime role finalises the run, writes failed_cells and refunds the charge", async () => {
    const a = await addTenant(rig.db);
    const run = await addRun(rig.db, a, { ageHours: 30, planned: 3 });
    await chargeRun(rig.db, a, run);

    const status = await reapStuckRun(worker, { id: run, workspace_id: a.ws }, NOW(), cutoff(), { enqueueRollup });

    expect(status).toBe("failed");
    expect(await runRow(rig.db, run)).toMatchObject({ status: "failed", failed_cells: 3 });
    expect(await ledgerRows()).toBe(1);
  });

  it("SCANFIX-D7c · a run reaped under ANOTHER workspace's context is invisible: nothing is locked, finalised, counted or refunded", async () => {
    const a = await addTenant(rig.db);
    const b = await addTenant(rig.db);
    const runA = await addRun(rig.db, a, { ageHours: 30, planned: 3 });
    await chargeRun(rig.db, a, runA);
    await chargeRun(rig.db, b, await addRun(rig.db, b, { ageHours: 30, planned: 3 }));

    const status = await reapStuckRun(worker, { id: runA, workspace_id: b.ws }, NOW(), cutoff(), { enqueueRollup });

    expect(status).toBeNull();
    expect(await runRow(rig.db, runA)).toMatchObject({ status: "running", failed_cells: 0, finished_at: null });
    expect(await ledgerRows()).toBe(0);
  });

  it("SCANFIX-D7d · a run that became terminal before the reaper locked it is left exactly as it is: no lost-cell count is written onto it", async () => {
    const a = await addTenant(rig.db);
    const run = await addRun(rig.db, a, { ageHours: 30, planned: 3, status: "partial" });
    await addCapture(rig.db, a, run, await addPrompt(rig.db, a), { ageHours: 29, sampleIndex: 0 });

    const status = await reapStuckRun(worker, { id: run, workspace_id: a.ws }, NOW(), cutoff(), { enqueueRollup });

    expect(status).toBeNull();
    expect(await runRow(rig.db, run)).toMatchObject({ status: "partial", failed_cells: 0 });
  });
});
