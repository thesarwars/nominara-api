import { Inject, Injectable, Logger } from "@nestjs/common";
import type { RunProgressResponse } from "../../../contracts/tracking/index.js";
import { ConflictError } from "../../api/errors/domain-errors.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { commitDeepScanCharge } from "../../lib/capture/fair-use.js";
import { deepScanPrice } from "../../lib/capture/deep-scan-price.js";
import { loadManualRunProject, planManualRun } from "../../lib/capture/manual-run.js";
import { readRunProgress, type RunProgress } from "../../lib/capture/run-progress.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { QUEUE_TOPOLOGY } from "../../lib/queue/topology.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { afterCommit, currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-034 AC2–AC5 — trigger, observe, cancel.

const CAPTURE_EXECUTE = QUEUE_TOPOLOGY.find((entry) => entry.name === "capture.execute")!;

/** §5's table prices `manual` and nothing else; every other trigger is inside the subscription. */
const CHARGED_TRIGGER = "manual";

/** A run that has already stopped cannot be cancelled again. */
const CANCELLABLE = new Set(["queued", "running"]);

@Injectable()
export class RunLifecycleService {
  private readonly logger = new Logger(RunLifecycleService.name);

  constructor(
    @Inject(CACHE) private readonly cache: Cache,
    private readonly queues: QueueProducer,
  ) {}

  /**
   * AC2 — plan the run inside the request's transaction, enqueue after it commits.
   *
   * THE ENQUEUE IS DEFERRED PAST COMMIT, for the reason `dispatchPlannedRun`
   * states: "a crash between the two loses jobs, and a replan re-creates them
   * under the same deduplication keys, whereas a rollback after enqueueing
   * would leave jobs for a run that does not exist." A lost job is
   * recoverable; a job for a run that was rolled back is not.
   */
  async trigger(projectId: string, actorId: string | null): Promise<RunProgressResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("RunLifecycleService requires an active tenant context");

    const now = new Date();
    const project = await loadManualRunProject(store.client, projectId);
    const runId = uuidV7();
    const { plan, credits } = await planManualRun(store.client, this.cache, project, {
      runId,
      triggeredBy: actorId,
      now,
    });

    afterCommit(() => {
      void this.queues.dispatchPlannedCells(CAPTURE_EXECUTE.name, plan).catch(
        (error: unknown) => {
          // The run row EXISTS and its cells are planned. Failing the response
          // here would tell the customer their scan did not start when the
          // record says it did — and they would trigger a second, which is a
          // second flat charge. A replan recovers this; a duplicate run does
          // not.
          this.logger.error(`failed to dispatch run ${runId}: ${String(error)}`);
        },
      );
    });

    const progress = await readRunProgress(store.client, runId, now);
    return this.present(progress, plan.charge, credits);
  }

  /** AC3 and AC4 — the projection, and on a manual run the charge beside it. */
  async progress(runId: string): Promise<RunProgressResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("RunLifecycleService requires an active tenant context");

    const progress = await readRunProgress(store.client, runId);
    return this.present(
      progress,
      // Recomputed rather than stored. The hook is pure — it reports what
      // WOULD be charged for this trigger — so calling it again on a read
      // gives the same answer without a column that could drift from it.
      commitDeepScanCharge({
        workspaceId: store.context.workspaceId,
        runId,
        trigger: progress.trigger,
        cellsPlanned: progress.planned,
        cellsCharged: progress.planned - progress.skipped,
        cellsCached: progress.skipped,
      }),
      await this.priceFor(progress),
    );
  }

  /**
   * The flat price, resolved only for the trigger that has one.
   *
   * READ NOW RATHER THAN STORED AT TRIGGER TIME, because there is no column
   * for it and inventing one would be a claim the ledger should make. When
   * EPIC-10 lands, what a run actually cost comes from `credit_ledger`, and
   * this becomes the quote rather than the record. Until then it is the
   * plan's current figure, reported beside `charged: false`.
   */
  private async priceFor(progress: RunProgress): Promise<number | null> {
    if (progress.trigger !== CHARGED_TRIGGER) return null;
    const store = currentTenantStore();
    if (store === undefined) return null;
    return deepScanPrice(store.client, store.context.workspaceId);
  }

  /**
   * AC5 — drain what is queued, mark the run cancelled, let the in-flight finish.
   *
   * THE ROW IS MARKED FIRST, INSIDE THE TRANSACTION, and the drain follows
   * after commit. The other order loses: a drain that succeeded against a
   * transaction that then rolled back would have removed the cells of a run
   * still marked running, and nothing would re-create them.
   */
  async cancel(runId: string): Promise<RunProgressResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("RunLifecycleService requires an active tenant context");

    const current = await readRunProgress(store.client, runId);
    if (!CANCELLABLE.has(current.status)) {
      // Not idempotent-by-silence. A run that already completed cannot be
      // cancelled, and answering 200 would let a client report "cancelled" for
      // a scan whose results are about to appear.
      throw new ConflictError({ message: `a ${current.status} run cannot be cancelled` });
    }

    await store.client.query(
      "UPDATE capture_runs SET status = 'canceled', finished_at = now() WHERE id = $1 AND status IN ('queued','running')",
      [runId],
    );

    afterCommit(() => {
      void this.queues
        .drainWaiting("capture.execute", (data) => (data as { runId?: string }).runId === runId)
        .then((removed) => {
          this.logger.log(`cancelled run ${runId}: drained ${String(removed)} queued cells`);
        })
        .catch((error: unknown) => {
          // The run IS cancelled — the row says so and no result will be
          // recorded against it. Undrained jobs waste an engine call and are
          // the lesser failure; reporting the cancel as failed would leave a
          // customer thinking a scan they stopped is still running.
          this.logger.error(`failed to drain queued cells for run ${runId}: ${String(error)}`);
        });
    });

    return this.present({ ...current, status: "canceled" }, null, null);
  }

  private present(
    progress: RunProgress,
    charge: { charged: boolean; reason: string } | null,
    credits: number | null,
  ): RunProgressResponse {
    return {
      run_id: progress.runId,
      project_id: progress.projectId,
      trigger: progress.trigger,
      status: progress.status,
      engine_keys: [...progress.engineKeys],
      planned: progress.planned,
      captured: progress.captured,
      skipped: progress.skipped,
      failed: progress.failed,
      pct: progress.pct,
      eta_ms: progress.etaMs,
      started_at: progress.startedAt,
      finished_at: progress.finishedAt,
      // NULL ON A SCHEDULED RUN, and that is not zero. §5's table puts a
      // scheduled run inside the subscription envelope: it was never priced,
      // so `credits: 0` would say "this one was free" where the truth is
      // "this one is not a purchase".
      //
      // `credits` IS THE FLAT PRICE and `charged` IS FALSE, together. AC4
      // wants the charge stated as work done, and the honest statement today
      // is "this scan is priced at 200, and nothing has moved" —
      // `commitDeepScanCharge` supplies the reason, which is that the credit
      // wallet does not exist yet.
      charge:
        charge !== null && credits !== null && progress.trigger === CHARGED_TRIGGER
          ? { credits, charged: charge.charged, reason: charge.reason }
          : null,
      forecast: {
        planned_cells: progress.planned,
        live_cells: Math.max(0, progress.planned - progress.skipped),
        cached_cells: progress.skipped,
        cached_by_layer: progress.cachedByLayer,
      },
    };
  }
}
