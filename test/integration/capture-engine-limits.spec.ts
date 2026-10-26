import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Redis } from "ioredis";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import type { RealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { sweepEngineSkipRefunds } from "../../src/lib/capture/engine-skip-refund-sweep.js";
import { ENGINE_SPEND_CEILING_REACHED } from "../../src/lib/capture/execute-cell.js";
import { provisionWalletWithGrant } from "../../src/lib/credits/balance.js";
import { settleEngineSkippedCells } from "../../src/lib/credits/engine-skip-refund.js";
import { appendLedgerEntry } from "../../src/lib/credits/ledger.js";
import { verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
import { commitCredits, readWallet, reserveCredits } from "../../src/lib/credits/wallet.js";
import {
  BreakerCaptureEngineGate,
  ENGINE_BREAKER_REQUEUE_DELAY_MS,
  ENGINE_SKIP_DEGRADED,
  ENGINE_SKIP_QUOTA_EXHAUSTED,
  EngineRedelayError,
} from "../../src/lib/engines/capture-engine-gate.js";
import { ENGINE_BREAKER_OPEN_DURATION_MS } from "../../src/lib/engines/engine-breaker.js";
import { EngineBreakerRegistry } from "../../src/lib/engines/engine-breaker-registry.js";
import { RefillReductionTracker, ValkeyRefillReductionStore } from "../../src/lib/engines/refill-reduction.js";
import type { SpendMeter } from "../../src/lib/engines/spend-meter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { createCaptureExecuteHandler } from "../../src/lib/queue/handlers/capture-execute.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { EngineHealthService } from "../../src/modules/health/engine-health.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { testCacheRedisUrl } from "../support/test-valkey.js";

// STORY-031 — the built limits WIRED INTO THE LIVE CAPTURE PATH, driven through the real `capture.execute` handler, the real
// breaker on a throwaway Valkey, the real `engine_health` writer and the real credit ledger. The registry is the only seam: an
// adapter that answers, or fails the way a vendor does, by prompt text.
//
//   AC3  / scenario 3  a ratio-opened breaker re-queues the cell with EC-06's 20-minute delay; no vendor call, no row
//   AC8  / scenario 5  quota_exhausted opens the breaker with no retry; the remaining cells are skipped for the next window
//   AC7  / scenario 4  open > 30 min: the cell is skipped as engine_degraded, the run completes partial, engine.degraded emitted
//   AC10 / scenario 6  one engine's breaker open, the other keeps capturing
//   AC4                customer attempts land in engine_health
//   AC9  / scenario 9  at the spend hard stop every tenant keeps exactly its priority subset
//   OWNER DECISION 2026-10-26 (10): a paid deep scan refunds the cells its engines' quota or outage skipped — a compensating
//   ledger entry, idempotent under redelivery and concurrency, audited, for skipped cells only.

const vendorCalls: { engineKey: string; text: string }[] = [];

vi.mock("../../src/lib/engines/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/engines/registry.js")>();
  const { CaptureFailureError: Failure } = await import("../../src/lib/engines/failure-taxonomy.js");
  return {
    ...actual,
    resolveEngine: (engineKey: string) => ({
      engineKey,
      captureMode: "api",
      adapterVersion: "1.0.0",
      supportsCitations: true,
      concurrencyPerTask: 1,
      healthProbe: () => Promise.resolve({ ok: true, latencyMs: 1 }),
      capture: (input: { promptText: string }) => {
        vendorCalls.push({ engineKey, text: input.promptText });
        if (input.promptText === "quota") return Promise.reject(new Failure("quota_exhausted", engineKey as never));
        if (input.promptText === "walled") return Promise.reject(new Failure("blocked", engineKey as never));
        if (input.promptText === "slow") return Promise.reject(new Failure("rate_limited", engineKey as never));
        return Promise.resolve({ text: "answer", format: "markdown", truncated: false, responseTokensEst: 1, latencyMs: 420, costUsd: 0 });
      },
    }),
  };
});

const CHARGE = 500;
const T0 = Date.UTC(2026, 9, 26, 9, 0, 0);

describe("STORY-031 · engine limits in the live capture path", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let redis: Redis;
  let clock: { now: number };
  let emitted: { workspaceId: string; event: string; payload: Record<string, unknown> }[];
  let ceiling: boolean;
  let workspaceId: string;
  let projectId: string;
  let runId: string;
  let userId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    redis = new Redis(testCacheRedisUrl());
  }, 300_000);

  afterAll(async () => {
    await redis.quit().catch(() => undefined);
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await redis.flushdb();
    await db.query("TRUNCATE answer_captures, tracked_prompts, capture_runs, projects, credit_ledger, credit_wallets, audit_log, engine_health, workspaces, users CASCADE");
    vendorCalls.length = 0;
    emitted = [];
    ceiling = false;
    clock = { now: T0 };
    userId = (await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${randomUUID().slice(0, 8)}@nominara.test`])).rows[0]!.id;
    ({ workspaceId, projectId } = await addWorkspace());
    runId = uuidV7();
  });

  async function addWorkspace(): Promise<{ workspaceId: string; projectId: string }> {
    const ws = randomUUID();
    const project = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth','UTC')", [ws, `w-${randomUUID().slice(0, 8)}`]);
    await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://e.test','e.test')", [project, ws, `p-${randomUUID().slice(0, 8)}`]);
    return { workspaceId: ws, projectId: project };
  }

  async function addPrompt(text: string, over: { ws?: string; project?: string; priority?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    const unique = `${text} ${id}`;
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1,$2,$3,$4,sha256($5::bytea),'recommendation','consideration',$6,'active')`,
      [id, over.ws ?? workspaceId, over.project ?? projectId, unique, Buffer.from(unique), over.priority ?? false],
    );
    return id;
  }

  async function addRun(planned: number, over: { trigger?: string; ws?: string; project?: string; run?: string } = {}): Promise<void> {
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells, skipped_cells)
       VALUES ($1,$2,$3,$4,ARRAY['gemini','chatgpt'],$5,0)`,
      [over.run ?? runId, over.ws ?? workspaceId, over.project ?? projectId, over.trigger ?? "manual", planned],
    );
  }

  async function chargeRun(): Promise<void> {
    await db.query("BEGIN");
    await provisionWalletWithGrant(db, workspaceId, 1_000, { start: "2026-10-01", end: "2026-11-01" });
    const reserved = await reserveCredits(db, workspaceId, CHARGE);
    await appendLedgerEntry(db, { workspaceId, entryType: "reserve", actionCode: "manual_scan", credits: CHARGE, idempotencyKey: "deep", attempt: 1, after: reserved.wallet!, actorId: userId, actorType: "user" });
    const committed = await commitCredits(db, workspaceId, CHARGE, CHARGE);
    await appendLedgerEntry(db, { workspaceId, entryType: "commit", actionCode: "manual_scan", credits: CHARGE, idempotencyKey: "deep", attempt: 1, after: committed!, actorId: userId, actorType: "user", referenceType: "run", referenceId: runId });
    await db.query("COMMIT");
  }

  async function seedParsed(promptId: string): Promise<void> {
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version,
          normalizer_version, content_hash, flags, cache_layer, status, sample_index)
       VALUES ($1,$2,$3,$4,$5,'gemini',now(),'api','1.0.0','n1',$6,'{}','live','parsed',0)`,
      [randomUUID(), workspaceId, projectId, runId, promptId, createHash("sha256").update(randomUUID()).digest()],
    );
  }

  function breakers(): EngineBreakerRegistry {
    return new EngineBreakerRegistry(redis, () => clock.now);
  }

  function job(promptId: string, text: string, over: { engineKey?: string; made?: number; ws?: string; project?: string; run?: string } = {}): Job {
    return {
      attemptsMade: over.made ?? 0,
      opts: { attempts: 5 },
      data: {
        payload: {
          workspaceId: over.ws ?? workspaceId,
          kid: "k",
          projectId: over.project ?? projectId,
          runId: over.run ?? runId,
          promptId,
          promptText: text,
          engineKey: over.engineKey ?? "gemini",
          sampleIndex: 0,
          adapterVersion: "1.0.0",
          ttlSeconds: 3600,
          locale: "en-US",
          personaHint: null,
        },
      },
    } as unknown as Job;
  }

  const realtime = (): RealtimePublisher => ({
    toWorkspace: (ws, event, payload) => {
      emitted.push({ workspaceId: ws, event, payload: payload as Record<string, unknown> });
    },
    toProject: (ws, _p, event, payload) => {
      emitted.push({ workspaceId: ws, event, payload: payload as Record<string, unknown> });
    },
    memberChanged: () => undefined,
  });

  const cache = new InMemoryCacheAdapter();

  function execute(j: Job, ws: string = workspaceId): Promise<void> {
    const handler = createCaptureExecuteHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext, {
      cache,
      realtime: realtime(),
      enqueueParse: () => Promise.resolve(),
      enqueueRollup: () => Promise.resolve(),
      spendMeter: { isCeilingReached: () => Promise.resolve(ceiling), recordCost: () => Promise.resolve({ newAlerts: [], totalUsd: 0, ceilingUsd: 100, hardStopped: false }) } as unknown as SpendMeter,
      engineGate: new BreakerCaptureEngineGate({
        breakers: breakers(),
        health: new EngineHealthService(db as unknown as Pool),
        refill: new RefillReductionTracker(new ValkeyRefillReductionStore(redis), () => clock.now),
        clock: () => clock.now,
      }),
    });
    return withTenantContext(db, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      await handler(tx, j);
    });
  }

  const rows = async (run: string = runId) =>
    (await db.query<{ engine_key: string; status: string; error_code: string | null }>("SELECT engine_key, status, error_code FROM answer_captures WHERE run_id = $1 ORDER BY status, engine_key", [run])).rows;
  const runStatus = async () => (await db.query<{ status: string }>("SELECT status FROM capture_runs WHERE id = $1", [runId])).rows[0]!.status;
  const refunds = async () =>
    (await db.query<{ credits: string; idempotency_key: string }>("SELECT credits::text, idempotency_key FROM credit_ledger WHERE entry_type = 'refund' AND reference_id = $1 ORDER BY seq", [runId])).rows;
  const refundedTotal = async () => (await refunds()).reduce((sum, r) => sum + Number(r.credits), 0);

  /** Opens gemini's breaker on quota exhaustion (EC-08), as a vendor would. */
  const openOnQuota = () => breakers().for("gemini").recordOutcome("quota_exhausted");
  /** Opens gemini's breaker on the block ratio (EC-06 stage 4). */
  const openOnRatio = () => breakers().for("gemini").recordOutcome("blocked");

  describe("AC3 · scenario 3 — a ratio-opened breaker re-queues the cell with a delay", () => {
    it("throws EngineRedelayError carrying EC-06's 20-minute delay, calls no vendor and writes no row", async () => {
      await addRun(1);
      await openOnRatio();
      const p = await addPrompt("fine");
      const error = await execute(job(p, "fine")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EngineRedelayError);
      expect((error as EngineRedelayError).delayMs).toBe(ENGINE_BREAKER_REQUEUE_DELAY_MS);
      expect(vendorCalls).toEqual([]);
      expect(await rows()).toEqual([]);
    });

    it("re-queues on the FINAL attempt too: an open breaker is never recorded as an exhausted failure", async () => {
      await addRun(1);
      await openOnRatio();
      const p = await addPrompt("fine");
      await expect(execute(job(p, "fine", { made: 4 }))).rejects.toBeInstanceOf(EngineRedelayError);
      expect(await rows()).toEqual([]);
    });

    it("once the breaker half-opens, the re-queued cell is the probe: it captures and closes the breaker", async () => {
      await addRun(1);
      await openOnRatio();
      clock.now += ENGINE_BREAKER_OPEN_DURATION_MS + 1;
      const p = await addPrompt("fine");
      await execute(job(p, "fine"));
      expect(await rows()).toEqual([{ engine_key: "gemini", status: "captured", error_code: null }]);
      expect((await breakers().for("gemini").detail()).state).toBe("closed");
    });
  });

  describe("AC8 · scenario 5 — quota exhaustion opens the circuit immediately, with no retry", () => {
    it("the cell that hit the quota is a terminal failed row (no throw, no retry) and the breaker is open on quota", async () => {
      await addRun(2);
      const p = await addPrompt("quota");
      await expect(execute(job(p, "quota"))).resolves.toBeUndefined();
      expect(await rows()).toEqual([{ engine_key: "gemini", status: "failed", error_code: "quota_exhausted" }]);
      expect(await breakers().for("gemini").detail()).toMatchObject({ state: "open", reason: "quota" });
    });

    it("the remaining cells are skipped for the next window — blocked quota_exhausted, never sent to the vendor — and the run completes partial", async () => {
      await addRun(3);
      const ok = await addPrompt("fine");
      await seedParsed(ok);
      const hit = await addPrompt("quota");
      const rest = await addPrompt("fine");
      await execute(job(hit, "quota"));
      await execute(job(rest, "fine"));
      expect(vendorCalls).toHaveLength(1);
      expect(await rows()).toEqual([
        { engine_key: "gemini", status: "blocked", error_code: ENGINE_SKIP_QUOTA_EXHAUSTED },
        { engine_key: "gemini", status: "failed", error_code: "quota_exhausted" },
        { engine_key: "gemini", status: "parsed", error_code: null },
      ]);
      expect(await runStatus()).toBe("partial");
    });
  });

  describe("AC7 · scenario 4 — held open past 30 minutes: degraded, event emitted, run completes partial", () => {
    async function holdOpenPastThirtyMinutes(): Promise<void> {
      await openOnRatio(); // T0: the episode starts
      clock.now += ENGINE_BREAKER_OPEN_DURATION_MS + 1; // half-open
      await breakers().for("gemini").recordOutcome("other_failure"); // the probe fails: re-opened, same episode
      clock.now = T0 + 31 * 60 * 1000;
    }

    it("skips the cell as engine_degraded, finishes the run as partial and emits engine.degraded with the episode start", async () => {
      await addRun(2);
      const ok = await addPrompt("fine");
      await seedParsed(ok);
      await holdOpenPastThirtyMinutes();
      const p = await addPrompt("fine");
      await execute(job(p, "fine"));
      expect(vendorCalls).toEqual([]);
      expect(await rows()).toContainEqual({ engine_key: "gemini", status: "blocked", error_code: ENGINE_SKIP_DEGRADED });
      expect(await runStatus()).toBe("partial");
      const events = emitted.filter((e) => e.event === "engine.degraded");
      expect(events).toEqual([
        { workspaceId, event: "engine.degraded", payload: { engine_key: "gemini", circuit_state: "open", since: new Date(T0).toISOString(), affected_projects: 1 } },
      ]);
    });

    it("engine.degraded is coalesced: two skipped cells in the same minute emit once", async () => {
      await addRun(3);
      await holdOpenPastThirtyMinutes();
      await execute(job(await addPrompt("fine"), "fine"));
      await execute(job(await addPrompt("fine"), "fine"));
      expect(emitted.filter((e) => e.event === "engine.degraded")).toHaveLength(1);
    });
  });

  describe("AC10 · scenario 6 — one engine's breaker open, the other keeps capturing", () => {
    it("gemini open on quota: its cell is skipped while chatgpt's cell in the same run captures", async () => {
      await addRun(2);
      await openOnQuota();
      await execute(job(await addPrompt("fine"), "fine", { engineKey: "gemini" }));
      await execute(job(await addPrompt("fine"), "fine", { engineKey: "chatgpt" }));
      expect(await rows()).toEqual([
        { engine_key: "gemini", status: "blocked", error_code: ENGINE_SKIP_QUOTA_EXHAUSTED },
        { engine_key: "chatgpt", status: "captured", error_code: null },
      ]);
      expect(vendorCalls.map((c) => c.engineKey)).toEqual(["chatgpt"]);
    });
  });

  describe("AC4 · customer attempts feed engine_health and the breaker", () => {
    it("a capture records an attempt and a success with its latency; a block records a block and opens the breaker on the ratio", async () => {
      await addRun(2);
      await execute(job(await addPrompt("fine"), "fine"));
      await execute(job(await addPrompt("walled"), "walled", { engineKey: "chatgpt" }));
      const health = (
        await db.query<{ engine_key: string; attempts: number; successes: number; blocks: number; p50_latency_ms: number | null }>(
          "SELECT engine_key, attempts, successes, blocks, p50_latency_ms FROM engine_health ORDER BY engine_key",
        )
      ).rows;
      expect(health).toEqual([
        { engine_key: "chatgpt", attempts: 1, successes: 0, blocks: 1, p50_latency_ms: null },
        { engine_key: "gemini", attempts: 1, successes: 1, blocks: 0, p50_latency_ms: 420 },
      ]);
      expect((await breakers().for("chatgpt").detail()).state).toBe("open");
      expect((await breakers().for("gemini").detail()).state).toBe("closed");
    });
  });

  describe("AC9 · scenario 9 — the spend hard stop degrades to the priority subset in every tenant", () => {
    it("each of two workspaces keeps its priority cell and loses its non-priority cell; neither is starved for the other", async () => {
      ceiling = true;
      const other = await addWorkspace();
      const otherRun = uuidV7();
      await addRun(2);
      await addRun(2, { ws: other.workspaceId, project: other.projectId, run: otherRun });
      for (const [ws, project, run] of [
        [workspaceId, projectId, runId],
        [other.workspaceId, other.projectId, otherRun],
      ] as const) {
        const priority = await addPrompt("fine", { ws, project, priority: true });
        const plain = await addPrompt("fine", { ws, project, priority: false });
        await execute(job(priority, "fine", { ws, project, run }), ws);
        await execute(job(plain, "fine", { ws, project, run, engineKey: "chatgpt" }), ws);
        expect(await rows(run)).toEqual([
          { engine_key: "chatgpt", status: "blocked", error_code: ENGINE_SPEND_CEILING_REACHED },
          { engine_key: "gemini", status: "captured", error_code: null },
        ]);
      }
    });
  });

  describe("OWNER DECISION 10 · a paid deep scan refunds the cells its engines' quota or outage skipped", () => {
    /** 4 planned: 2 delivered, 2 skipped by gemini's quota-open breaker. */
    async function partialScanWithTwoSkipped(): Promise<void> {
      await addRun(4);
      await chargeRun();
      await seedParsed(await addPrompt("fine"));
      await seedParsed(await addPrompt("fine"));
      await openOnQuota();
      await execute(job(await addPrompt("fine"), "fine"));
      await execute(job(await addPrompt("fine"), "fine"));
      expect(await runStatus()).toBe("partial");
    }

    it("refunds the skipped share of the flat price (500 x 2/4 = 250) to the bucket it came from, audited, and the wallet replays clean", async () => {
      await partialScanWithTwoSkipped();
      expect(await refundedTotal()).toBe(0); // the run settles first: a partial run is charged in full at finalisation
      await sweepEngineSkipRefunds(db, new Date());
      expect(await refundedTotal()).toBe(250);
      expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 750, purchasedBalance: 0, reserved: 0 });
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
      const audit = (await db.query<{ action: string; resource_id: string; actor_type: string }>("SELECT action, resource_id, actor_type FROM audit_log WHERE workspace_id = $1", [workspaceId])).rows;
      expect(audit).toEqual([{ action: "billing.run_refunded_engine_unavailable", resource_id: runId, actor_type: "system" }]);
    });

    it("is idempotent under redelivery: a second sweep and a direct re-settle refund nothing more", async () => {
      await partialScanWithTwoSkipped();
      await sweepEngineSkipRefunds(db, new Date());
      await sweepEngineSkipRefunds(db, new Date());
      await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => settleEngineSkippedCells(tx, { workspaceId, runId }));
      expect(await refundedTotal()).toBe(250);
      expect((await db.query("SELECT 1 FROM audit_log WHERE workspace_id = $1", [workspaceId])).rowCount).toBe(1);
    });

    it("is idempotent under concurrency: two settlers racing on two connections refund once", async () => {
      await partialScanWithTwoSkipped();
      const a = new Client({ connectionString: container.getConnectionUri() });
      const b = new Client({ connectionString: container.getConnectionUri() });
      await Promise.all([a.connect(), b.connect()]);
      try {
        const settle = (c: Client) => withTenantContext(c, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => settleEngineSkippedCells(tx, { workspaceId, runId }));
        const outcomes = await Promise.all([settle(a), settle(b)]);
        expect(outcomes.map((o) => o.refunded).sort()).toEqual([0, 250]);
      } finally {
        await Promise.all([a.end(), b.end()]);
      }
      expect(await refundedTotal()).toBe(250);
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    });

    it("refunds ONLY skipped cells: a cell that reached the vendor and failed (quota hit, rate limited) is not refunded", async () => {
      await addRun(3);
      await chargeRun();
      await seedParsed(await addPrompt("fine"));
      await execute(job(await addPrompt("quota"), "quota"));
      await execute(job(await addPrompt("slow"), "slow", { engineKey: "chatgpt", made: 4 }));
      expect(await runStatus()).toBe("partial");
      await sweepEngineSkipRefunds(db, new Date());
      expect(await refundedTotal()).toBe(0);
    });

    it("rounds the refund down, never up: 1 skipped of 3 planned on 500 refunds 166", async () => {
      await addRun(3);
      await chargeRun();
      await seedParsed(await addPrompt("fine"));
      await seedParsed(await addPrompt("fine"));
      await openOnQuota();
      await execute(job(await addPrompt("fine"), "fine"));
      await sweepEngineSkipRefunds(db, new Date());
      expect(await refundedTotal()).toBe(166);
    });

    it("a scheduled run (no charge) with skipped cells refunds nothing", async () => {
      await addRun(2, { trigger: "scheduled" });
      await seedParsed(await addPrompt("fine"));
      await openOnQuota();
      await execute(job(await addPrompt("fine"), "fine"));
      expect(await runStatus()).toBe("partial");
      await sweepEngineSkipRefunds(db, new Date());
      expect(await refunds()).toEqual([]);
    });

    it("a run that delivered nothing gets the full nothing-captured refund once, and the engine-skip refund adds nothing", async () => {
      await addRun(2);
      await chargeRun();
      await openOnQuota();
      await execute(job(await addPrompt("fine"), "fine"));
      await execute(job(await addPrompt("fine"), "fine"));
      expect(await runStatus()).toBe("failed");
      expect(await refundedTotal()).toBe(CHARGE);
      await sweepEngineSkipRefunds(db, new Date());
      expect(await refundedTotal()).toBe(CHARGE);
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    });
  });
});
