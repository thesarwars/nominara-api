import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import type { Cache } from "../../cache/cache.port.js";
import { ValkeyCacheAdapter } from "../../cache/valkey-cache.adapter.js";
import type { RealtimePublisher } from "../../cache/realtime-publisher.js";
import { ValkeyRealtimePublisher } from "../../cache/realtime-publisher.js";
import { captureCell } from "../../capture/execute-cell.js";
import { readRunProgress } from "../../capture/run-progress.js";
import { resolveRunOutcome } from "../../engines/run-outcome.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

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

/** `v1` — the same constant manual-run.ts stamps onto the plan. */
const NORMALIZER_VERSION = "v1";

/** §11: `run.progress` is coalesced at ≤ 1 / 750 ms / run. */
const PROGRESS_COALESCE_MS = 750;

export interface CaptureExecuteDeps {
  readonly cache: Cache;
  readonly realtime: RealtimePublisher;
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
  const connections = (): { cache: Cache; realtime: RealtimePublisher } => {
    cache ??= new ValkeyCacheAdapter(context.env.VALKEY_CACHE_URL);
    realtime ??= new ValkeyRealtimePublisher(context.env.VALKEY_CACHE_URL);
    return { cache, realtime };
  };

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
    });

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
    "SELECT DISTINCT engine_key FROM answer_captures WHERE run_id = $1 AND status IN ('failed','blocked')",
    [runId],
  );
  return rows.rows.map((row) => row.engine_key);
}
