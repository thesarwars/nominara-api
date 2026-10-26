import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { EngineSkipRefundSweepBlindError, sweepEngineSkipRefunds } from "../../src/lib/capture/engine-skip-refund-sweep.js";
import { settleEngineSkippedCells } from "../../src/lib/credits/engine-skip-refund.js";
import { ENGINE_SKIP_QUOTA_EXHAUSTED } from "../../src/lib/engines/capture-engine-gate.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { addCapture, addPrompt, addRun, addTenant, chargeRun, refundsFor, startRaceDb, truncateAll, type RaceDb, type Tenant } from "../support/run-race-fixture.js";

// STORY-031 review round 2 - the engine-skip refund sweep's CANDIDATE query, on a connection that RLS binds.
//
// The sweep finds candidates on its own connection with no tenant context, across capture_runs, answer_captures and
// credit_ledger. Every other spec of it connects as the testcontainers superuser, which bypasses RLS. Under FORCE RLS a
// NOBYPASSRLS role sees no rows without a tenant context, so on such a connection the candidate query finds nothing and the
// sweep would return "0 refunded" while a customer is owed a refund: silent, and every superuser-run test still green.
//
// The hazard is the SILENCE, not the role: the scheduler tick refuses a blind connection before it reaches the sweep
// (`assertSweepCanSee`), but the sweep is an exported function and must not depend on its caller for that. So the sweep refuses
// a connection that cannot see across tenants, loudly, before it reads anything.

describe("STORY-031 · the engine-skip refund sweep refuses a connection that cannot see across tenants", () => {
  let rig: RaceDb;
  let worker: Client;

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

  /** A finished, charged, partial manual run with one cell skipped because the engine's quota was exhausted: owed a refund. */
  async function owedRefund(): Promise<Tenant> {
    return (await owedRefundRun()).t;
  }

  async function owedRefundRun(): Promise<{ t: Tenant; run: string }> {
    const t = await addTenant(rig.db);
    const run = await addRun(rig.db, t, { ageHours: 2, planned: 2, status: "partial" });
    await chargeRun(rig.db, t, run);
    await addCapture(rig.db, t, run, await addPrompt(rig.db, t), { ageHours: 2, sampleIndex: 0 });
    await addCapture(rig.db, t, run, await addPrompt(rig.db, t), { ageHours: 2, sampleIndex: 0, status: "blocked" });
    await rig.db.query("UPDATE answer_captures SET error_code = $2 WHERE run_id = $1 AND status = 'blocked'", [run, ENGINE_SKIP_QUOTA_EXHAUSTED]);
    return { t, run };
  }

  it("the worker connection really is RLS-bound (so the refusal below cannot pass vacuously)", async () => {
    const role = await worker.query<{ rolbypassrls: boolean; rolsuper: boolean }>("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user");
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it("on an RLS-bound connection, with a refund owed, the sweep throws instead of reporting nothing refunded", async () => {
    const t = await owedRefund();
    await expect(sweepEngineSkipRefunds(worker, new Date())).rejects.toBeInstanceOf(EngineSkipRefundSweepBlindError);
    expect(await refundsFor(rig.db, t.ws)).toEqual([]);
  });

  it("positive control: the same candidate on a connection that sees across tenants is refunded", async () => {
    const t = await owedRefund();
    await expect(sweepEngineSkipRefunds(rig.db, new Date())).resolves.toEqual({ refundedRuns: 1 });
    expect((await refundsFor(rig.db, t.ws)).length).toBe(1);
  });

  // Review round 3. The sweep refuses an RLS-bound connection, so the per-candidate tenant transaction runs on a connection that
  // BYPASSES RLS: the tenant context is defence in depth there, not the boundary. Every read the settlement makes must therefore
  // carry the workspace itself. Hazard: a caller passing a workspace that does not own the run must settle nothing for it - not
  // count the other tenant's skipped cells, not lock the other tenant's run row.
  it("on the owner connection, a run passed with a workspace that does not own it is not read: nothing counted, nothing refunded", async () => {
    const owner = await owedRefundRun();
    const other = await addTenant(rig.db);
    const outcome = await withTenantContext(rig.db, { workspaceId: other.ws, actorId: SYSTEM_ACTOR_ID }, (tx) =>
      settleEngineSkippedCells(tx, { workspaceId: other.ws, runId: owner.run }),
    );
    expect(outcome).toEqual({ refunded: 0, skippedCells: 0, debitBeforeCurrentCycle: false });
    expect(await refundsFor(rig.db, owner.t.ws)).toEqual([]);
    expect(await refundsFor(rig.db, other.ws)).toEqual([]);
  });
});
