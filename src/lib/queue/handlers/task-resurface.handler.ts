import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { connect, withKeepalives } from "../../../db/client.js";
import { runTaskResurface, type ResurfaceResult } from "../../rollup/resurface-dismissed-tasks.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { globalQueueLockKey, releaseAdvisorySessionLock, tryAdvisorySessionLock } from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-064 AC5 — `task.resurface`: the daily tick that returns dismissed and snoozed tasks whose `resurface_at` has passed.
//
// Not tenant-scoped, like `domain.reverify` and `identity.sweep_unverified`: the tick has no workspace to name. The cross-tenant
// DISCOVERY runs on the owner connection; every write is applied in one tenant's context as the runtime role
// (`rollup/resurface-dismissed-tasks.ts`). Idempotent under at-least-once delivery, and single-flight across replicas by the
// advisory lock, taken as a TRY: a replica that does not get it yields, losing nothing, because the next tick asks the same question.
//
// DEPLOY INVARIANT (shared with `domain.reverify`): discovery reads `tasks` across tenants, so `DATABASE_URL` must be a role that
// bypasses FORCE RLS. A role that does not would find nothing and resurface nothing; the counter below would read zero every day.

const tracer = trace.getTracer("nominara.task-resurface");

export interface TaskResurfaceDeps {
  readonly now?: () => Date;
  readonly batchSize?: number;
}

export type TaskResurfaceOutcome = ResurfaceResult | { readonly status: "yielded" };

export function createTaskResurfaceHandler(context: QueueHandlerContext, deps: TaskResurfaceDeps = {}): JobProcessor<TaskResurfaceOutcome> {
  const logger = new Logger("task.resurface");

  // `_client` is the pooled connection `createJobProcessor` checks out for a non-tenant queue; this handler does not use it
  // (discovery runs on its own owner connection, every write on a pool connection inside one tenant's context). The queue runs at
  // concurrency 1, so the cost is one idle pooled connection, as for `domain.reverify`.
  return async (_client: ClientBase, _job: Job): Promise<TaskResurfaceOutcome> => {
    const owner = await connect(withKeepalives(context.env.DATABASE_URL));
    const lockKey = globalQueueLockKey("task.resurface");
    let held = false;
    try {
      held = await tryAdvisorySessionLock(owner, lockKey);
      if (!held) {
        incrementCounter("nominara_tasks_resurface_yielded_total");
        logger.warn({ event: "task.resurface.yielded" });
        return { status: "yielded" };
      }
      return await tracer.startActiveSpan("task.resurface", async (span) => {
        try {
          const result = await runTaskResurface(owner, context.pool, {
            now: deps.now ?? (() => new Date()),
            ...(deps.batchSize === undefined ? {} : { batchSize: deps.batchSize }),
          });
          span.setAttribute("nominara.task_resurface.reopened", result.reopened);
          span.setAttribute("nominara.task_resurface.workspaces", result.workspaces);
          span.setAttribute("nominara.task_resurface.failed", result.failed);
          incrementCounter("nominara_tasks_resurface_runs_total", { status: result.status });
          for (let i = 0; i < result.reopened; i += 1) incrementCounter("nominara_tasks_resurfaced_total");
          // Counts only — never a task title, a dismissal reason or a workspace name.
          logger.log({ event: "task.resurface.run", status: result.status, reopened: result.reopened, workspaces: result.workspaces, failed: result.failed });
          return result;
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          incrementCounter("nominara_tasks_resurface_runs_total", { status: "failed" });
          throw error;
        } finally {
          span.end();
        }
      });
    } finally {
      if (held && !(await releaseAdvisorySessionLock(owner, lockKey))) {
        logger.error({ event: "task.resurface.lock_not_held_at_release" });
      }
      await owner.end();
    }
  };
}
