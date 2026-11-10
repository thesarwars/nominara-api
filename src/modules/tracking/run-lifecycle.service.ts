import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { RunProgressResponse, RunUndoResponse } from "../../../contracts/tracking/index.js";
import { ConflictError } from "../../api/errors/domain-errors.js";
import type { CreditUsage } from "../../api/interceptors/credit.interceptor.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { commitDeepScanCharge } from "../../lib/capture/fair-use.js";
import { deepScanPrice } from "../../lib/capture/deep-scan-price.js";
import { planFreeRetry } from "../../lib/capture/free-retry.js";
import { loadManualRunProject, planManualRun } from "../../lib/capture/manual-run.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { readRunProgress, type RunProgress } from "../../lib/capture/run-progress.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { QUEUE_TOPOLOGY } from "../../lib/queue/topology.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { maxProjectsFrom } from "../../lib/credits/confirmation.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import { resolveEntitlements } from "../../lib/entitlements/resolution.js";
import { undoRunCharge } from "../../lib/credits/undo.js";
import { afterCommit, currentTenantStore } from "../../tenancy/tenant-context.js";
import { assertProjectInScope } from "../../tenancy/project-scope.js";

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
  /**
   * AC2 — plan the run inside the request's transaction, enqueue after it
   * commits. Returns the progress AND what the debit should record about
   * itself.
   *
   * ⚠ THE USAGE IS RETURNED RATHER THAN STAMPED, because this service has no
   * request to stamp. The controller has one, and one explicit line there
   * beats an AsyncLocalStorage channel nobody can see at the call site — a
   * billing record that appears by ambient magic is a billing record nobody
   * can trace when it is wrong.
   */
  async trigger(
    projectId: string,
    actorId: string | null,
  ): Promise<{ readonly progress: RunProgressResponse; readonly usage: CreditUsage }> {
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
      // INTERACTIVE AND IMMEDIATE, and both halves are about the same fact:
      // a manual deep scan is someone waiting for an answer. It must not
      // queue behind a nightly sweep, and it must not be jittered across the
      // project's cadence window — `CADENCE_JITTER_MAX_MS.manual` is 0 for
      // exactly this case, while `plan.cadence` is the PROJECT's cadence and
      // would have delayed a weekly project's manual scan by up to an hour.
      void this.queues
        .dispatchPlannedCells(CAPTURE_EXECUTE.name, plan, { priorityVariant: "interactive", cadence: "manual" })
        .catch(
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
    return {
      progress: this.present(progress, plan.charge, credits),
      // STORY-073 AC10/AC11 — what the debit records about itself.
      //
      // ⚠ BUILT HERE, WHERE `plan` IS IN SCOPE, and not from the response.
      // `prompts` cannot be derived from `planned` and the engine count:
      // `plan-cells.ts` fans out prompt × engine × sampleIndex, so any run
      // with sampling on would have recorded a prompt count that was never
      // true — in a field FR-CRD-03 calls "a statement of work done, never
      // billing arithmetic". The planner counts the distinct prompts because
      // it is the only place they are known.
      //
      // None of these derive the price: a flat-priced scan costs the same
      // whether the cache served two cells or two hundred. They are here to
      // say what the money bought.
      usage: {
        projectId,
        referenceType: "run",
        referenceId: runId,
        unitDetail: {
          prompts: plan.prompts,
          // ⚠ THE RUN'S ENGINES, NOT THE LIVE CELLS' ENGINES. `plan.cells`
          // is what survived suppression, so an engine whose every cell came
          // from cache would vanish from the count — understating the work
          // for exactly the runs the cache served best. `engineKeys` is the
          // set that survived entitlement filtering, which is what the run
          // actually covers.
          engines: progress.engineKeys.length,
          cells_charged: plan.live,
          cells_cached: plan.skipped,
        },
      },
    };
  }

  /**
   * STORY-195 AC4 — the free retry of an all-degraded first run. Planned inside the request's transaction, dispatched after it commits
   * (KAD-06, ADR-0003: no queue call inside the transaction), exactly as `trigger`. Charges nothing: it has no `@Credits`, and
   * `planFreeRetry` reserves and debits no credit. Whether the retry is allowed, and the once-only limit, are `planFreeRetry`'s.
   */
  async retryFree(projectId: string, actorId: string | null): Promise<RunProgressResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("RunLifecycleService requires an active tenant context");

    const now = new Date();
    const project = await loadManualRunProject(store.client, projectId);
    await assertProjectInScope(store.client, projectId);
    const runId = uuidV7();
    let plan;
    try {
      ({ plan } = await planFreeRetry(store.client, this.cache, project, { runId, triggeredBy: actorId, now }));
    } catch (error) {
      const reason = (error as { details?: { reason?: string } }).details?.reason;
      incrementCounter("nominara_capture_free_retry_total", { outcome: reason ?? "error" });
      throw error;
    }
    incrementCounter("nominara_capture_free_retry_total", { outcome: "started" });
    this.logger.log({ event: "run.free_retry_started", workspace_id: project.workspaceId, project_id: projectId, run_id: runId, planned: plan.planned });

    afterCommit(() => {
      // A person is waiting on this retry, so it takes the interactive lane even though its trigger is not `manual`.
      void this.queues.dispatchPlannedCells(CAPTURE_EXECUTE.name, plan, { priorityVariant: "interactive", cadence: "manual" }).catch((error: unknown) => {
        // The run row exists and its cells are planned; a failed dispatch must not tell the customer the retry did not start (a second
        // request is refused as retry_already_used). A replan recovers it.
        this.logger.error(`failed to dispatch free retry run ${runId}: ${String(error)}`);
      });
    });

    const progress = await readRunProgress(store.client, runId, now);
    return this.present(progress, null, null);
  }

  /** AC3 and AC4 — the projection, and on a manual run the charge beside it. */
  async progress(runId: string): Promise<RunProgressResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("RunLifecycleService requires an active tenant context");

    const progress = await readRunProgress(store.client, runId);
    await assertProjectInScope(store.client, progress.projectId);
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
    // Before the status answer, so an out-of-scope member learns nothing about the run.
    await assertProjectInScope(store.client, current.projectId);
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

  /**
   * AC8 — take it back, if it is still allowed.
   *
   * ⚠ CANCEL FIRST, REFUND SECOND, IN ONE TRANSACTION — and the first
   * version said exactly that while doing the reverse. The second-engineer
   * review found the comment and the code disagreeing, and then found what
   * the disagreement cost: with the last cell landing between this method's
   * read and `cancel`'s own re-read, the refund was written, `cancel` threw
   * `ConflictError`, and the rollback took the refund with it. The MONEY was
   * right by accident; the client got a 409 carrying no reason from an
   * endpoint whose whole design is that a refusal is a 200 with one.
   *
   * Cancelling first means a run that cannot be stopped never reaches the
   * refund, and the reason it could not be stopped is the answer.
   *
   * ⚠ AND A REFUSAL IS A 200, NOT AN ERROR. "Undo after the job starts is
   * disabled with an explanation" — the interface needs the explanation and
   * the run's current state to render that, and a 409 carrying neither would
   * make the client fetch again to find out what happened. Nothing went
   * wrong; the answer is no.
   */
  async undo(runId: string, actorId: string | null): Promise<RunUndoResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("RunLifecycleService requires an active tenant context");

    const current = await readRunProgress(store.client, runId);
    await assertProjectInScope(store.client, current.projectId);

    try {
      return await this.attemptUndo(store.client, current, runId, actorId);
    } catch (error) {
      // A run that could not be stopped is a refusal, not a 500: a 409
      // carrying no reason is the round trip this endpoint exists to avoid.
      if (!(error instanceof ConflictError)) throw error;
      return { run: this.present(current, null, null), credits_refunded: 0, refusal: "work_started" };
    }
  }

  private async attemptUndo(
    client: ClientBase,
    current: RunProgress,
    runId: string,
    actorId: string | null,
  ): Promise<RunUndoResponse> {
    const store = currentTenantStore()!;

    // ⚠ NOT `status`, AND NOT `captured + failed` EITHER. A run is `running`
    // milliseconds after the 202, so refusing on status would refuse every
    // undo. And `captured + failed` excludes cache-served cells, which
    // `run-progress.ts` says in its own comment is wrong — "A SUPPRESSED CELL
    // IS DONE" — so a re-triggered scan served entirely from L1 delivered
    // every answer and refunded every credit. What §7 means by "the job has
    // not started" is that nothing has been DELIVERED, and a cell whose
    // answer the customer can read is delivered whoever served it.
    const deliveredCells = current.captured + current.failed + current.skipped;

    // ⚠ HANDED IN, NOT CALLED HERE. `undoRunCharge` invokes it only once
    // every check has passed and before any credit moves — the ordering is
    // enforced by the module that knows both ways of getting it wrong. A run
    // that finished in the meantime cannot be cancelled, and that IS the
    // refusal: work was delivered.
    // A ConflictError from `cancel` propagates out of `undoRunCharge` with
    // nothing moved, and `undo` turns it into the refusal.
    const stopWork = async (): Promise<void> => {
      if (!CANCELLABLE.has(current.status)) return;
      cancelled = await this.cancel(runId);
    };

    let cancelled: RunProgressResponse | null = null;
    const outcome = await undoRunCharge(client, {
      stopWork,
      workspaceId: store.context.workspaceId,
      runId,
      // ⚠ §7 GIVES THE UNDO TO ACTIONS BELOW ALL THRESHOLDS ONLY, and
      // `undoRunCharge` re-derives that from the ledger rather than being
      // told. This is the one threshold input the ledger cannot supply.
      //
      // For a seeded deep scan the verdict is always "confirmed" — the
      // cheapest price is 100 against a `creditsAbove` of 25 — so this route
      // refuses every real undo today and goes live if a workspace's
      // contracted price ever falls below the thresholds, or when a cheap
      // priced action arrives.
      maxProjects: maxProjectsFrom(
        structuralLimitFrom((await resolveEntitlements(client, store.context.workspaceId)).entitlements["projects.max"]?.value ?? null),
      ),
      actorId,
      actorType: actorId === null ? "system" : "user",
      deliveredCells,
    });

    const run = cancelled ?? this.present(current, null, null);
    return outcome.refusal !== null
      ? { run, credits_refunded: 0, refusal: outcome.refusal }
      : { run, credits_refunded: outcome.refunded, refusal: null };
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
