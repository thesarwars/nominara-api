import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import { guardedFetch } from "../../net/guarded-fetch.js";
import {
  commitPresenceRun,
  commitSeededVerification,
  fetchPresence,
  fetchSeededTarget,
  preparePresenceRun,
  prepareSeededVerification,
  type PresenceOutcome,
  type PresenceResult,
  type PresenceRunPlan,
  type SeededVerificationPlan,
} from "../../sources/verify-presence.js";
import {
  commitSubmissionVerification,
  fetchSubmission,
  recordSubmissionGaveUp,
  type SubmissionFetcher,
  prepareSubmissionVerification,
  type SubmissionOutcome,
  type SubmissionPlan,
} from "../../sources/verify-submission.js";
import { ValkeyRealtimePublisher, type RealtimePublisher } from "../../cache/realtime-publisher.js";
import { afterCommit } from "../../../tenancy/tenant-context.js";
import type { QueueHandlerContext } from "../handlers.js";
import { PHASES_DONE, phasedProcessor, type JobProcessor, type PhaseFailure } from "../worker-factory.js";

// NEW-C-15 / STORY-054 AC4 + AC11 — `source.verify_presence`: for one project,
// fetch the top cited URL per domain (through the guarded fetcher) and record
// whether the brand is on it. The logic is in `verify-presence.ts`; this is the
// queue shell.
//
// STORY-066 AC8 — the same queue verifies ONE COMPLETED AUTHORITY TASK when the
// payload names it (`taskId`): `TasksService.completeTask` enqueues it after
// its commit, the job fetches the task's target URL past the 30-day cache, and
// a verified mention pins `source_seeded` at the completion.
//
// STORY-055 (owner decision 30) — and a third mode: the payload names a task AND a `submissionId`, the customer's contribution URL
// that `TasksService.completeTask` queued after sending a seeding task to `in_review`. The job fetches THAT URL (the guarded
// fetcher), then either completes the task (milestones, presence flag, gap closed) or leaves it in review with a specific reason.
// The logic is in `verify-submission.ts`. Idempotent: an answered, superseded or no-longer-in-review submission fetches nothing.
//
// ADR-0003 — A PHASED JOB, in all three modes: `prepare` reads in one short tenant
// transaction, `run` fetches with no transaction and no client, `commit`
// writes in a second short one. (Before STORY-066 this handler held its job
// transaction across up to MAX_DOMAINS_PER_RUN fetches — one of the ADR's
// listed violators.)
//
// The tenant context of both transactions is set from the verified payload by
// worker-factory, so no workspace predicate appears here. Idempotent under
// at-least-once delivery: a periodic redelivery finds every domain inside the
// 30-day cache and fetches nothing; a seeded redelivery finds the pin already
// there and fetches nothing.

const payloadSchema = z
  .object({
    workspaceId: z.string().uuid(),
    kid: z.string(),
    projectId: z.string().uuid(),
    /** STORY-066 AC8 — present when the job verifies one completed authority task (enqueued by `completeTask`). */
    taskId: z.string().uuid().optional(),
    /** STORY-055 — with `taskId`: the `verification_submitted` event this job answers. */
    submissionId: z.string().uuid().optional(),
  })
  .strict();

export interface SourceVerifyPresenceDeps {
  readonly fetch?: SubmissionFetcher;
  /** STORY-055 - the realtime publisher a changed task announces itself on (`task.moved`). Built lazily in production; injected in tests. */
  readonly realtime?: RealtimePublisher;
  readonly now?: () => Date;
}

type Prepared =
  | { readonly mode: "project"; readonly projectId: string; readonly plan: PresenceRunPlan; readonly now: Date; readonly today: string }
  | { readonly mode: "seeded"; readonly plan: SeededVerificationPlan }
  | { readonly mode: "submission"; readonly plan: SubmissionPlan };

type Fetched =
  | { readonly mode: "project"; readonly results: PresenceResult[] }
  | { readonly mode: "seeded"; readonly outcome: PresenceOutcome }
  | { readonly mode: "submission"; readonly outcome: SubmissionOutcome };

const tracer = trace.getTracer("nominara-api");

/** The submission's guarded fetch, in a span: the one outbound call of this job mode. IDs only - never the URL. */
function fetchSubmissionTraced(plan: SubmissionPlan, fetch: SubmissionFetcher): Promise<SubmissionOutcome> {
  return tracer.startActiveSpan("tasks.verify_submission", async (span) => {
    try {
      const outcome = await fetchSubmission(plan, fetch);
      span.setAttribute("nominara.tasks.verification_outcome", outcome.status === "verified" ? "verified" : outcome.reason);
      return outcome;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function createSourceVerifyPresenceHandler(context: QueueHandlerContext, deps: SourceVerifyPresenceDeps = {}): JobProcessor {
  const logger = new Logger("source.verify_presence");
  const fetch: SubmissionFetcher = deps.fetch ?? ((url, init) => guardedFetch(url, init));
  const clock = deps.now ?? (() => new Date());
  // Built on the first submission job, not at boot: a worker group without a reachable cache must still boot (as task.generate's).
  let publisher: RealtimePublisher | undefined;
  const realtime = (): RealtimePublisher => (publisher ??= deps.realtime ?? new ValkeyRealtimePublisher(context.env.VALKEY_CACHE_URL));

  return phasedProcessor<Prepared, Fetched>({
    async prepare(tx: ClientBase, job: Job) {
      const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);
      if (payload.taskId !== undefined && payload.submissionId !== undefined) {
        const plan = await prepareSubmissionVerification(tx, payload.projectId, payload.taskId, payload.submissionId);
        if (plan === null) {
          logger.log({ event: "task_verification_nothing_to_verify", workspaceId: payload.workspaceId, projectId: payload.projectId, taskId: payload.taskId });
          return PHASES_DONE;
        }
        return { mode: "submission", plan };
      }
      if (payload.taskId !== undefined) {
        const plan = await prepareSeededVerification(tx, payload.projectId, payload.taskId);
        if (plan === null) {
          logger.log({ event: "source_seeded_nothing_to_verify", workspaceId: payload.workspaceId, projectId: payload.projectId, taskId: payload.taskId });
          return PHASES_DONE;
        }
        return { mode: "seeded", plan };
      }

      // The workspace-local day the index is recomputed as of, from the row — as rollup.metric_daily does.
      const zone = await tx.query<{ today: string }>(
        `SELECT to_char((now() AT TIME ZONE w.timezone)::date, 'YYYY-MM-DD') AS today
           FROM projects p JOIN workspaces w ON w.id = p.workspace_id
          WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [payload.projectId],
      );
      const today = zone.rows[0]?.today;
      if (today === undefined) {
        logger.log({ event: "source_presence_project_gone", workspaceId: payload.workspaceId, projectId: payload.projectId });
        return PHASES_DONE; // deleted, or another tenant's and invisible to RLS: nothing to verify, nothing wrong
      }
      const now = clock();
      const plan = await preparePresenceRun(tx, payload.projectId, now);
      if (plan === null) return PHASES_DONE;
      return { mode: "project", projectId: payload.projectId, plan, now, today };
    },

    async run(prepared: Prepared): Promise<Fetched> {
      if (prepared.mode === "submission") return { mode: "submission", outcome: await fetchSubmissionTraced(prepared.plan, fetch) };
      if (prepared.mode === "seeded") return { mode: "seeded", outcome: await fetchSeededTarget(prepared.plan, fetch) };
      return { mode: "project", results: await fetchPresence(prepared.plan, fetch) };
    },

    async commit(tx: ClientBase, prepared: Prepared, fetched: Fetched) {
      if (prepared.mode === "submission" && fetched.mode === "submission") {
        const changed = await commitSubmissionVerification(tx, prepared.plan, fetched.outcome, clock());
        if (changed) {
          // After COMMIT, like TasksService's: a rolled-back verification announces nothing. A failed check changes what the task
          // shows (its review reason) as much as a completion does.
          const { workspaceId, projectId, taskId } = prepared.plan;
          afterCommit(() => realtime().toWorkspace(workspaceId, "task.moved", { task_id: taskId, project_id: projectId }));
        }
        return;
      }
      if (prepared.mode === "seeded" && fetched.mode === "seeded") {
        await commitSeededVerification(tx, prepared.plan, fetched.outcome, clock());
        return;
      }
      if (prepared.mode === "project" && fetched.mode === "project") {
        await commitPresenceRun(tx, prepared.projectId, prepared.plan, fetched.results, prepared.now, prepared.today);
      }
    },
    // STORY-055 (review r4) - a SUBMISSION job whose last attempt fails (a database error in prepare or commit, retries spent) answers
    // `unreachable`, so the task does not stay `pending` for ever with every resubmit a 409. The fetch itself never throws (every fetch
    // failure is an answer), so only the database can bring a job here. The other modes keep the queue's own failure handling.
    async recover(tx: ClientBase, job: Job, _failure: PhaseFailure<Prepared, Fetched>) {
      if (!isFinalAttempt(job)) return false;
      const payload = payloadSchema.safeParse((job.data as { payload: unknown }).payload);
      if (!payload.success || payload.data.taskId === undefined || payload.data.submissionId === undefined) return false;
      const { workspaceId, projectId, taskId, submissionId } = payload.data;
      const wrote = await recordSubmissionGaveUp(tx, { workspaceId, projectId, taskId, submissionId });
      // The same announcement the commit makes, after COMMIT: the task now shows its review reason, so the board must refresh.
      if (wrote) afterCommit(() => realtime().toWorkspace(workspaceId, "task.moved", { task_id: taskId, project_id: projectId }));
      return wrote;
    },
  });
}

/** BullMQ increments `attemptsMade` when an attempt fails, so during attempt N it is N-1. An unknown attempt count is "not known to be final". */
function isFinalAttempt(job: Pick<Job, "attemptsMade" | "opts">): boolean {
  const attempts = job.opts?.attempts;
  if (attempts === undefined) return false;
  return (job.attemptsMade ?? 0) + 1 >= attempts;
}
