import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import { TasksService } from "../../../modules/tasks/tasks.service.js";
import { ValkeyRealtimePublisher, type RealtimePublisher } from "../../cache/realtime-publisher.js";
import { generateTasksForProject, type GenerationSummary } from "../../taskgen/generate.js";
import { withProjectQueueLock } from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-063 — `task.generate`: evaluate the rule catalog for one project and one workspace-local day.
//
// Runs inside `withTenantJob`, which has already verified the HMAC signature, set the tenant context and opened the
// transaction: `tx` is the job's tenant transaction, so RLS scopes every read and write and there is no workspace
// predicate below. The payload is strict — an unknown key fails the job rather than being silently dropped.
//
// IDEMPOTENT under at-least-once delivery: a redelivered job finds the tasks it already made (fingerprint) and evidence it
// already recorded (newer-than-`last_evidence_at`), and writes nothing.
//
// No network call (KAD-06): generation reads this database only. The one thing that leaves the process is the realtime
// `task.created` notice, which `TasksService` defers until after COMMIT.

const payloadSchema = z
  .object({
    workspaceId: z.string().uuid(),
    kid: z.string(),
    projectId: z.string().uuid(),
    /** `YYYY-MM-DD`, workspace-local. Absent means "today in the workspace's zone". */
    metricDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    /** A producer that knows only one kind of change (a new AUX finding) narrows the rules evaluated. */
    triggerKinds: z.array(z.string()).min(1).optional(),
  })
  .strict();

export interface TaskGenerateDeps {
  readonly realtime?: RealtimePublisher;
}

export function createTaskGenerateHandler(context: QueueHandlerContext, deps: TaskGenerateDeps = {}): JobProcessor {
  const logger = new Logger("task.generate");
  // Built on the first job, not at boot: a worker group without a reachable cache must still boot.
  let tasks: TasksService | undefined;
  const tasksService = (): TasksService => {
    tasks ??= new TasksService(deps.realtime ?? new ValkeyRealtimePublisher(context.env.VALKEY_CACHE_URL));
    return tasks;
  };

  return async (tx: ClientBase, job: Job): Promise<GenerationSummary> => {
    const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);
    // One generation per project at a time. The queue allows concurrency 4 and each rollup queues its own job, so two jobs for one
    // project can overlap; they would take the per-task fingerprint locks and the project row lock (task counts) in different
    // orders and deadlock (40P01). Serialised here, the second job simply runs after the first and finds its tasks.
    return withProjectQueueLock(tx, "task.generate", payload.projectId, () => run(tx, payload));
  };

  async function run(tx: ClientBase, payload: z.infer<typeof payloadSchema>): Promise<GenerationSummary> {
    const metricDate = payload.metricDate ?? (await localToday(tx, payload.projectId));
    if (metricDate === undefined) {
      logger.log({ event: "task.generate.project_gone", workspace_id: payload.workspaceId, project_id: payload.projectId });
      return { rulesEvaluated: 0, rulesSkipped: 0, created: 0, refreshed: 0, deduplicated: 0, suppressed: 0 };
    }
    return generateTasksForProject(tx, tasksService(), {
      projectId: payload.projectId,
      metricDate,
      ...(payload.triggerKinds === undefined ? {} : { triggerKinds: payload.triggerKinds }),
    });
  }
}

/** Today in the workspace's zone, asked of Postgres so the conversion uses the same tz database the rollup does. */
async function localToday(tx: ClientBase, projectId: string): Promise<string | undefined> {
  const row = await tx.query<{ today: string }>(
    `SELECT to_char((now() AT TIME ZONE w.timezone)::date, 'YYYY-MM-DD') AS today
       FROM projects p JOIN workspaces w ON w.id = p.workspace_id
      WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [projectId],
  );
  return row.rows[0]?.today;
}
