import { Logger } from "@nestjs/common";
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
  type PresenceFetcher,
  type PresenceOutcome,
  type PresenceResult,
  type PresenceRunPlan,
  type SeededVerificationPlan,
} from "../../sources/verify-presence.js";
import type { QueueHandlerContext } from "../handlers.js";
import { PHASES_DONE, phasedProcessor, type JobProcessor } from "../worker-factory.js";

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
// ADR-0003 — A PHASED JOB, in both modes: `prepare` reads in one short tenant
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
  })
  .strict();

export interface SourceVerifyPresenceDeps {
  readonly fetch?: PresenceFetcher;
  readonly now?: () => Date;
}

type Prepared =
  | { readonly mode: "project"; readonly projectId: string; readonly plan: PresenceRunPlan; readonly now: Date; readonly today: string }
  | { readonly mode: "seeded"; readonly plan: SeededVerificationPlan };

type Fetched = { readonly mode: "project"; readonly results: PresenceResult[] } | { readonly mode: "seeded"; readonly outcome: PresenceOutcome };

export function createSourceVerifyPresenceHandler(_context: QueueHandlerContext, deps: SourceVerifyPresenceDeps = {}): JobProcessor {
  const logger = new Logger("source.verify_presence");
  const fetch = deps.fetch ?? ((url: string) => guardedFetch(url));
  const clock = deps.now ?? (() => new Date());

  return phasedProcessor<Prepared, Fetched>({
    async prepare(tx: ClientBase, job: Job) {
      const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);
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
      if (prepared.mode === "seeded") return { mode: "seeded", outcome: await fetchSeededTarget(prepared.plan, fetch) };
      return { mode: "project", results: await fetchPresence(prepared.plan, fetch) };
    },

    async commit(tx: ClientBase, prepared: Prepared, fetched: Fetched) {
      if (prepared.mode === "seeded" && fetched.mode === "seeded") {
        await commitSeededVerification(tx, prepared.plan, fetched.outcome, clock());
        return;
      }
      if (prepared.mode === "project" && fetched.mode === "project") {
        await commitPresenceRun(tx, prepared.projectId, prepared.plan, fetched.results, prepared.now, prepared.today);
      }
    },
  });
}
