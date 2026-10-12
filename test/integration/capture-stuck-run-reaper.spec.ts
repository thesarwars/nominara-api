import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { provisionWalletWithGrant } from "../../src/lib/credits/balance.js";
import { appendLedgerEntry } from "../../src/lib/credits/ledger.js";
import { verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
import { commitCredits, readWallet, reserveCredits } from "../../src/lib/credits/wallet.js";
import { readRunProgress } from "../../src/lib/capture/run-progress.js";
import { SchedulerSweepRuntime } from "../../src/lib/capture/scheduler-sweep.js";
import { STALE_QUEUED_RUN_BOUND_MS } from "../../src/lib/capture/stale-run-reaper.js";
import { STUCK_RUN_GRACE_MS, reapStuckRuns } from "../../src/lib/capture/stuck-run-reaper.js";
import type { EnqueueRollup } from "../../src/lib/queue/handlers/run-rollup-request.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// SCANFIX D4 — runs ALREADY stuck by the 2026-10-12 incident (cells in the DLQ,
// run running/queued for ever) are finalised by a sweep: the cells that never
// produced a row count as failed, the money is settled by the same rule as a live
// finish, and the rollup is requested so the captured cells become scores.

const HOUR_MS = 60 * 60 * 1000;
const CHARGE = 500;

describe("SCANFIX-D4 · the stuck-run reaper", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let owner: Client;
  let rollups: { workspaceId: string; payload: Record<string, unknown>; idempotencyKey: string }[];
  const enqueueRollup: EnqueueRollup = (_queue, workspaceId, payload, idempotencyKey) => {
    rollups.push({ workspaceId, payload, idempotencyKey });
    return Promise.resolve();
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    owner = new Client({ connectionString: container.getConnectionUri() });
    await owner.connect();
  }, 300_000);

  afterAll(async () => {
    await owner.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    rollups = [];
    await db.query("TRUNCATE answer_captures, tracked_prompts, capture_runs, projects, credit_ledger, credit_wallets, workspaces, users CASCADE");
  });

  interface Tenant {
    ws: string;
    project: string;
    user: string;
    prompt: string;
  }

  async function addTenant(): Promise<Tenant> {
    const ws = randomUUID();
    const project = randomUUID();
    const prompt = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'Secret Co Name',$2,'growth','UTC')", [ws, `w-${randomUUID().slice(0, 8)}`]);
    const user = (await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`a-${randomUUID().slice(0, 8)}@nominara.test`])).rows[0]!.id;
    await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://e.test','e.test')", [project, ws, `p-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [prompt, ws, project],
    );
    return { ws, project, user, prompt };
  }

  async function addRun(t: Tenant, o: { ageHours: number; planned?: number; status?: string; trigger?: string; skipped?: number }): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells, skipped_cells, status, created_at, started_at)
       VALUES ($1,$2,$3,$4,ARRAY['gemini'],$5,$6,$7, now() - ($8 || ' hours')::interval,
               CASE WHEN $7 = 'running' THEN now() - ($8 || ' hours')::interval END)`,
      [id, t.ws, t.project, o.trigger ?? "manual", o.planned ?? 51, o.skipped ?? 0, o.status ?? "running", String(o.ageHours)],
    );
    return id;
  }

  /** `count` real captures for the run, written `ageHours` ago. */
  async function addCaptures(t: Tenant, runId: string, count: number, o: { ageHours: number; status?: string }): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await db.query(
        `INSERT INTO answer_captures
           (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version,
            normalizer_version, content_hash, flags, cache_layer, status, sample_index)
         VALUES ($1,$2,$3,$4,$5,'gemini', now() - ($6 || ' hours')::interval,'api','1.0.0','n1',$7,'{}','live',$8,$9)`,
        [randomUUID(), t.ws, t.project, runId, t.prompt, String(o.ageHours), createHash("sha256").update(randomUUID()).digest(), o.status ?? "parsed", i],
      );
    }
  }

  async function charge(t: Tenant, runId: string): Promise<void> {
    await db.query("BEGIN");
    await provisionWalletWithGrant(db, t.ws, 1_000, { start: "2026-09-01", end: "2026-10-01" });
    const reserved = await reserveCredits(db, t.ws, CHARGE);
    await appendLedgerEntry(db, { workspaceId: t.ws, entryType: "reserve", actionCode: "manual_scan", credits: CHARGE, idempotencyKey: `deep-${runId}`, attempt: 1, after: reserved.wallet!, actorId: t.user, actorType: "user" });
    const committed = await commitCredits(db, t.ws, CHARGE, CHARGE);
    await appendLedgerEntry(db, { workspaceId: t.ws, entryType: "commit", actionCode: "manual_scan", credits: CHARGE, idempotencyKey: `deep-${runId}`, attempt: 1, after: committed!, actorId: t.user, actorType: "user", referenceType: "run", referenceId: runId });
    await db.query("COMMIT");
  }

  const runRow = async (id: string) =>
    (await db.query<{ status: string; finished_at: Date | null; failed_cells: number }>("SELECT status, finished_at, failed_cells FROM capture_runs WHERE id = $1", [id])).rows[0]!;
  const refunds = async (ws: string) =>
    (await db.query<{ credits: string }>("SELECT credits::text FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'refund'", [ws])).rows.map((r) => Number(r.credits));
  const progress = (t: Tenant, runId: string) =>
    withTenantContext(db, { workspaceId: t.ws, actorId: SYSTEM_ACTOR_ID }, (tx) => readRunProgress(tx, runId));

  it("SCANFIX-D4a · the incident: 11 real captures + 40 cells lost to the DLQ -> the run finishes partial, counts add up to planned, and the rollup is requested", async () => {
    const t = await addTenant();
    const run = await addRun(t, { ageHours: 30, planned: 51, status: "running" });
    await addCaptures(t, run, 11, { ageHours: 29 });
    await charge(t, run);

    const result = await reapStuckRuns(owner, new Date(), { enqueueRollup });

    expect(result).toEqual({ finalized: 1 });
    const row = await runRow(run);
    expect(row.status).toBe("partial");
    expect(row.finished_at).not.toBeNull();
    const p = await progress(t, run);
    expect(p).toMatchObject({ planned: 51, captured: 11, failed: 40, pct: 100 });
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({ workspaceId: t.ws, idempotencyKey: `rollup:${t.project}:run:${run}`, payload: { projectId: t.project } });
    // Partial is charged in full (FR-SCAN-01h; flat price) - and the wallet still replays.
    expect(await refunds(t.ws)).toEqual([]);
    expect(await verifyWorkspaceWallet(db, t.ws)).toBeNull();
  });

  it("SCANFIX-D4b · a stuck run that never captured anything is finalised failed and refunded in full, even from `queued`", async () => {
    const t = await addTenant();
    const run = await addRun(t, { ageHours: 30, planned: 51, status: "queued" });
    await charge(t, run);

    await reapStuckRuns(owner, new Date(), { enqueueRollup });

    expect((await runRow(run)).status).toBe("failed");
    expect((await runRow(run)).failed_cells).toBe(51);
    expect(await refunds(t.ws)).toEqual([CHARGE]);
    expect(await readWallet(db, t.ws)).toMatchObject({ includedBalance: 1_000 });
    expect(await verifyWorkspaceWallet(db, t.ws)).toBeNull();
  });

  it("SCANFIX-D4c · reaping twice finalises once and refunds once", async () => {
    const t = await addTenant();
    const run = await addRun(t, { ageHours: 30, planned: 5 });
    await charge(t, run);

    await reapStuckRuns(owner, new Date(), { enqueueRollup });
    const second = await reapStuckRuns(owner, new Date(), { enqueueRollup });

    expect(second).toEqual({ finalized: 0 });
    expect(await refunds(t.ws)).toEqual([CHARGE]);
    expect(rollups).toHaveLength(1);
  });

  it("SCANFIX-D4d · cells that were suppressed count as done: planned 10, skipped 4, 2 captured -> 4 lost, not 8", async () => {
    const t = await addTenant();
    const run = await addRun(t, { ageHours: 30, planned: 10, skipped: 4 });
    await addCaptures(t, run, 2, { ageHours: 29 });

    await reapStuckRuns(owner, new Date(), { enqueueRollup });

    expect((await runRow(run)).failed_cells).toBe(4);
    expect(await progress(t, run)).toMatchObject({ planned: 10, captured: 2, skipped: 4, failed: 4 });
  });

  it("SCANFIX-D4e · a failed row already written by the live path is not counted twice", async () => {
    const t = await addTenant();
    const run = await addRun(t, { ageHours: 30, planned: 6 });
    await addCaptures(t, run, 2, { ageHours: 29 });
    await addCaptures(t, run, 1, { ageHours: 29, status: "failed" });

    await reapStuckRuns(owner, new Date(), { enqueueRollup });

    expect((await runRow(run)).failed_cells).toBe(3); // 6 - 2 captured - 1 failed row
    expect(await progress(t, run)).toMatchObject({ planned: 6, captured: 2, failed: 4 });
  });

  it("SCANFIX-D4f · a captured-but-unparsed sibling means the parse will ask for the rollup: the reaper finalises but does not request one", async () => {
    const t = await addTenant();
    const run = await addRun(t, { ageHours: 30, planned: 3 });
    await addCaptures(t, run, 1, { ageHours: 29, status: "captured" });

    await reapStuckRuns(owner, new Date(), { enqueueRollup });

    expect((await runRow(run)).status).toBe("partial");
    expect(rollups).toEqual([]);
  });

  it("SCANFIX-D4g · a run with recent activity, a young run, a terminal run and a scheduled queued run are all left alone", async () => {
    const t = await addTenant();
    const active = await addRun(t, { ageHours: 30, planned: 20 });
    await addCaptures(t, active, 1, { ageHours: 0.1 }); // a cell landed minutes ago: the queue is alive
    const young = await addRun(t, { ageHours: 1, planned: 20 });
    const done = await addRun(t, { ageHours: 30, planned: 20, status: "completed" });
    const scheduledQueued = await addRun(t, { ageHours: 30, planned: 20, status: "queued", trigger: "scheduled" });

    const result = await reapStuckRuns(owner, new Date(), { enqueueRollup });

    expect(result).toEqual({ finalized: 0 });
    expect((await runRow(active)).status).toBe("running");
    expect((await runRow(young)).status).toBe("running");
    expect((await runRow(done)).status).toBe("completed");
    expect((await runRow(scheduledQueued)).status).toBe("queued"); // the stale-queued reaper's, with its own semantics
  });

  it("SCANFIX-D4h · the grace window is the stale-queued bound by default and is honoured when overridden", async () => {
    expect(STUCK_RUN_GRACE_MS).toBe(STALE_QUEUED_RUN_BOUND_MS);
    const t = await addTenant();
    const run = await addRun(t, { ageHours: 3, planned: 4 });

    expect(await reapStuckRuns(owner, new Date(), { enqueueRollup })).toEqual({ finalized: 0 });
    expect(await reapStuckRuns(owner, new Date(), { enqueueRollup, graceMs: 2 * HOUR_MS })).toEqual({ finalized: 1 });
    expect((await runRow(run)).status).toBe("failed");
  });

  it("SCANFIX-D4i · each workspace is settled in its own tenant context, across tenants", async () => {
    const a = await addTenant();
    const b = await addTenant();
    const runA = await addRun(a, { ageHours: 30, planned: 3 });
    const runB = await addRun(b, { ageHours: 30, planned: 3 });
    await charge(a, runA);
    await charge(b, runB);

    await expect(reapStuckRuns(owner, new Date(), { enqueueRollup })).resolves.toEqual({ finalized: 2 });

    expect(await refunds(a.ws)).toEqual([CHARGE]);
    expect(await refunds(b.ws)).toEqual([CHARGE]);
    expect(new Set(rollups.map((r) => r.workspaceId))).toEqual(new Set([a.ws, b.ws]));
  });

  it("SCANFIX-D4j · the sweep runtime's tick runs it", async () => {
    const t = await addTenant();
    const run = await addRun(t, { ageHours: 30, planned: 3 });
    const runtime = new SchedulerSweepRuntime({
      connect: () => {
        const client = new Client({ connectionString: container.getConnectionUri() });
        return client.connect().then(() => client);
      },
      enqueue: () => Promise.resolve(),
      enqueueRollup,
    });

    await runtime.tick();

    expect((await runRow(run)).status).toBe("failed");
  });
});
