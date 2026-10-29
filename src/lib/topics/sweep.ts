import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import type { TopicClusterJobPayload } from "../../../contracts/projects/index.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { CLUSTERABLE_BASE_SQL, promptSetHashSql, promptSetMemberSql } from "./cluster.js";
import { MATERIAL_CHANGE_FRACTION, MIN_CLUSTER_SIZE, TOPIC_CLUSTER_QUEUE, WEEKLY_RECOMPUTE_DAYS } from "./constants.js";

// STORY-047 AC4 - the producer of `topic.cluster`.
//
// WHY A SWEEP AND NOT A CRON. `topic.cluster` is tenant-scoped: every job carries a workspace id and an HMAC signature, so a bare
// BullMQ cron (no workspace) cannot feed it - the schedule registrar refuses that row, which is why `schedule.ts` keeps `0 5 * * 0`
// as a statement of intent only. This sweep reads project references across every workspace on the OWNER connection and enqueues one
// signed job per due project, keyed `topic:{project}:{prompt_set_hash}` so a repeated tick over an unchanged set is the same job.
//
// DUE, per project (all from this database, no network call):
//   initial            clusterable prompts >= MIN_CLUSTER_SIZE, no clusters yet, and a prompt changed in the last week. (A project whose
//                      prompts are all outliers keeps no cluster row to remember the run by, so it stays due on every tick for that
//                      week. Only the job key - topic:{project}:{prompt_set_hash}, deduped for the queue's retention - stops it
//                      re-running, and a run over such a set is cheap and idempotent.)
//   prompt_set_change  (clusterable prompts that arrived since the last clustering + clustered prompts that left, a prompt re-embedded by
//                      a different model than its cluster's counting as having left) / (the set) >= 10%.
//   weekly             the last clustering is seven days old or older.
//
// "THE LAST CLUSTERING" is `min(topic_clusters.updated_at)`: every run touches every kept cluster, so the oldest row is the run time,
// and a rename (which bumps one row) cannot move it earlier. It is imperfect for a one-cluster project that was just renamed. A
// dedicated column would be exact; adding one is a schema change this story did not name, so it is flagged, not made.

const logger = new Logger("topic.cluster.sweep");
const tracer = trace.getTracer("nominara-api");

export type TopicClusterReason = TopicClusterJobPayload["reason"];

export interface DueProject {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly reason: TopicClusterReason;
  readonly promptSetHash: string;
}

export interface ProjectClusterStats {
  readonly clusterable: number;
  readonly clusters: number;
  readonly arrived: number;
  readonly departed: number;
  readonly recent: number;
  readonly lastClusteredAt: Date | null;
}

/** Pure: the trigger rules. `null` when the project is not due. */
export function decideTrigger(stats: ProjectClusterStats, now: Date): TopicClusterReason | null {
  if (stats.clusters === 0) {
    return stats.clusterable >= MIN_CLUSTER_SIZE && stats.recent > 0 ? "initial" : null;
  }
  const changed = stats.arrived + stats.departed;
  const base = Math.max(1, stats.clusterable + stats.departed);
  if (changed > 0 && changed / base >= MATERIAL_CHANGE_FRACTION) return "prompt_set_change";
  if (stats.lastClusteredAt !== null && stats.lastClusteredAt.getTime() <= now.getTime() - WEEKLY_RECOMPUTE_DAYS * 86_400_000) return "weekly";
  return null;
}

interface StatRow {
  project_id: string;
  workspace_id: string;
  hash: string;
  clusterable: string;
  clusters: string;
  arrived: string;
  departed: string;
  recent: string;
  last_at: Date | null;
}

/** On an owner connection (it must see across tenants). */
export async function findProjectsDueForClustering(client: ClientBase, now: Date): Promise<DueProject[]> {
  const result = await client.query<StatRow>(
    `WITH counts AS (
       SELECT p.project_id, p.embedding_model, count(*) AS n
         FROM tracked_prompts p WHERE ${CLUSTERABLE_BASE_SQL} GROUP BY p.project_id, p.embedding_model
     ), dominant AS (
       SELECT DISTINCT ON (project_id) project_id, embedding_model, n FROM counts ORDER BY project_id, n DESC, embedding_model
     ), clu AS (
       SELECT project_id, count(*) AS clusters, min(updated_at) AS last_at FROM topic_clusters GROUP BY project_id
     )
     SELECT pr.id AS project_id, pr.workspace_id,
            ${promptSetHashSql(
              "d.embedding_model",
              "(SELECT string_agg(" + promptSetMemberSql("p") + ", ',' ORDER BY p.id) FROM tracked_prompts p WHERE p.project_id = pr.id AND " + CLUSTERABLE_BASE_SQL + " AND p.embedding_model = d.embedding_model)",
            )} AS hash,
            COALESCE(d.n, 0)::text AS clusterable,
            COALESCE(c.clusters, 0)::text AS clusters,
            (SELECT count(*) FROM tracked_prompts p
               WHERE p.project_id = pr.id AND ${CLUSTERABLE_BASE_SQL} AND p.embedding_model = d.embedding_model
                 AND p.cluster_id IS NULL AND c.last_at IS NOT NULL AND p.updated_at > c.last_at)::text AS arrived,
            (SELECT count(*) FROM tracked_prompts p
               WHERE p.project_id = pr.id AND p.cluster_id IS NOT NULL
                 AND (NOT (${CLUSTERABLE_BASE_SQL})
                      OR p.embedding_model <> (SELECT cl.embedding_model FROM topic_clusters cl WHERE cl.id = p.cluster_id)))::text AS departed,
            (SELECT count(*) FROM tracked_prompts p
               WHERE p.project_id = pr.id AND ${CLUSTERABLE_BASE_SQL} AND p.embedding_model = d.embedding_model
                 AND p.updated_at > $1::timestamptz - make_interval(days => $2::int))::text AS recent,
            c.last_at
       FROM projects pr
       LEFT JOIN dominant d ON d.project_id = pr.id
       LEFT JOIN clu c ON c.project_id = pr.id
      WHERE pr.deleted_at IS NULL AND (d.project_id IS NOT NULL OR c.project_id IS NOT NULL)
      ORDER BY pr.id`,
    [now, WEEKLY_RECOMPUTE_DAYS],
  );
  const due: DueProject[] = [];
  for (const row of result.rows) {
    const reason = decideTrigger(
      {
        clusterable: Number(row.clusterable),
        clusters: Number(row.clusters),
        arrived: Number(row.arrived),
        departed: Number(row.departed),
        recent: Number(row.recent),
        lastClusteredAt: row.last_at,
      },
      now,
    );
    if (reason !== null) due.push({ projectId: row.project_id, workspaceId: row.workspace_id, reason, promptSetHash: row.hash });
  }
  return due;
}

export type EnqueueTopicCluster = (
  queue: typeof TOPIC_CLUSTER_QUEUE,
  workspaceId: string,
  payload: Pick<TopicClusterJobPayload, "projectId" | "reason">,
  options: { readonly idempotencyKey: string },
) => Promise<unknown>;

export interface TopicClusterSweepResult {
  readonly status: "complete" | "partial";
  readonly due: number;
  readonly enqueued: number;
  readonly failed: number;
}

export class TopicClusterSweepBlindError extends Error {
  constructor(who: string) {
    super(`the topic-cluster sweep is connected as "${who}", which neither bypasses row-level security nor is a superuser: it would find no project due and look healthy`);
    this.name = "TopicClusterSweepBlindError";
  }
}

export function topicClusterJobKey(projectId: string, promptSetHash: string): string {
  return `topic:${projectId}:${promptSetHash}`;
}

/** One pass on `client`, an owner connection that sees across tenants. Holds no transaction and makes no network call but the enqueue. */
export async function runTopicClusterSweep(client: ClientBase, enqueue: EnqueueTopicCluster, now: Date): Promise<TopicClusterSweepResult> {
  const role = await client.query<{ can_see: boolean; who: string }>("SELECT (rolsuper OR rolbypassrls) AS can_see, rolname AS who FROM pg_roles WHERE rolname = current_user");
  if (role.rows[0]?.can_see !== true) {
    incrementCounter("nominara_topic_cluster_sweep_runs_total", { status: "blind" });
    throw new TopicClusterSweepBlindError(role.rows[0]?.who ?? "unknown");
  }
  return await tracer.startActiveSpan("topic.cluster.sweep", async (span) => {
    try {
      const due = await findProjectsDueForClustering(client, now);
      let enqueued = 0;
      let failed = 0;
      for (const project of due) {
        try {
          await enqueue(TOPIC_CLUSTER_QUEUE, project.workspaceId, { projectId: project.projectId, reason: project.reason }, { idempotencyKey: topicClusterJobKey(project.projectId, project.promptSetHash) });
          enqueued += 1;
          incrementCounter("nominara_topic_cluster_sweep_jobs_enqueued_total", { reason: project.reason });
        } catch (error) {
          failed += 1;
          incrementCounter("nominara_topic_cluster_sweep_enqueue_failures_total");
          logger.error({ event: "topic.cluster.sweep.enqueue_failed", workspace_id: project.workspaceId, project_id: project.projectId, error: error instanceof Error ? error.name : "unknown" });
        }
      }
      const status = failed === 0 ? "complete" : "partial";
      incrementCounter("nominara_topic_cluster_sweep_runs_total", { status });
      span.setAttributes({ "nominara.topic_cluster.sweep.due": due.length, "nominara.topic_cluster.sweep.enqueued": enqueued, "nominara.topic_cluster.sweep.failed": failed });
      logger.log({ event: "topic.cluster.sweep", status, due: due.length, enqueued, failed });
      return { status, due: due.length, enqueued, failed } as const;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * The sweep as the worker runs it: its failure is its OWN signal (`nominara_topic_cluster_sweep_failures_total`, `topic.cluster.sweep.failed`),
 * not folded into the report sweep's `after` failure counter. Counted and logged, never silent; the next tick retries.
 */
export async function runTopicClusterSweepIsolated(client: ClientBase, enqueue: EnqueueTopicCluster, now: Date): Promise<void> {
  try {
    await runTopicClusterSweep(client, enqueue, now);
  } catch (error) {
    incrementCounter("nominara_topic_cluster_sweep_failures_total");
    logger.error({ event: "topic.cluster.sweep.failed", error: error instanceof Error ? error.name : "unknown" });
  }
}
