import { Logger } from "@nestjs/common";
import { nonMeasurementStatusSql } from "../../rollup/aggregate-day.js";
import type { Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { ClientBase } from "pg";
import { z } from "zod";
import type { Cache } from "../../cache/cache.port.js";
import { cacheKeyNamespace } from "../../cache/key-namespace.js";
import { ValkeyCacheAdapter } from "../../cache/valkey-cache.adapter.js";
import type { RealtimePublisher } from "../../cache/realtime-publisher.js";
import { ValkeyRealtimePublisher } from "../../cache/realtime-publisher.js";
import { resolveEngineSpendCeilings } from "../../../config/env.schema.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { engineKeySchema } from "../../engines/contract.js";
import { SpendMeter, ValkeySpendMeterStore } from "../../engines/spend-meter.js";
import { BreakerCaptureEngineGate, EngineRedelayError, type CaptureEngineGate, type EngineUnavailableSkipCode } from "../../engines/capture-engine-gate.js";
import { EngineBreakerRegistry } from "../../engines/engine-breaker-registry.js";
import { CaptureFailureError, captureFailureCodeSchema } from "../../engines/failure-taxonomy.js";
import { RefillReductionTracker, ValkeyRefillReductionStore } from "../../engines/refill-reduction.js";
import { EngineHealthService } from "../../../modules/health/engine-health.service.js";
import { rawObjectStores, type BoundRawObjects, type RawObjectStores } from "../../capture/raw-object-store.js";
import type { ObjectStoragePort } from "../../storage/storage.port.js";
import { commitCell, engineSkippedCell, fetchCell, recordExhaustedCell, settledCell, type CaptureCellInput, type CaptureCellOutcome, type CellFetched } from "../../capture/execute-cell.js";
import { finalizeRun } from "../../capture/finalize-run.js";
import { readRunProgress } from "../../capture/run-progress.js";
import { NORMALIZER_VERSION } from "../../parser/normalize.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../connection.js";
import { QueueProducer } from "../queue-producer.js";
import { PHASES_DONE, phasedProcessor, signingKeysFromEnv } from "../worker-factory.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";
import { requestRollupIfRunComplete, type EnqueueRollup } from "./run-rollup-request.js";

// STORY-034 — `capture.execute`, the handler STORY-124's registry named:
// "the capture queues with STORY-034".
//
// This is the piece that makes everything upstream of it real. The planner
// has produced cells since STORY-032; the trigger has enqueued them since the
// commit before this one; nothing consumed them, so every run sat at `queued`
// with a progress projection that could only ever report zero.

const payloadSchema = z
  .object({
    workspaceId: z.string().uuid(),
    kid: z.string(),
    projectId: z.string().uuid(),
    runId: z.string().uuid(),
    promptId: z.string().uuid(),
    promptText: z.string().min(1),
    engineKey: z.string().min(1),
    sampleIndex: z.number().int().min(0),
    adapterVersion: z.string().min(1),
    ttlSeconds: z.number().int().positive(),
    locale: z.string().min(1),
    personaHint: z.string().nullable(),
  })
  .strict();

/** §11: `run.progress` is coalesced at ≤ 1 / 750 ms / run. */
const PROGRESS_COALESCE_MS = 750;

export interface CaptureExecuteDeps {
  readonly cache: Cache;
  readonly realtime: RealtimePublisher;
  /** Injected in tests; production builds a producer from env on first use. */
  readonly enqueueParse?: (payload: ParseJobPayload) => Promise<unknown>;
  /** Injected in tests; production builds a producer from env on first use. */
  readonly enqueueRollup?: EnqueueRollup;
  /** Injected in tests; production builds the Valkey-backed meter from env on first use. */
  readonly spendMeter?: SpendMeter;
  /** STORY-181 - the object-storage port the raw capture objects are written through (S3 from env when absent). Injectable so a test sees a real key or a failing upload. */
  readonly storagePort?: ObjectStoragePort;
  /** STORY-031 - the engine breaker + health telemetry the cell is admitted by and reported to. Production builds it on first use. */
  readonly engineGate?: CaptureEngineGate;
}

/** What `capture.parse` needs to find and re-read the row this handler wrote. */
export interface ParseJobPayload {
  readonly workspaceId: string;
  readonly resultId: string;
  readonly projectId: string;
  readonly promptId: string;
  readonly engineKey: string;
  readonly capturedAt: string;
}

/**
 * The platform spend meter, on the QUEUE instance (QUEUE_REDIS_URL: noeviction, AOF on) and NEVER the
 * cache instance (allkeys-lru, no persistence): an absent total reads as 0 spent, so an LRU eviction or a
 * cache restart would reopen a closed gate. usage_ledger cannot reseed it (D12: it is RLS-forced and
 * workspace-scoped). Ceilings are the configured JSON over the defaults.
 */
export function buildSpendMeter(
  env: { readonly QUEUE_REDIS_URL: string; readonly ENGINE_SPEND_CEILINGS_USD?: string | undefined },
  onError: (message: string) => void = () => undefined,
): SpendMeter {
  const redis = new Redis(env.QUEUE_REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", (error) => onError(`spend meter connection error: ${error.message}`));
  return new SpendMeter(new ValkeySpendMeterStore(redis), resolveEngineSpendCeilings(env.ENGINE_SPEND_CEILINGS_USD));
}

/**
 * STORY-031 - the production engine gate: the shared breaker and the refill-reduction state on the CACHE instance (STORY-031 D6,
 * where the canary's breaker and the lease's bucket already live), and `engine_health` through the worker's pool (a global
 * table, no tenant context). The connection rejects rather than blocks, and every read fails open (D19).
 */
export function buildCaptureEngineGate(context: QueueHandlerContext, onError: (message: string) => void = () => undefined): CaptureEngineGate {
  const redis = new Redis(context.env.VALKEY_CACHE_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  redis.on("error", (error) => onError(`engine gate connection error: ${error.message}`));
  return new BreakerCaptureEngineGate({
    breakers: new EngineBreakerRegistry(redis),
    health: new EngineHealthService(context.pool),
    refill: new RefillReductionTracker(new ValkeyRefillReductionStore(redis)),
  });
}

/** §11: `engine.degraded` is coalesced at <= 1 / min / engine (here per workspace too: each workspace is its own audience). */
const ENGINE_DEGRADED_COALESCE_MS = 60_000;

/**
 * The in-flight claim's lifetime. It covers the longest vendor call (the Gemini adapter times out at 30 s) plus the object PUT and
 * the commit, and it is shorter than the retry ladder's reach (5 s, 15 s, 45 s, 120 s), so a delivery that lost the claim is retried
 * after the winner is done, or after a winner that died has let it lapse.
 */
export const CELL_CLAIM_TTL_MS = 90_000;

/** A second delivery of a cell whose first delivery is still running. Thrown so the retry ladder tries again once the first is done. */
export class CellInFlightError extends Error {
  constructor() {
    super("this cell is being captured by another delivery");
    this.name = "CellInFlightError";
  }
}

/** ADR-0003 - what `prepare` hands `run`: the verified payload, the cell, and whether an earlier delivery already settled it. */
interface ExecutePrepared {
  readonly payload: z.infer<typeof payloadSchema>;
  readonly runStartedAt: Date | null;
  readonly cellInput: CaptureCellInput;
  readonly settled: CaptureCellOutcome | undefined;
  /** Bound in `prepare`, inside the tenant context (it only reads the workspace id). Undefined: storage unconfigured outside production, or a settled cell. */
  readonly rawObjects: BoundRawObjects | undefined;
}

type ExecuteFetched =
  | { readonly kind: "settled" }
  /** STORY-031: the engine could not take the cell (breaker open on quota, or degraded). A row is written; the vendor was never called. */
  | { readonly kind: "engine_skipped"; readonly cell: CellFetched; readonly errorCode: EngineUnavailableSkipCode; readonly since: Date }
  | { readonly kind: "fetched"; readonly cell: CellFetched; readonly claim: { readonly key: string; readonly token: string } }
  | { readonly kind: "exhausted"; readonly error: unknown };

export function createCaptureExecuteHandler(context: QueueHandlerContext, deps?: CaptureExecuteDeps): JobProcessor {
  const logger = new Logger("capture.execute");

  // BUILT ON THE FIRST JOB, NOT AT REGISTRATION. `QUEUE_HANDLERS` is a static
  // table evaluated during boot for EVERY worker group, so constructing these
  // in the factory opened two Valkey connections in every process that merely
  // imported the registry — including the ones that never run a capture. The
  // worker boot test caught it by hanging.
  let cache: Cache | undefined = deps?.cache;
  let realtime: RealtimePublisher | undefined = deps?.realtime;
  let producer: QueueProducer | undefined;
  const connections = (): { cache: Cache; realtime: RealtimePublisher } => {
    cache ??= new ValkeyCacheAdapter(context.env.VALKEY_CACHE_URL);
    realtime ??= new ValkeyRealtimePublisher(context.env.VALKEY_CACHE_URL);
    return { cache, realtime };
  };

  // E2E-B6 — the platform spend meter (EC-08), built on first use. RECORDING fails open inside the
  // meter (the money is already spent); the PRE-CALL gate below fails closed on an unreadable or corrupt
  // total (an absent total is zero spent, which is why the meter must live where a key cannot vanish).
  let stores: RawObjectStores | undefined;
  const rawStores = (): RawObjectStores => (stores ??= rawObjectStores(context.env, deps?.storagePort));
  let spendMeter: SpendMeter | undefined = deps?.spendMeter;
  const meter = (): SpendMeter => (spendMeter ??= buildSpendMeter(context.env, (message) => logger.warn(message)));
  let engineGate: CaptureEngineGate | undefined = deps?.engineGate;
  const gate = (): CaptureEngineGate => (engineGate ??= buildCaptureEngineGate(context, (message) => logger.warn(message)));
  const ceilingReached = async (engineKey: string): Promise<boolean> => {
    const key = engineKeySchema.safeParse(engineKey);
    if (!key.success) return false;
    let reached: boolean;
    try {
      reached = await meter().isCeilingReached(key.data);
    } catch (error) {
      // FAIL CLOSED: the meter cannot say how much was spent (Valkey down, or a corrupt total), so the
      // vendor is not called. Rethrown into the retry ladder; the job is retried when the meter reads again.
      incrementCounter("nominara_capture_spend_gate_unreadable_total", { engine_key: key.data });
      logger.error(`engine spend gate unreadable for ${key.data}; vendor call blocked (failing closed): ${error instanceof Error ? error.message : "unknown error"}`);
      throw error;
    }
    if (reached) {
      incrementCounter("nominara_capture_spend_ceiling_blocked_total", { engine_key: key.data });
      logger.error(`engine spend ceiling reached for ${key.data}; cell blocked before the vendor call`);
    }
    return reached;
  };
  const recordSpend = async (engineKey: string, usd: number): Promise<void> => {
    const key = engineKeySchema.safeParse(engineKey);
    if (!key.success) return;
    const result = await meter().recordCost(key.data, usd);
    incrementCounter("nominara_capture_cost_recorded_total", { engine_key: key.data });
    for (const level of result.newAlerts) {
      logger.warn(`engine spend alert ${level} for ${key.data}: ${result.totalUsd.toFixed(2)} of ${String(result.ceilingUsd)} USD this month`);
    }
    if (result.hardStopped) {
      // Enforced by `ceilingReached` on the NEXT cell; this is the crossing itself.
      logger.error(`engine spend ceiling crossed for ${key.data}: ${result.totalUsd.toFixed(2)} of ${String(result.ceilingUsd)} USD this month`);
    }
  };

  // `async`, so that BUILDING the producer is inside the promise too.
  //
  // It was a plain arrow returning `enqueueTenantJob(...)`, and the
  // construction above it threw SYNCHRONOUSLY — past the caller's `.catch`
  // and out of the handler. An unreachable queue would then have failed the
  // whole capture and discarded an engine call already made and paid for,
  // which is the exact outcome the caller's comment says must not happen.
  // Found by the STORY-034 tests, which pass an env with no queue in it.
  const enqueueParse =
    deps?.enqueueParse ??
    (async (payload: ParseJobPayload): Promise<unknown> => {
      producer ??= new QueueProducer(
        createQueueWorkerConnection(context.env.QUEUE_REDIS_URL),
        queueKeyPrefix(context.env.NODE_ENV),
        signingKeysFromEnv(context.env),
      );
      return producer.enqueueTenantJob("capture.parse", payload.workspaceId, { ...payload }, {
        // One parse per capture. A replayed capture job re-parses the same
        // row rather than queueing a second pass over it.
        idempotencyKey: `parse:${payload.resultId}`,
      });
    });

  const enqueueRollup: EnqueueRollup =
    deps?.enqueueRollup ??
    (async (queue, workspaceId, rollupPayload, idempotencyKey): Promise<unknown> => {
      producer ??= new QueueProducer(
        createQueueWorkerConnection(context.env.QUEUE_REDIS_URL),
        queueKeyPrefix(context.env.NODE_ENV),
        signingKeysFromEnv(context.env),
      );
      return producer.enqueueTenantJob(queue, workspaceId, rollupPayload, { idempotencyKey });
    });

  const prepare = async (tx: ClientBase, job: Job): Promise<ExecutePrepared | typeof PHASES_DONE> => {
    const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);

    // THE RUN ROW IS THE TRUTH, not the payload. A job is a snapshot from
    // enqueue time, and between then and now the run may have been cancelled
    // — the cancel drains what is waiting, but a job already delivered to a
    // worker is not in the queue to drain. Checking here is what makes
    // "in-flight cells complete rather than being abandoned" mean the ones
    // that were genuinely mid-write, not every job the drain raced.
    //
    // `FOR KEY SHARE`, NOT A PLAIN SELECT (SCANFIX D5). A plain read locks nothing: the stuck-run reaper's `FOR UPDATE` did not wait
    // for a cell still being written, so it counted that cell as lost, finalised the run `failed`, refunded the full charge and
    // committed - and the cell then committed a captured answer on a refunded run. KEY SHARE is the weakest lock the reaper's
    // FOR UPDATE conflicts with. It no longer spans the vendor call (ADR-0003: this job is phased, a transaction cannot span it);
    // `commit` re-reads the run under the same lock, which is where a cell is now refused on a run the reaper already finalised.
    // A cell arriving while the reaper holds the run waits here, then reads the terminal status below.
    const run = await tx.query<{ status: string; planned_cells: number; started_at: Date | null }>(
      "SELECT status, planned_cells, started_at FROM capture_runs WHERE id = $1 FOR KEY SHARE",
      [payload.runId],
    );
    const runRow = run.rows[0];
    if (runRow === undefined) {
      // Deleted, or in another tenant and invisible to RLS. Nothing to
      // capture and nothing wrong - throwing would send the job down the
      // retry ladder for a run that no longer exists.
      logger.log(`run ${payload.runId} is gone; skipping cell`);
      return PHASES_DONE;
    }
    // ANY TERMINAL RUN SKIPS THE CELL, not only canceled/failed. A late or replayed cell (admin DLQ replay,
    // a redelivery) on a run the reaper or the last live cell already finalised would otherwise call the
    // vendor - paid, and it spends a pacing token - and count a cell the run already accounted for.
    // `failed` is also the case capture.plan creates when a dispatch REJECTED yet the addBulk may have
    // landed: the fair-use reservation was released with it, and a late cell would capture under a run
    // that holds none (checkpoint-4).
    if (runRow.status !== "queued" && runRow.status !== "running") {
      incrementCounter("nominara_capture_cells_skipped_terminal_run_total", { status: runRow.status });
      logger.log({ event: "capture.cell.skipped_terminal_run", workspace_id: payload.workspaceId, run_id: payload.runId, status: runRow.status });
      return PHASES_DONE;
    }

    // First cell to arrive moves the run to `running` and stamps the clock the
    // ETA is extrapolated from. The predicate makes it idempotent: whichever
    // of N concurrent cells wins sets it once, and the rest update no rows.
    await tx.query(
      "UPDATE capture_runs SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1 AND status = 'queued'",
      [payload.runId],
    );

    const cellInput: CaptureCellInput = {
      workspaceId: payload.workspaceId,
      projectId: payload.projectId,
      runId: payload.runId,
      promptId: payload.promptId,
      promptText: payload.promptText,
      engineKey: payload.engineKey,
      sampleIndex: payload.sampleIndex,
      adapterVersion: payload.adapterVersion,
      ttlSeconds: payload.ttlSeconds,
      locale: payload.locale,
      personaHint: payload.personaHint,
      normalizerVersion: NORMALIZER_VERSION,
    };
    // IDEMPOTENT PER CELL, BEFORE ANY VENDOR CALL: a cell an earlier delivery settled is replayed, not captured again.
    const settled = await settledCell(tx, cellInput);
    // STORY-031 AC9 - the priority flag the spend hard stop reads, from the prompt row (RLS-scoped; the signed payload is unchanged).
    const isPriority =
      settled === undefined &&
      (await tx.query<{ is_priority: boolean }>("SELECT is_priority FROM tracked_prompts WHERE id = $1", [payload.promptId])).rows[0]?.is_priority === true;
    // STORY-181: bound HERE, inside the job's tenant context (it only reads the workspace id; no I/O), so the raw object lands in this
    // workspace's prefix and nowhere else. Not bound for a settled cell: a replay stores nothing.
    const rawObjects = settled === undefined ? rawStores().bindForWrite() : undefined;
    return { payload, runStartedAt: runRow.started_at, cellInput: isPriority ? { ...cellInput, isPriority } : cellInput, settled, rawObjects };
  };

  // ADR-0003 RUN: NO transaction and NO pooled client. The vendor call, the spend meter and the raw-object PUT happen here.
  const run = async (prepared: ExecutePrepared, job: Job): Promise<ExecuteFetched> => {
    if (prepared.settled !== undefined) return { kind: "settled" };
    const { cache: liveCache } = connections();
    const { cellInput, payload } = prepared;
    const engineKey = engineKeySchema.safeParse(payload.engineKey);

    // STORY-031 AC3/AC7/AC8 - THE BREAKER IS ASKED BEFORE ANY VENDOR CALL (capture-engine-gate.ts says what each answer means).
    // Outside the try below on purpose: a re-delay is not a failed attempt, so it must never become the final attempt's
    // exhausted record. An engine key the registry does not know is left to `fetchCell`, which records it `blocked`.
    if (engineKey.success) {
      const admission = await gate().admit(engineKey.data);
      if (admission.kind === "redelay") throw new EngineRedelayError(engineKey.data, admission.delayMs);
      if (admission.kind === "skip") return { kind: "engine_skipped", cell: engineSkippedCell(admission.errorCode), errorCode: admission.errorCode, since: admission.since };
    }

    // THE IN-FLIGHT CLAIM. The cell's advisory lock used to span the vendor call, so two deliveries of one cell (a stalled-job
    // redelivery, an admin replay) paid once. A transaction can no longer span the call, so the same guarantee is a short-lived claim
    // on the cache: the loser throws CellInFlightError (retried later, by which time the winner's row exists) instead of paying twice.
    // `onlyIfAbsent` is the whole mechanism; an unreachable cache throws too (fail closed: the alternative is a double charge).
    const claim = {
      key: [cacheKeyNamespace(), "ws", payload.workspaceId, "capture-cell", payload.runId, payload.promptId, payload.engineKey, String(payload.sampleIndex)].join(":"),
      token: randomUUID(),
    };
    let claimed = false;
    try {
      claimed = await liveCache.set(claim.key, claim.token, { ttlMs: CELL_CLAIM_TTL_MS, onlyIfAbsent: true });
      if (!claimed) {
        incrementCounter("nominara_capture_cell_claim_lost_total", { engine_key: payload.engineKey });
        throw new CellInFlightError();
      }
      let cell: CellFetched;
      try {
        cell = await fetchCell(cellInput, { recordSpend, ceilingReached, ...(prepared.rawObjects !== undefined ? { rawObjects: prepared.rawObjects } : {}) });
      } catch (error) {
        // STORY-031 AC3/AC4 - a retryable vendor failure is an attempt too: the breaker and the health buckets hear of it before
        // the retry ladder does. A non-vendor error (storage, an unclassified fault) is not an engine outcome and is not recorded.
        if (engineKey.success && error instanceof CaptureFailureError) await gate().record(engineKey.data, { outcome: "failure", code: error.code });
        throw error;
      }
      // STORY-031 AC3/AC4/AC8 - every answered or terminally failed vendor call feeds the breaker (quota_exhausted opens it at once,
      // EC-08) and `engine_health`. A `blocked` cell never reached the vendor (disabled engine, spend ceiling) and is not an attempt.
      if (engineKey.success) {
        if (cell.outcome.kind === "captured") await gate().record(engineKey.data, { outcome: "success", latencyMs: cell.outcome.latencyMs });
        if (cell.outcome.kind === "failed") {
          const code = captureFailureCodeSchema.safeParse(cell.outcome.errorCode);
          if (code.success) await gate().record(engineKey.data, { outcome: "failure", code: code.data });
        }
      }
      return { kind: "fetched", cell, claim };
    } catch (error) {
      if (claimed) await liveCache.deleteIf(claim.key, claim.token).catch(() => undefined);
      // Another delivery owns the cell: never record it as exhausted, that would write a failed row over the winner's answer.
      if (error instanceof CellInFlightError) throw error;
      // SCANFIX D1 - THE LAST ATTEMPT RECORDS INSTEAD OF DYING. Until this, a cell whose retry ladder ran out threw its way into the
      // dead-letter queue and left NO row: `captured + failed + skipped` never reached `planned`, so the run sat at running/queued for
      // ever, the rollup was never requested and the customer saw no scores - even for the cells that had captured. Every attempt
      // before the last still throws (the ladder is untouched); the final one hands `commit` the terminal `failed` record to write.
      if (!isFinalAttempt(job)) throw error;
      return { kind: "exhausted", error };
    }
  };

  // ADR-0003 COMMIT: a second short transaction. It re-checks the run under FOR KEY SHARE, then writes the cell.
  const commit = async (tx: ClientBase, prepared: ExecutePrepared, fetched: ExecuteFetched): Promise<void> => {
    const { cache: liveCache, realtime: livePublisher } = connections();
    const { payload, cellInput } = prepared;
    let outcome: CaptureCellOutcome;
    if (fetched.kind === "settled") {
      outcome = prepared.settled!;
    } else {
      // THE RUN IS RE-READ UNDER `FOR KEY SHARE`, because the lock `prepare` took ended with its transaction (SCANFIX D5). The stuck-run
      // reaper's `FOR UPDATE` waits for this statement's transaction, and this statement waits for a reaper that already holds the run;
      // either way a cell can no longer commit a captured answer on a run the reaper refunded. A cell that arrives to find the run
      // terminal is dropped: the vendor was paid and metered, and nothing is written (the object, if any, is an orphan).
      const run = await tx.query<{ status: string }>("SELECT status FROM capture_runs WHERE id = $1 FOR KEY SHARE", [payload.runId]);
      const status = run.rows[0]?.status;
      if (status !== "queued" && status !== "running") {
        incrementCounter("nominara_capture_cells_skipped_terminal_run_total", { status: status ?? "gone" });
        logger.log({ event: "capture.cell.skipped_terminal_run", workspace_id: payload.workspaceId, run_id: payload.runId, status: status ?? "gone", phase: "commit" });
        return;
      }
      try {
        outcome = fetched.kind === "exhausted" ? await recordExhaustedCell(tx, cellInput, fetched.error) : await commitCell(tx, liveCache, cellInput, fetched.cell);
      } catch (error) {
        // The claim is released so this job's own retry is not locked out by its failed attempt.
        if (fetched.kind === "fetched") await liveCache.deleteIf(fetched.claim.key, fetched.claim.token).catch(() => undefined);
        // The terminal record itself could not be written (a database error aborted this transaction). Surface the ORIGINAL failure:
        // the job reaches the dead-letter queue as before and the stuck-run reaper accounts for the cell. Never swallow an error.
        throw fetched.kind === "exhausted" ? fetched.error : error;
      }
      if (fetched.kind === "exhausted") {
        incrementCounter("nominara_capture_cells_exhausted_total", {
          engine_key: payload.engineKey,
          error_code: outcome.kind === "captured" ? "replayed" : outcome.errorCode,
        });
        logger.warn({
          event: "capture.cell.retries_exhausted",
          workspace_id: payload.workspaceId,
          run_id: payload.runId,
          engine_key: payload.engineKey,
          error_code: outcome.kind === "captured" ? "replayed" : outcome.errorCode,
        });
      }
    }
    const runRow = { started_at: prepared.runStartedAt };

    // STORY-031 AC7/AC11 - THE ENGINE.DEGRADED EVENT, published to THIS workspace when one of its cells is skipped because the
    // engine is unavailable (§11: `{engine_key, circuit_state, since, affected_projects}`). Published here rather than by the ladder
    // evaluator because only here is the tenant known: `affected_projects` is this workspace's own unfinished runs on the engine,
    // counted under RLS. Coalesced across processes per workspace and engine (SET NX, like run.progress); an unreachable cache
    // emits. Fire-and-forget; the authoritative read is GET /engines/status.
    if (fetched.kind === "engine_skipped") {
      const won = await liveCache
        .set(`rt:engine-degraded:${payload.workspaceId}:${payload.engineKey}`, "1", { ttlMs: ENGINE_DEGRADED_COALESCE_MS, onlyIfAbsent: true })
        .catch(() => true);
      if (won) {
        const affected = await tx.query<{ n: string }>(
          "SELECT count(DISTINCT project_id)::text AS n FROM capture_runs WHERE status IN ('queued','running') AND $1 = ANY(engine_keys)",
          [payload.engineKey],
        );
        livePublisher.toWorkspace(payload.workspaceId, "engine.degraded", {
          engine_key: payload.engineKey,
          circuit_state: "open",
          since: fetched.since.toISOString(),
          affected_projects: Number(affected.rows[0]?.n ?? 0),
        });
      }
    }

    // E2E-B6a — `captured_cells` counts LIVE captures only (captures-and-facts.md).
    // An atomic increment, not a recount: concurrent cells each run in their own
    // transaction and cannot see each other's uncommitted rows. Suppressed cells
    // never reach this handler (they are written by the planner), and a cell
    // that ended blocked or failed is not a capture.
    // A replayed cell (already settled by an earlier delivery) is not counted twice.
    if (outcome.kind === "captured" && outcome.replayed !== true) {
      await tx.query("UPDATE capture_runs SET captured_cells = captured_cells + 1 WHERE id = $1", [payload.runId]);
    }

    // STORY-135 — hand the capture to the parser.
    //
    // ENQUEUED INSIDE THE JOB'S TRANSACTION, and that is a deliberate
    // exception rather than an oversight. `withTenantJob` has no
    // `afterCommit`, so there is nowhere else to put it — and unlike the run
    // trigger's dispatch, the failure mode here is benign and
    // self-correcting: if this transaction rolls back, the capture row does
    // not exist, and `capture.parse` reads it by id, finds nothing, logs and
    // returns. An orphaned parse job cancels itself. An orphaned CAPTURE job
    // would have captured against a run that never existed, which is why
    // that one waits for a commit and this one does not.
    if (outcome.kind === "captured") {
      const parseTarget = await tx.query<{ id: string; captured_at: Date }>(
        `SELECT id, captured_at FROM answer_captures
          WHERE run_id = $1 AND prompt_id = $2 AND engine_key = $3 AND sample_index = $4
          ORDER BY captured_at DESC LIMIT 1`,
        [payload.runId, payload.promptId, payload.engineKey, payload.sampleIndex],
      );
      const target = parseTarget.rows[0];
      if (target !== undefined) {
        await enqueueParse({
          workspaceId: payload.workspaceId,
          resultId: target.id,
          projectId: payload.projectId,
          promptId: payload.promptId,
          engineKey: payload.engineKey,
          capturedAt: target.captured_at.toISOString(),
        }).catch((error: unknown) => {
          // The ANSWER IS STORED. A parse that did not start is recoverable by
          // re-parsing; failing the capture here would discard an engine call
          // that has already been paid for and made.
          logger.error(`failed to enqueue parse for capture ${target.id}: ${String(error)}`);
        });
      }
    }

    // NEW-A-7 — a cell that ends in a terminal failure or a block is never
    // parsed, so if it is the LAST to settle no parse follows to request the
    // rollup. Ask here; the request checks the run is complete and has nothing
    // left to parse, so it is a no-op while any parse is still to come.
    if (outcome.kind !== "captured") {
      const settled = await tx.query<{ captured_at: Date }>(
        `SELECT captured_at FROM answer_captures
          WHERE run_id = $1 AND prompt_id = $2 AND engine_key = $3 AND sample_index = $4
          ORDER BY captured_at DESC LIMIT 1`,
        [payload.runId, payload.promptId, payload.engineKey, payload.sampleIndex],
      );
      await requestRollupIfRunComplete(
        tx,
        {
          runId: payload.runId,
          projectId: payload.projectId,
          workspaceId: payload.workspaceId,
          capturedAt: settled.rows[0]?.captured_at ?? new Date(),
        },
        enqueueRollup,
        logger,
      );
    }

    const progress = await readRunProgress(tx, payload.runId);
    const finished = progress.captured + progress.failed + progress.skipped >= progress.planned;

    if (!finished) {
      await emitProgress(liveCache, livePublisher, payload.workspaceId, progress);
      return;
    }

    // THE LAST CELL FINALISES THE RUN, and `resolveRunOutcome` decides how.
    // STORY-031's resolver, unchanged: zero successes is `failed`; anything
    // short of every cell succeeding is `partial`, never `failed` — "a run
    // never fails MERELY because one engine is down".
    //
    // A suppressed cell counts as a success. It produced an answer; that the
    // answer came from a cache rather than an engine is a fact about cost,
    // not about whether the question was answered.
    // AND the shared `finalizeRun` moves the run to its terminal status and SETTLES THE MONEY in the same
    // transaction (SCANFIX D2): a run that captured nothing is refunded in full, a partial run is charged
    // in full. It returns null for the second of two cells finishing together, which keeps `run.completed`
    // to one per run.
    const finalised = await finalizeRun(tx, payload.workspaceId, progress);
    if (finalised === null) return;
    const dbStatus = finalised.status;

    const startedAt = runRow.started_at ?? finalised.finishedAt;
    livePublisher.toWorkspace(payload.workspaceId, "run.completed", {
      run_id: payload.runId,
      project_id: payload.projectId,
      status: dbStatus,
      captured: progress.captured,
      failed: progress.failed,
      duration_ms: Math.max(0, finalised.finishedAt.getTime() - startedAt.getTime()),
      // NULL, NOT ZERO. §11's own note: a delta is signed and may be zero, and
      // null is "no previous run to compare against" — a different fact. There
      // is no visibility score to compare at all until EPIC-05's scoring core
      // exists, so null is the only honest value this producer can send.
      visibility_delta: null,
    });

    if (dbStatus === "failed") {
      livePublisher.toWorkspace(payload.workspaceId, "run.failed", {
        run_id: payload.runId,
        project_id: payload.projectId,
        error_code: outcome.kind === "captured" ? "all_cells_failed" : outcome.errorCode,
        failed_engines: [...new Set(await failedEngines(tx, payload.runId))],
      });
    }
  };

  return phasedProcessor<ExecutePrepared, ExecuteFetched>({ prepare, run, commit });
}

/**
 * Is this delivery the job's LAST? BullMQ increments `attemptsMade` when an attempt fails, so during
 * attempt N it is N-1. Absent `opts.attempts` (a hand-built job) is "not known to be final": the error
 * propagates exactly as it always did.
 */
function isFinalAttempt(job: Job): boolean {
  const attempts = job.opts?.attempts;
  if (attempts === undefined) return false;
  return (job.attemptsMade ?? 0) + 1 >= attempts;
}

/**
 * `run.progress`, coalesced ACROSS PROCESSES.
 *
 * §11 caps it at one per 750 ms per run, and an in-process timer cannot
 * deliver that: N capture workers each holding their own clock emit N times
 * per window, and the fleet is horizontally scaled by design. A `SET NX PX`
 * on the shared cache is the token — whoever takes it emits, everyone else
 * stays quiet — so the cap holds however many workers are running.
 *
 * DROPPING THE LAST UPDATE IS SAFE, and that is why this can be lossy at all:
 * `run.completed` is uncoalesced and carries the final counts, so a client
 * whose last progress frame was suppressed still learns the true ending. A
 * cap that could strand a progress bar at 80% would need a trailing emit;
 * this one cannot.
 */
async function emitProgress(
  cache: Cache,
  realtime: RealtimePublisher,
  workspaceId: string,
  progress: Awaited<ReturnType<typeof readRunProgress>>,
): Promise<void> {
  // `onlyIfAbsent` returns false when the key already existed — "you lost the
  // race", which here means another worker emitted inside this window.
  //
  // A cache that is unreachable EMITS. Losing progress frames because Valkey
  // blinked would leave a progress bar frozen on a run that is fine; emitting
  // a few extra frames costs a socket write.
  const won = await cache
    .set(`rt:progress:${progress.runId}`, "1", { ttlMs: PROGRESS_COALESCE_MS, onlyIfAbsent: true })
    .catch(() => true);
  if (!won) return;

  realtime.toWorkspace(workspaceId, "run.progress", {
    run_id: progress.runId,
    project_id: progress.projectId,
    planned: progress.planned,
    captured: progress.captured,
    skipped: progress.skipped,
    failed: progress.failed,
    pct: progress.pct,
    eta_ms: progress.etaMs,
  });
}

/** Which engines contributed to a failed run — §11's `failed_engines[]`. */
async function failedEngines(tx: ClientBase, runId: string): Promise<string[]> {
  const rows = await tx.query<{ engine_key: string }>(
    `SELECT DISTINCT engine_key FROM answer_captures WHERE run_id = $1 AND ${nonMeasurementStatusSql("status")}`,
    [runId],
  );
  return rows.rows.map((row) => row.engine_key);
}
