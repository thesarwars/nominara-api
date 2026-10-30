import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { capturePlanJobSchema } from "../../../../contracts/tracking/capture-plan-job.schema.js";
import type { Cache } from "../../cache/cache.port.js";
import { ValkeyCacheAdapter } from "../../cache/valkey-cache.adapter.js";
import { cacheKeyNamespace } from "../../cache/key-namespace.js";
import { crawlAuditIdempotencyKey, onboardingAuditId, onboardingAuditWanted, type EnqueueCrawlAudit } from "../../aux/onboarding-audit.js";
import { releaseFairUseCapacity } from "../../capture/fair-use.js";
import { claimDueProject, planScheduledRun, priorityVariantFor, type ScheduledRun } from "../../capture/scheduler.js";
import { resolveEntitlements } from "../../entitlements/resolution.js";
import { uuidV7 } from "../../ids/uuidv7.js";
import { NORMALIZER_VERSION } from "../../parser/normalize.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { resolveBillingPeriod } from "../../usage/billing-period.js";
import { SYSTEM_ACTOR_ID } from "../../../tenancy/constants.js";
import { afterCommit, withTenantContext } from "../../../tenancy/tenant-context.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../connection.js";
import { QueueProducer } from "../queue-producer.js";
import { signingKeysFromEnv } from "../worker-factory.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// NEW-A-10 — `capture.plan`: plan and dispatch ONE scheduled run for ONE
// project. STORY-033 built the pieces (`planScheduledRun`, `dispatchPlannedRun`);
// nothing ran them, so no scheduled run could ever exist. This is the consumer.
//
// THE JOB CARRIES A PROJECT, NOT A DECISION. Whether the project is due, which
// engines are due, and what the run covers are all re-derived here from the
// rows, inside the job's tenant context. A producer (the sweep, NEW-A-13) that
// is wrong or replayed therefore cannot make a run happen that the schedule
// would not have — the same reason `capture.execute` re-reads its run row
// rather than trusting its payload.
//
// IDEMPOTENCY IS THE SCHEDULE ITSELF. `claimDueProject` locks the project row
// and tests `next_run_at <= now`; `planScheduledRun` advances it (compare-and-
// set) in the same transaction as the run row. A second delivery — retry,
// duplicate, or a concurrent worker — waits on the lock, sees the advanced
// `next_run_at`, and finds the project not due. No second run row is possible,
// and no extra dedupe table was needed.
//
// NOTHING IS CHARGED. §5 prices `manual` and nothing else; a scheduled run is
// inside the subscription. `planRun` writes no ledger row for it, and the
// fair-use counter is reserved for LIVE cells only (cache-served cells are
// suppressed before the reservation). Both are asserted by the spec.
//
// ENGINES: `resolveDueEngines` intersects the due set with
// `captureReadyEngineKeys()` — only an engine with a real adapter (gemini, when
// its key is configured). A demo engine is never planned, and a project with no
// capturable engine gets no run row and no failure (`planScheduledRun` returns
// null, having advanced the schedule so it is not re-claimed every tick).

export interface CapturePlanDeps {
  /** Injected in tests; production builds a Valkey cache from env on first use. */
  readonly cache?: Cache;
  /** Injected in tests; production signs and enqueues the run's cells. Called AFTER the job's transaction commits. */
  readonly dispatch?: (scheduled: ScheduledRun) => Promise<unknown>;
  readonly now?: () => Date;
  /**
   * Runs `fn` on a connection for the dispatch-failure compensation (a SECOND
   * transaction, after the job's own has committed). Injected in tests;
   * production borrows one from the worker pool.
   */
  readonly withClient?: <T>(fn: (client: ClientBase) => Promise<T>) => Promise<T>;
  /**
   * The producer of the project's free onboarding `crawl.audit` (owner decision 34). Injected in tests; production signs and enqueues on first
   * use. Called AFTER the job's transaction commits, and a failure is logged and counted, never thrown.
   */
  readonly enqueueCrawlAudit?: EnqueueCrawlAudit;
}

type Outcome = "planned" | "skipped" | "no_capturable_engine" | "dispatch_failed";

export function createCapturePlanHandler(context: QueueHandlerContext, deps?: CapturePlanDeps): JobProcessor {
  const logger = new Logger("capture.plan");

  // Built on first use, not at registration — QUEUE_HANDLERS is evaluated for
  // every worker group at boot (see capture-execute.handler.ts).
  let cache: Cache | undefined = deps?.cache;
  let producer: QueueProducer | undefined;
  const dispatch =
    deps?.dispatch ??
    (async (scheduled: ScheduledRun): Promise<unknown> => {
      producer ??= new QueueProducer(
        createQueueWorkerConnection(context.env.QUEUE_REDIS_URL),
        queueKeyPrefix(context.env.NODE_ENV),
        signingKeysFromEnv(context.env),
      );
      // The producer SIGNS each cell; the raw-queue `dispatchScheduledRun`
      // enqueues the plan verbatim and `capture.execute` verifies a signature
      // before it does anything, so every cell it sent would be rejected.
      return producer.dispatchPlannedCells("capture.execute", scheduled.plan, {
        priorityVariant: priorityVariantFor(scheduled.trigger),
        cadence: scheduled.plan.cadence,
      });
    });

  const enqueueCrawlAudit: EnqueueCrawlAudit =
    deps?.enqueueCrawlAudit ??
    (async (workspaceId, payload, idempotencyKey): Promise<unknown> => {
      producer ??= new QueueProducer(
        createQueueWorkerConnection(context.env.QUEUE_REDIS_URL),
        queueKeyPrefix(context.env.NODE_ENV),
        signingKeysFromEnv(context.env),
      );
      return producer.enqueueTenantJob("crawl.audit", workspaceId, payload, { idempotencyKey });
    });

  /**
   * OWNER DECISION 34, item 1 - the project's FIRST scan also starts its free onboarding AUX audit, so the AUX screen is never empty on a real
   * project. Asked for once the project has been claimed as due, whether or not an engine was capturable (the audit needs none), and only while
   * the project has no audit at all. The enqueue is after COMMIT and its failure never fails the scan: the audit is retried by the next call
   * that finds the project still without one (a manual audit, or the next scheduled scan).
   */
  const requestOnboardingAudit = async (tx: ClientBase, workspaceId: string, projectId: string): Promise<void> => {
    if (!(await onboardingAuditWanted(tx, projectId))) return;
    const auditId = onboardingAuditId(projectId);
    afterCommit(() => {
      void enqueueCrawlAudit(workspaceId, { projectId, auditId, trigger: "onboarding" }, crawlAuditIdempotencyKey(projectId, auditId))
        .then(() => {
          incrementCounter("nominara_aux_onboarding_audit_requested_total", {});
          logger.log({ event: "aux.onboarding_audit.requested", workspace_id: workspaceId, project_id: projectId, audit_id: auditId });
        })
        .catch((error: unknown) => {
          incrementCounter("nominara_aux_onboarding_audit_request_failed_total", {});
          // The error NAME only: a queue error's message can carry a connection string.
          logger.error({ event: "aux.onboarding_audit.enqueue_failed", workspace_id: workspaceId, project_id: projectId, error: error instanceof Error ? error.name : "unknown" });
        });
    });
  };

  const withClient =
    deps?.withClient ??
    (async <T>(fn: (client: ClientBase) => Promise<T>): Promise<T> => {
      const client = await context.pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    });

  /**
   * A run whose cells could not be handed to the queue will never be captured:
   * `next_run_at` has already moved and nothing replans a `queued` run. Left
   * alone it shows as queued indefinitely and its fair-use reservation (made
   * for cells that never ran) stays consumed for the cycle. So: in a fresh
   * tenant transaction, fail the run and give the reservation back.
   *
   * Only a run still `queued` is failed — if any cell had already started it
   * is `running`, some cells did go out, and its reservation is not ours to
   * release. Best-effort and logged: it must never turn into a thrown job.
   */
  const failUndispatchedRun = async (workspaceId: string, runId: string, periodStart: string, live: number): Promise<void> => {
    await withClient((client) =>
      withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        const failed = await tx.query(
          `UPDATE capture_runs
              SET status = 'failed', finished_at = now(),
                  error_summary = '{"reason":"dispatch_failed"}'::jsonb
            WHERE id = $1 AND status = 'queued'`,
          [runId],
        );
        if ((failed.rowCount ?? 0) === 1) await releaseFairUseCapacity(tx, workspaceId, periodStart, live);
      }),
    );
  };

  const record = (outcome: Outcome, workspaceId: string, projectId: string, runId?: string): void => {
    incrementCounter("nominara_capture_plan_runs_total", { outcome });
    // IDs only — never the workspace's name, a prompt's text or an engine answer.
    logger.log({
      event: `capture.plan.${outcome}`,
      workspace_id: workspaceId,
      project_id: projectId,
      ...(runId === undefined ? {} : { run_id: runId }),
    });
  };

  return async (tx: ClientBase, job: Job): Promise<void> => {
    const payload = capturePlanJobSchema.parse((job.data as { payload: unknown }).payload);
    const now = (deps?.now ?? (() => new Date()))();

    const project = await claimDueProject(tx, payload.projectId, now);
    if (project === null || project.workspaceId !== payload.workspaceId) {
      // Not due (including: already planned by an earlier delivery), paused,
      // deleted, a non-capturable workspace, or another tenant's project that
      // RLS hides. Ordinary on a busy tick — not an error, and not a retry.
      record("skipped", payload.workspaceId, payload.projectId);
      return;
    }

    await requestOnboardingAudit(tx, project.workspaceId, project.projectId);

    cache ??= new ValkeyCacheAdapter(context.env.VALKEY_CACHE_URL);
    const resolved = await resolveEntitlements(tx, project.workspaceId);
    const runId = uuidV7();
    const periodStart = (await resolveBillingPeriod(tx, project.workspaceId, now)).start;
    const scheduled = await planScheduledRun(
      tx,
      cache,
      project,
      {
        periodStart,
        normalizerVersion: NORMALIZER_VERSION,
        captureMode: "api",
        env: cacheKeyNamespace(),
        sharedCacheEnabled: resolved.entitlements["no_shared_cache"]?.value !== true,
      },
      { runId, trigger: payload.trigger, kind: "full", now },
    );

    if (scheduled === null) {
      // `planScheduledRun` also returns null when its compare-and-set on
      // `next_run_at` LOSES — after it has already written the run row. The
      // row is locked FOR UPDATE and the advance re-asserts the claim's own
      // `next_run_at <= now`, so under the lock this cannot happen; if it ever
      // does, a run row with no dispatch is a permanently `queued` run nothing
      // will ever complete, so roll the whole transaction back (retry) rather
      // than commit it.
      const orphan = await tx.query("SELECT 1 FROM capture_runs WHERE id = $1", [runId]);
      if ((orphan.rowCount ?? 0) > 0) {
        throw new Error("capture.plan: the schedule advance lost its compare-and-set after the run row was written");
      }
      record("no_capturable_engine", project.workspaceId, project.projectId);
      return;
    }

    record("planned", project.workspaceId, project.projectId, runId);
    // AFTER COMMIT, and never inside the transaction: dispatch is not
    // transactional, and a job for a run that rolled back is not recoverable
    // while a REJECTED one is compensated for (the run is failed, the reservation
    // released). A process that dies between COMMIT and dispatch is not a rejection:
    // the stale-run reaper (stale-run-reaper.ts, run by the sweep) covers it.
    afterCommit(() => {
      void dispatch(scheduled).catch((error: unknown) => {
        // The run row EXISTS. Failing the job would retry into a project that
        // is no longer due, and nothing replans a queued run — so the run is
        // failed and its reservation released in a follow-up transaction.
        record("dispatch_failed", project.workspaceId, project.projectId, runId);
        logger.error({ event: "capture.plan.dispatch_error", run_id: runId, error: error instanceof Error ? error.name : "unknown" });
        return failUndispatchedRun(project.workspaceId, runId, periodStart, scheduled.plan.live).catch((compensationError: unknown) => {
          logger.error({
            event: "capture.plan.compensation_error",
            workspace_id: project.workspaceId,
            run_id: runId,
            error: compensationError instanceof Error ? compensationError.name : "unknown",
          });
        });
      });
    });
  };
}
