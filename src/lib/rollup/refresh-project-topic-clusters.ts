import type { ClientBase } from "pg";
import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { loadTopicsInput, topicPerformanceColumns } from "../geo/topics.js";
import { windowStartFor } from "../geo/structure.js";
import { SCORING_VERSION } from "../scoring/index.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { incrementCounter, observeValue } from "../telemetry/metrics.js";
import { aggregateRange } from "./aggregate-day.js";
import { blendEngineParts, toMetricRow, type EnginePart } from "./roll-up-day.js";

// STORY-188 - the rollup refreshes the denormalised performance columns of `topic_clusters`, so every cluster filter and topical-gap
// view reads a stored value and nothing is computed on read (STORY-047 AC9).
//
//   visibility_score   the project's own figure over the cluster's member prompts: `aggregateRange` (scoped to the cluster) ->
//                      `toMetricRow` -> `blendEngineParts`, i.e. the stored `engine_key='all'` row's path and formula, over the
//                      workspace-local trailing 30 days. NULL when no member prompt was answered in the window - never 0.
//   authority_rank, leader_entity_id, gap_priority   A5 (`topicPerformanceColumns`, the code behind the persisted `topics` analysis), over
//                      the same 30-day window the GEO analyses use. `leader_entity_id` is a competitor id, or the PROJECT id for the brand
//                      (the brand's entity id everywhere else, `metric_daily`).
//   achievability      from the A1 alignment distance (`geo_alignments`), NULL (not 0) until one was measured.
//   computed_at        stamped on every refreshed cluster.
//
// LOCKS. This step holds the rollup's queue lock (`rollup.metric_daily`, per project); the clustering job (`topic.cluster`) takes its OWN
// per-project lock, so the two CAN interleave. The interleavings, and why each is safe:
//   - clustering commits AFTER this step listed the clusters: a cluster it created is not in this run's list and keeps NULL columns until
//     the next rollup fills it in (AC4); a cluster it dissolved is updated as a no-op (the row is gone) and any reference to it is nulled
//     by the next rollup's dangling pass, which re-reads `topic_clusters` in its own statement.
//   - clustering commits BEFORE: this step simply sees the new clusters.
//   - both transactions write `tracked_prompts` / `topic_clusters` / the referring tables in a different order, so Postgres may pick one
//     as a deadlock victim (40P01). That aborts one whole transaction (nothing partial is committed) and the queue retries the job; both
//     steps are idempotent, so the retry converges.
// No lock is added here: serialising the two would couple the rollup's latency to a multi-minute embedding job.
//
// One transaction, the rollup's, under its per-project advisory lock; reads only this database (no network: KAD-06 / ADR-0003). Idempotent:
// every value is a function of the stored facts, so a re-run writes the same values (and a new `computed_at`). `updated_at` is NOT moved
// (migration 0200): `min(updated_at)` is how the weekly clustering sweep reads "the last clustering".

const logger = new Logger("rollup.topic_clusters");
const tracer = trace.getTracer("nominara.topic-clusters-refresh");

/** The canonical "current" window: trailing 30 days, as the project's denormalised block and the GEO analyses use. */
export const TOPIC_CLUSTER_WINDOW_DAYS = 30;

export interface RefreshTopicClustersOptions {
  /** The window ends on this instant's day. Defaults to now. */
  asOf?: Date;
}

export interface RefreshTopicClustersResult {
  refreshed: number;
  /** Rows whose `prompt_cluster_id` pointed at a cluster that no longer exists and was set NULL. */
  danglingNulled: number;
}

/** Tables that hold a `prompt_cluster_id` with no foreign key (schemas/projects-and-prompts.md, `topic_clusters`). */
const REFERRING_TABLES = ["tasks", "task_verifications", "geo_alignments", "semantic_nodes"] as const;

/**
 * Decision 99(d): a dissolved cluster's references are set NULL, in the same transaction as the refresh. NULL is what every reader
 * already handles ("the task has no cluster"); a dangling id points at nothing.
 *
 * `corpus_passages` is a 30-day cache keyed UNIQUE on (workspace, project, cluster, content, model) with NULLS NOT DISTINCT, so nulling a
 * row whose text another cluster-less row (or another dissolved cluster's row) already holds would violate it and abort the rollup.
 * One row per text keeps the NULL; the identical duplicates are dropped (the same passage, already held).
 */
async function nullDanglingClusterReferences(tx: ClientBase, projectId: string): Promise<number> {
  let nulled = 0;
  for (const table of REFERRING_TABLES) {
    const result = await tx.query(
      `UPDATE ${table} t SET prompt_cluster_id = NULL
        WHERE t.project_id = $1 AND t.workspace_id = app.current_workspace() AND t.prompt_cluster_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM topic_clusters c WHERE c.id = t.prompt_cluster_id AND c.project_id = $1)`,
      [projectId],
    );
    nulled += result.rowCount ?? 0;
  }
  const passages = await tx.query<{ nulled: number; dropped: number }>(
    `WITH dangling AS (
       SELECT cp.id, cp.content_hash, cp.embedding_model FROM corpus_passages cp
        WHERE cp.project_id = $1 AND cp.workspace_id = app.current_workspace() AND cp.prompt_cluster_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM topic_clusters c WHERE c.id = cp.prompt_cluster_id AND c.project_id = $1)
     ), keep AS (
       SELECT DISTINCT ON (d.content_hash, d.embedding_model) d.id FROM dangling d
        WHERE NOT EXISTS (SELECT 1 FROM corpus_passages n
                           WHERE n.project_id = $1 AND n.workspace_id = app.current_workspace() AND n.prompt_cluster_id IS NULL
                             AND n.content_hash = d.content_hash AND n.embedding_model = d.embedding_model)
        ORDER BY d.content_hash, d.embedding_model, d.id
     ), dropped AS (
       DELETE FROM corpus_passages WHERE id IN (SELECT id FROM dangling) AND id NOT IN (SELECT id FROM keep) RETURNING 1
     ), nulled AS (
       UPDATE corpus_passages SET prompt_cluster_id = NULL WHERE id IN (SELECT id FROM keep) RETURNING 1
     )
     SELECT (SELECT count(*) FROM nulled)::int AS nulled, (SELECT count(*) FROM dropped)::int AS dropped`,
    [projectId],
  );
  // A dropped duplicate is a cleared dangling reference too: it is counted with the nulled ones (the log line, the span, the counter).
  return nulled + (passages.rows[0]?.nulled ?? 0) + (passages.rows[0]?.dropped ?? 0);
}

/** One cluster's visibility score; null when none of its member prompts was answered in the window. */
async function clusterVisibility(
  tx: ClientBase,
  projectId: string,
  clusterId: string,
  from: string,
  to: string,
  timezone: string,
  weights: ReadonlyMap<string, number>,
): Promise<number | null> {
  const aggregates = await aggregateRange(tx, projectId, from, to, timezone, SCORING_VERSION, undefined, clusterId);
  const parts: EnginePart[] = [];
  for (const aggregate of aggregates) {
    if (aggregate.entityType !== "brand") continue;
    const row = toMetricRow(aggregate);
    const weight = weights.get(aggregate.engineKey) ?? 1;
    parts.push({ weight, cellsTotal: row.cellsTotal, sovWeighted: row.sov * weight, visibilityScore: row.visibilityScore, liveCells: aggregate.liveCells });
  }
  if (parts.length === 0 || parts.every((part) => part.cellsTotal === 0)) return null;
  return blendEngineParts(parts).visibilityScore;
}

export async function refreshProjectTopicClusters(
  tx: ClientBase,
  projectId: string,
  timezone: string,
  options: RefreshTopicClustersOptions = {},
): Promise<RefreshTopicClustersResult> {
  return tracer.startActiveSpan("topic_clusters.refresh", async (span) => {
    const started = performance.now();
    try {
      const asOf = options.asOf ?? new Date();
      const danglingNulled = await nullDanglingClusterReferences(tx, projectId);

      const clusters = await tx.query<{ id: string }>(
        "SELECT id FROM topic_clusters WHERE project_id = $1 AND workspace_id = app.current_workspace() ORDER BY id",
        [projectId],
      );
      let refreshed = 0;
      if (clusters.rows.length > 0) {
        const days = await tx.query<{ to_date: string; from_date: string }>(
          `SELECT to_char(($1::timestamptz AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS to_date,
                  to_char((($1::timestamptz AT TIME ZONE $2)::date - ($3::int - 1)), 'YYYY-MM-DD') AS from_date`,
          [asOf.toISOString(), timezone, TOPIC_CLUSTER_WINDOW_DAYS],
        );
        const { from_date: from, to_date: to } = days.rows[0]!;
        const weightRows = await tx.query<{ engine_key: string; weight: string | null }>(
          "SELECT engine_key, weight::text FROM project_engines WHERE project_id = $1 AND workspace_id = app.current_workspace()",
          [projectId],
        );
        const weights = new Map(weightRows.rows.map((r) => [r.engine_key, r.weight === null ? 1 : Number(r.weight)]));

        const performance_ = topicPerformanceColumns(await loadTopicsInput(tx, projectId, windowStartFor(asOf, TOPIC_CLUSTER_WINDOW_DAYS), TOPIC_CLUSTER_WINDOW_DAYS));
        const byCluster = new Map(performance_.map((p) => [p.clusterId, p]));

        const ids: string[] = [];
        const visibility: (number | null)[] = [];
        const rank: (number | null)[] = [];
        const leader: (string | null)[] = [];
        const gap: (number | null)[] = [];
        const achievable: (number | null)[] = [];
        for (const { id } of clusters.rows) {
          const p = byCluster.get(id);
          ids.push(id);
          visibility.push(await clusterVisibility(tx, projectId, id, from, to, timezone, weights));
          rank.push(p?.authorityRank ?? null);
          // The brand's entity id is the project id; a competitor's is its own.
          leader.push(p?.leaderKey === undefined || p.leaderKey === null ? null : p.leaderKey === "brand" ? projectId : p.leaderKey);
          gap.push(p?.gapPriority ?? null);
          achievable.push(p?.achievability ?? null);
        }
        // `updated_at` is not in this SET list on purpose: see the header (migration 0200).
        const updated = await tx.query(
          `UPDATE topic_clusters c
              SET visibility_score = v.visibility, authority_rank = v.rank, leader_entity_id = v.leader,
                  gap_priority = v.gap, achievability = v.achievable, computed_at = now()
             FROM unnest($1::uuid[], $2::numeric[], $3::int[], $4::uuid[], $5::float8[], $6::float8[]) AS v(id, visibility, rank, leader, gap, achievable)
            WHERE c.id = v.id AND c.project_id = $7 AND c.workspace_id = app.current_workspace()`,
          [ids, visibility, rank, leader, gap, achievable, projectId],
        );
        refreshed = updated.rowCount ?? 0;
      }

      span.setAttribute("nominara.topic_clusters.refreshed", refreshed);
      span.setAttribute("nominara.topic_clusters.dangling_nulled", danglingNulled);
      incrementCounter("nominara_topic_clusters_refresh_total", { outcome: "ok" });
      // A refresh that had dangling references to clear (the count is on the log line and the span).
      if (danglingNulled > 0) incrementCounter("nominara_topic_clusters_dangling_cleared_total");
      const durationMs = Math.round(performance.now() - started);
      observeValue("nominara_topic_clusters_refresh_duration_ms", durationMs);
      // The workspace ID, never its name; counts only, no label and no answer text.
      logger.log({
        event: "topic_clusters.refreshed",
        workspace_id: currentTenantStore()?.context.workspaceId ?? "none",
        project_id: projectId,
        clusters: refreshed,
        dangling_nulled: danglingNulled,
        duration_ms: durationMs,
      });
      return { refreshed, danglingNulled };
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      incrementCounter("nominara_topic_clusters_refresh_total", { outcome: "error" });
      throw error;
    } finally {
      span.end();
    }
  });
}
