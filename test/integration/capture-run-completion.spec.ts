import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import type { RealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { appendLedgerEntry } from "../../src/lib/credits/ledger.js";
import { provisionWalletWithGrant } from "../../src/lib/credits/balance.js";
import { verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
import { commitCredits, readWallet, reserveCredits } from "../../src/lib/credits/wallet.js";
import { CaptureFailureError } from "../../src/lib/engines/failure-taxonomy.js";
import type { SpendMeter } from "../../src/lib/engines/spend-meter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { createCaptureExecuteHandler } from "../../src/lib/queue/handlers/capture-execute.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// SCANFIX — D1 + D2 of the 2026-10-12 incident: 51 cells, 39 of them 429'd, every
// one used its five attempts and went to the dead-letter queue WITHOUT writing a
// terminal record. captured + failed + skipped never reached planned, so the runs
// sat at running/queued for ever, the rollup never fired, and no score appeared.
//
// What the reference says about the money (plans-and-entitlements.md §5, "Failed
// action"; page-inventory.md FR-SCAN-01h): a run that captures nothing is refunded
// in FULL; a partial run is charged in full and says so; a flat-price action has
// no per-cell arithmetic. The incident ticket asked for "refund only the failed
// cells" for a mixed run; the reference wins, and test D2c pins the reference.

// An adapter that fails on the prompt text "boom" the way a 429'd Gemini does, and
// answers anything else. The registry is the only seam: everything beneath it
// (captureCell, the advisory lock, the row writer) is the real code.
vi.mock("../../src/lib/engines/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/engines/registry.js")>();
  const { CaptureFailureError: Failure } = await import("../../src/lib/engines/failure-taxonomy.js");
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
        if (input.promptText === "boom") return Promise.reject(new Failure("rate_limited", "gemini"));
        if (input.promptText === "plain") return Promise.reject(new Error("socket hang up"));
        return Promise.resolve({ text: "answer", format: "markdown", truncated: false, responseTokensEst: 1, latencyMs: 5, costUsd: 0 });
      },
    }),
  };
});

const CHARGE = 500;
const publisher = (sink: { event: string; payload: Record<string, unknown> }[]): RealtimePublisher => ({
  toWorkspace: (_ws, event, payload) => {
    sink.push({ event, payload: payload as Record<string, unknown> });
  },
  toProject: (_ws, _project, event, payload) => {
    sink.push({ event, payload: payload as Record<string, unknown> });
  },
  memberChanged: () => undefined,
});

describe("SCANFIX · a cell that exhausts its retries is a terminal failure, and a run always finishes", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let userId: string;
  let runId: string;
  let prompts: string[];
  let rollups: { queue: string; payload: Record<string, unknown>; idempotencyKey: string }[];
  let emitted: { event: string; payload: Record<string, unknown> }[];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE answer_captures, tracked_prompts, capture_runs, projects, credit_ledger, credit_wallets, workspaces, users CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    runId = uuidV7();
    rollups = [];
    emitted = [];
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth','UTC')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    userId = (await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`a-${randomUUID().slice(0, 8)}@nominara.test`])).rows[0]!.id;
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1,$2,'P',$3,'https://e.test','e.test')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    prompts = [];
  });

  async function addPrompt(text: string): Promise<string> {
    const id = randomUUID();
    // The row's text is unique (ux_prompts_project_hash); the JOB carries the text the fake engine reacts to.
    const unique = `${text} ${id}`;
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1,$2,$3,$4,sha256($5::bytea),'recommendation','consideration',false,'active')`,
      [id, workspaceId, projectId, unique, Buffer.from(unique)],
    );
    prompts.push(id);
    return id;
  }

  async function addRun(planned: number, over: { trigger?: string; skipped?: number } = {}): Promise<void> {
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells, skipped_cells)
       VALUES ($1,$2,$3,$4,ARRAY['gemini'],$5,$6)`,
      [runId, workspaceId, projectId, over.trigger ?? "manual", planned, over.skipped ?? 0],
    );
  }

  /** The run was charged up front, exactly as the guard and interceptor leave it. */
  async function chargeRun(): Promise<void> {
    await db.query("BEGIN");
    await provisionWalletWithGrant(db, workspaceId, 1_000, { start: "2026-09-01", end: "2026-10-01" });
    const reserved = await reserveCredits(db, workspaceId, CHARGE);
    await appendLedgerEntry(db, { workspaceId, entryType: "reserve", actionCode: "manual_scan", credits: CHARGE, idempotencyKey: "deep", attempt: 1, after: reserved.wallet!, actorId: userId, actorType: "user" });
    const committed = await commitCredits(db, workspaceId, CHARGE, CHARGE);
    await appendLedgerEntry(db, { workspaceId, entryType: "commit", actionCode: "manual_scan", credits: CHARGE, idempotencyKey: "deep", attempt: 1, after: committed!, actorId: userId, actorType: "user", referenceType: "run", referenceId: runId });
    await db.query("COMMIT");
  }

  async function seedSettled(promptId: string, status: "parsed" | "skipped"): Promise<void> {
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version,
          normalizer_version, content_hash, flags, cache_layer, status, sample_index)
       VALUES ($1,$2,$3,$4,$5,'gemini',now(),'api','1.0.0','n1',$6,'{}',$7,$8,0)`,
      [randomUUID(), workspaceId, projectId, runId, promptId, createHash("sha256").update(randomUUID()).digest(), status === "skipped" ? "l1" : "live", status],
    );
  }

  function job(promptId: string, text: string, attempt: { made: number; of: number }): Job {
    return {
      attemptsMade: attempt.made,
      opts: { attempts: attempt.of },
      data: {
        payload: { workspaceId, kid: "k", projectId, runId, promptId, promptText: text, engineKey: "gemini", sampleIndex: 0, adapterVersion: "1.0.0", ttlSeconds: 3600, locale: "en-US", personaHint: null },
      },
    } as unknown as Job;
  }

  const FINAL = { made: 4, of: 5 };

  function execute(j: Job): Promise<void> {
    const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
    const handler = createCaptureExecuteHandler(context, {
      cache: new InMemoryCacheAdapter(),
      realtime: publisher(emitted),
      enqueueParse: () => Promise.resolve(),
      // No spend meter is wanted here (and building the real one would dial a Valkey).
      spendMeter: { isCeilingReached: () => Promise.resolve(false), recordCost: () => Promise.resolve({ newAlerts: [], totalUsd: 0, ceilingUsd: 100, hardStopped: false }) } as unknown as SpendMeter,
      enqueueRollup: (queue, _ws, payload, idempotencyKey) => {
        rollups.push({ queue, payload, idempotencyKey });
        return Promise.resolve();
      },
    });
    return withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      await handler(tx, j);
    });
  }

  const runRow = async () =>
    (await db.query<{ status: string; finished_at: Date | null }>("SELECT status, finished_at FROM capture_runs WHERE id = $1", [runId])).rows[0]!;
  const rows = async () =>
    (await db.query<{ status: string; error_code: string | null }>("SELECT status, error_code FROM answer_captures WHERE run_id = $1 ORDER BY status", [runId])).rows;
  const refunds = async () =>
    (await db.query<{ credits: string }>("SELECT credits::text FROM credit_ledger WHERE entry_type = 'refund' AND reference_id = $1", [runId])).rows.map((r) => Number(r.credits));

  it("SCANFIX-D1a · the FINAL attempt of a rate-limited cell writes a failed row carrying the engine's code, and does not throw", async () => {
    await addRun(1);
    const p = await addPrompt("boom");
    await expect(execute(job(p, "boom", FINAL))).resolves.toBeUndefined();
    expect(await rows()).toEqual([{ status: "failed", error_code: "rate_limited" }]);
  });

  it("SCANFIX-D1b · an attempt that is NOT the last still throws into the retry ladder and writes nothing", async () => {
    await addRun(1);
    const p = await addPrompt("boom");
    await expect(execute(job(p, "boom", { made: 3, of: 5 }))).rejects.toBeInstanceOf(CaptureFailureError);
    expect(await rows()).toEqual([]);
    expect((await runRow()).status).toBe("queued"); // the attempt rolled back whole
  });

  it("SCANFIX-D1c · an unclassified transport error on the final attempt is recorded too, as retries_exhausted", async () => {
    await addRun(1);
    const p = await addPrompt("plain");
    await expect(execute(job(p, "plain", FINAL))).resolves.toBeUndefined();
    expect(await rows()).toEqual([{ status: "failed", error_code: "retries_exhausted" }]);
  });

  it("SCANFIX-D1d · a run whose every cell exhausts its retries finishes as failed, with a finish time and run.failed emitted", async () => {
    await addRun(2);
    const a = await addPrompt("boom");
    const b = await addPrompt("boom");
    await execute(job(a, "boom", FINAL));
    expect((await runRow()).status).toBe("running");
    await execute(job(b, "boom", FINAL));

    const run = await runRow();
    expect(run.status).toBe("failed");
    expect(run.finished_at).not.toBeNull();
    expect(emitted.filter((e) => e.event === "run.failed")).toHaveLength(1);
    expect(emitted.filter((e) => e.event === "run.completed")).toHaveLength(1);
  });

  it("SCANFIX-D2a · a run that captured nothing is refunded in FULL, to the bucket it was taken from, and the wallet replays clean", async () => {
    await addRun(2);
    await chargeRun();
    const a = await addPrompt("boom");
    const b = await addPrompt("boom");
    await execute(job(a, "boom", FINAL));
    await execute(job(b, "boom", FINAL));

    expect(await refunds()).toEqual([CHARGE]);
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 1_000, purchasedBalance: 0, reserved: 0 });
    expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
  });

  it("SCANFIX-D2b · the refund is idempotent: a redelivered final job, or a second finalisation, refunds once", async () => {
    await addRun(1);
    await chargeRun();
    const a = await addPrompt("boom");
    await execute(job(a, "boom", FINAL));
    await execute(job(a, "boom", FINAL));

    expect(await refunds()).toEqual([CHARGE]);
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 1_000 });
  });

  it("SCANFIX-D2c · a MIXED run finishes as partial, is charged in full (reference: flat price, no per-cell refund) and requests the rollup once", async () => {
    await addRun(2);
    await chargeRun();
    const ok = await addPrompt("fine");
    const bad = await addPrompt("boom");
    await seedSettled(ok, "parsed");
    await execute(job(bad, "boom", FINAL));

    expect((await runRow()).status).toBe("partial");
    expect(await refunds()).toEqual([]);
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 1_000 - CHARGE });
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({ queue: "rollup.metric_daily", idempotencyKey: `rollup:${projectId}:run:${runId}` });
  });

  it("SCANFIX-D2d · a cache-served cell is a delivered answer: failed + skipped is partial and is NOT refunded", async () => {
    await addRun(2, { skipped: 1 });
    await chargeRun();
    const cached = await addPrompt("fine");
    const bad = await addPrompt("boom");
    await seedSettled(cached, "skipped");
    await execute(job(bad, "boom", FINAL));

    expect((await runRow()).status).toBe("partial");
    expect(await refunds()).toEqual([]);
  });

  it("SCANFIX-D2e · a scheduled run (inside the subscription, never debited) finishes failed without trying to refund anything", async () => {
    await addRun(1, { trigger: "scheduled" });
    await db.query("BEGIN");
    await provisionWalletWithGrant(db, workspaceId, 1_000, { start: "2026-09-01", end: "2026-10-01" });
    await db.query("COMMIT");
    const a = await addPrompt("boom");
    await execute(job(a, "boom", FINAL));

    expect((await runRow()).status).toBe("failed");
    expect(await refunds()).toEqual([]);
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 1_000 });
  });

  it("SCANFIX-D2f · a refund the user already took through undo is not repeated by the failure refund", async () => {
    await addRun(1);
    await chargeRun();
    const { refundCredits } = await import("../../src/lib/credits/balance.js");
    await db.query("BEGIN");
    await refundCredits(db, { workspaceId, idempotencyKey: "deep:included", actorId: userId, actorType: "user", referenceType: "run", referenceId: runId }, "included", CHARGE);
    await db.query("COMMIT");
    const a = await addPrompt("boom");
    await execute(job(a, "boom", FINAL));

    expect(await refunds()).toEqual([CHARGE]);
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 1_000 });
  });
});
