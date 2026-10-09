import { Logger } from "@nestjs/common";
import { nonMeasurementStatusSql } from "../../rollup/aggregate-day.js";
import type { Job } from "bullmq";
import { Redis } from "ioredis";
import type { ClientBase } from "pg";
import { z } from "zod";
import type { Cache } from "../../cache/cache.port.js";
import { ValkeyCacheAdapter } from "../../cache/valkey-cache.adapter.js";
import type { RealtimePublisher } from "../../cache/realtime-publisher.js";
import { ValkeyRealtimePublisher } from "../../cache/realtime-publisher.js";
import { resolveEngineSpendCeilings } from "../../../config/env.schema.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { engineKeySchema } from "../../engines/contract.js";
import { SpendMeter, ValkeySpendMeterStore } from "../../engines/spend-meter.js";
import { captureCell } from "../../capture/execute-cell.js";
import { readRunProgress } from "../../capture/run-progress.js";
import { resolveRunOutcome } from "../../engines/run-outcome.js";
import { NORMALIZER_VERSION } from "../../parser/normalize.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../connection.js";
import { QueueProducer } from "../queue-producer.js";
import { signingKeysFromEnv } from "../worker-factory.js";
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

  // E2E-B6 — the platform spend meter (EC-08), built on first use like the
  // cache. Its own Valkey connection; ceilings are the configured JSON over the
  // defaults (gemini has one). Metering failures fail open inside the meter.
  let spendMeter: SpendMeter | undefined = deps?.spendMeter;
  const recordSpend = async (engineKey: string, usd: number): Promise<void> => {
    const key = engineKeySchema.safeParse(engineKey);
    if (!key.success) return;
    if (spendMeter === undefined) {
      const redis = new Redis(context.env.VALKEY_CACHE_URL, { maxRetriesPerRequest: 1 });
      redis.on("error", (error) => logger.warn(`spend meter connection error: ${error.message}`));
      spendMeter = new SpendMeter(new ValkeySpendMeterStore(redis), resolveEngineSpendCeilings(context.env.ENGINE_SPEND_CEILINGS_USD));
    }
    const result = await spendMeter.recordCost(key.data, usd);
    incrementCounter("nominara_capture_cost_recorded_total", { engine_key: key.data });
    for (const level of result.newAlerts) {
      logger.warn(`engine spend alert ${level} for ${key.data}: ${result.totalUsd.toFixed(2)} of ${String(result.ceilingUsd)} USD this month`);
    }
    if (result.hardStopped) {
      logger.error(`engine spend ceiling reached for ${key.data}: ${result.totalUsd.toFixed(2)} of ${String(result.ceilingUsd)} USD this month`);
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

  return async (tx: ClientBase, job: Job): Promise<void> => {
    const { cache: liveCache, realtime: livePublisher } = connections();
    const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);

    // THE RUN ROW IS THE TRUTH, not the payload. A job is a snapshot from
    // enqueue time, and between then and now the run may have been cancelled
    // — the cancel drains what is waiting, but a job already delivered to a
    // worker is not in the queue to drain. Checking here is what makes
    // "in-flight cells complete rather than being abandoned" mean the ones
    // that were genuinely mid-write, not every job the drain raced.
    const run = await tx.query<{ status: string; planned_cells: number; started_at: Date | null }>(
      "SELECT status, planned_cells, started_at FROM capture_runs WHERE id = $1",
      [payload.runId],
    );
    const runRow = run.rows[0];
    if (runRow === undefined) {
      // Deleted, or in another tenant and invisible to RLS. Nothing to
      // capture and nothing wrong — throwing would send the job down the
      // retry ladder for a run that no longer exists.
      logger.log(`run ${payload.runId} is gone; skipping cell`);
      return;
    }
    if (runRow.status === "canceled") {
      logger.log(`run ${payload.runId} was cancelled; skipping cell`);
      return;
    }
    // A `failed` run is terminal too, and cells can outlive it: capture.plan
    // fails a run whose dispatch REJECTED, but a rejection is ambiguous (the
    // addBulk may have landed with only the reply lost), and the fair-use
    // reservation was released with it. A late cell would call the vendor and
    // write a capture under a run that holds no reservation (checkpoint-4).
    if (runRow.status === "failed") {
      logger.log(`run ${payload.runId} has failed; skipping cell`);
      return;
    }

    // First cell to arrive moves the run to `running` and stamps the clock the
    // ETA is extrapolated from. The predicate makes it idempotent: whichever
    // of N concurrent cells wins sets it once, and the rest update no rows.
    await tx.query(
      "UPDATE capture_runs SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1 AND status = 'queued'",
      [payload.runId],
    );

    const outcome = await captureCell(tx, liveCache, {
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
    }, undefined, recordSpend);

    // E2E-B6a — `captured_cells` counts LIVE captures only (captures-and-facts.md).
    // An atomic increment, not a recount: concurrent cells each run in their own
    // transaction and cannot see each other's uncommitted rows. Suppressed cells
    // never reach this handler (they are written by the planner), and a cell
    // that ended blocked or failed is not a capture.
    if (outcome.kind === "captured") {
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
    const status = resolveRunOutcome({
      successCount: progress.captured + progress.skipped,
      totalCount: progress.planned,
      hasDegradedEngine: progress.failed > 0,
    });
    const dbStatus = status === "success" ? "completed" : status;

    const finalised = await tx.query<{ finished_at: Date }>(
      // `AND status <> ...` so two cells finishing together cannot both
      // finalise: the second updates no rows and emits nothing, which is what
      // keeps `run.completed` to one per run.
      `UPDATE capture_runs SET status = $2, finished_at = now()
        WHERE id = $1 AND status IN ('queued','running')
        RETURNING finished_at`,
      [payload.runId, dbStatus],
    );
    if (finalised.rows.length === 0) return;

    const startedAt = runRow.started_at ?? finalised.rows[0]!.finished_at;
    livePublisher.toWorkspace(payload.workspaceId, "run.completed", {
      run_id: payload.runId,
      project_id: payload.projectId,
      status: dbStatus as "completed" | "partial" | "failed",
      captured: progress.captured,
      failed: progress.failed,
      duration_ms: Math.max(0, finalised.rows[0]!.finished_at.getTime() - startedAt.getTime()),
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
