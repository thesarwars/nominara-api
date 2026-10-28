import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { topicClusterJobPayloadSchema, type TopicClusterJobPayload } from "../../../../contracts/projects/index.js";
import { uuidV7 } from "../../ids/uuidv7.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import { clusterStateHash, promptSetHash, snapshotClusters, writeClusters, type ClusterPlanEntry, type ClusterSnapshot } from "../../topics/cluster.js";
import { TOPIC_CLUSTER_QUEUE } from "../../topics/constants.js";
import { TemplateTopicLabeller, labelOrFallback, uniqueLabel, type TopicLabeller } from "../../topics/labeller.js";
import { matchGroupsToClusters } from "../../topics/matching.js";
import type { QueueHandlerContext } from "../handlers.js";
import { withProjectQueueLock } from "../locks.js";
import { PHASES_DONE, phasedProcessor, type JobProcessor } from "../worker-factory.js";

// STORY-047 - `topic.cluster`: group one project's prompts by embedding similarity, name the groups, and write the clusters and the
// membership in ONE transaction.
//
// PHASED (ADR-0003 / KAD-06). The labeller is the only thing here that can be a network call (a model), so it sits between two
// short tenant transactions and holds neither a transaction nor a pooled connection:
//   prepare  read the project's prompts, find the groups IN SQL, match each to the cluster it was before (by membership), read a few
//            sample texts per NEW group. Writes nothing.
//   run      name each NEW group. Matched clusters keep their label - which is what lets a user's rename survive (AC3).
//   commit   under the project's advisory lock: re-check that nothing changed, then write cluster rows and membership together.
//
// The queue's concurrency is 2 and the lock is per project (system-architecture.md section 4), so two triggers for one project
// serialise at the commit. The loser re-reads under the lock: a changed PROMPT SET means its work is stale and it fails for the
// retry ladder (the retry re-reads); a changed CLUSTER state with the same prompt set is planned again under the lock (it matches
// what the other run wrote, so it is a no-op when the other run did this work, and it repairs the case where the set changed and
// changed back in between).
//
// IDEMPOTENT under at-least-once delivery (NFR-ARCH-02): over an unchanged set a re-run matches every group to the cluster it
// already is, keeps every label, and rewrites the same centroids and counts.
//
// No embedding provider call here, and none is needed: it reads vectors `embed.batch` stored. Prompts not yet embedded are simply
// not clustered yet (the next trigger picks them up).

const tracer = trace.getTracer("nominara.topic-cluster");

export class TopicClusterStaleError extends Error {
  constructor() {
    super("topic.cluster: the prompt set changed while the job was running; retry against the settled set");
    this.name = "TopicClusterStaleError";
  }
}

interface Prepared {
  readonly payload: TopicClusterJobPayload;
  readonly snapshot: ClusterSnapshot;
  /** group index -> the existing cluster it is. */
  readonly matched: ReadonlyMap<number, string>;
}

interface ChosenLabel {
  /** The name as chosen, BEFORE it is made unique: uniqueness is decided once, at commit, against what is committed then. */
  readonly label: string;
  readonly source: "model" | "template";
}

interface Fetched {
  /** group index -> the label chosen for a NEW cluster. */
  readonly labels: ReadonlyMap<number, ChosenLabel>;
}

const membersKey = (ids: readonly string[]): string => [...ids].sort().join(",");

export interface TopicClusterDeps {
  /** The model behind cluster names. Defaults to the deterministic template; binding Gemini waits on STORY-045's client being merged. */
  readonly labeller?: TopicLabeller;
}

export function createTopicClusterHandler(_context: QueueHandlerContext, deps: TopicClusterDeps = {}): JobProcessor {
  const logger = new Logger(TOPIC_CLUSTER_QUEUE);
  const labeller = deps.labeller ?? new TemplateTopicLabeller();

  const payloadOf = (job: Job): TopicClusterJobPayload => topicClusterJobPayloadSchema.parse((job.data as { payload: unknown }).payload);

  const prepare = async (tx: ClientBase, job: Job): Promise<Prepared | typeof PHASES_DONE> => {
    const payload = payloadOf(job);
    // RLS hides another tenant's project, so a job that names one finds nothing and ends here.
    const project = await tx.query("SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL", [payload.projectId]);
    if (project.rowCount === 0) {
      incrementCounter("nominara_topic_cluster_runs_total", { outcome: "project_gone" });
      logger.log({ event: "topic.cluster.project_gone", workspace_id: payload.workspaceId, project_id: payload.projectId });
      return PHASES_DONE;
    }
    const snapshot = await tracer.startActiveSpan("topic.cluster.group", async (span) => {
      try {
        const result = await snapshotClusters(tx, payload.projectId);
        span.setAttributes({ "nominara.topic_cluster.clusterable": result.clusterable, "nominara.topic_cluster.groups": result.groups.length });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
    const matched = matchGroupsToClusters(
      snapshot.groups.map((group) => ({ index: group.index, memberCount: group.memberIds.length, overlaps: group.overlaps })),
      snapshot.olds,
    );
    return { payload, snapshot, matched };
  };

  const run = async (prepared: Prepared): Promise<Fetched> => {
    // A matched cluster keeps its label, so only the new groups are named.
    const labels = new Map<number, ChosenLabel>();
    for (const group of prepared.snapshot.groups) {
      if (prepared.matched.has(group.index)) continue;
      labels.set(group.index, await labelOrFallback(labeller, { prompts: group.samples }));
    }
    return { labels };
  };

  const commit = async (tx: ClientBase, prepared: Prepared, fetched: Fetched): Promise<void> => {
    const { payload, snapshot } = prepared;
    await withProjectQueueLock(tx, TOPIC_CLUSTER_QUEUE, payload.projectId, async () => {
      await tracer.startActiveSpan("topic.cluster.write", async (span) => {
        try {
          // Under the lock: has anything moved since `prepare` read it?
          const now = await promptSetHash(tx, payload.projectId, snapshot.model);
          if (now.hash !== snapshot.promptSetHash) {
            incrementCounter("nominara_topic_cluster_runs_total", { outcome: "stale" });
            throw new TopicClusterStaleError();
          }
          // The cluster state moved (another run committed first) while the prompt set is the same. That does NOT mean the work is
          // done: the set may have changed and changed back, leaving a prompt the other run let go. So plan again, here, under the
          // lock, from what is committed now. Nothing in this branch can be a network call (a transaction is open), so a group with
          // no cluster to inherit is named by the deterministic template.
          let plannedGroups = snapshot.groups;
          let matched = prepared.matched;
          let labels: ReadonlyMap<number, ChosenLabel> = fetched.labels;
          let clusterable = snapshot.clusterable;
          if ((await clusterStateHash(tx, payload.projectId)) !== snapshot.clusterStateHash) {
            const again = await snapshotClusters(tx, payload.projectId);
            if (again.promptSetHash !== snapshot.promptSetHash) {
              incrementCounter("nominara_topic_cluster_runs_total", { outcome: "stale" });
              throw new TopicClusterStaleError();
            }
            incrementCounter("nominara_topic_cluster_runs_total", { outcome: "replanned" });
            logger.log({ event: "topic.cluster.replanned", workspace_id: payload.workspaceId, project_id: payload.projectId });
            plannedGroups = again.groups;
            clusterable = again.clusterable;
            matched = matchGroupsToClusters(
              again.groups.map((group) => ({ index: group.index, memberCount: group.memberIds.length, overlaps: group.overlaps })),
              again.olds,
            );
            // A group with the same members as one named in the run phase keeps that name; any other is named by the template.
            const template = new TemplateTopicLabeller();
            const byMembers = new Map(snapshot.groups.map((group) => [membersKey(group.memberIds), fetched.labels.get(group.index)]));
            const named = new Map<number, ChosenLabel>();
            for (const group of again.groups) {
              if (matched.has(group.index)) continue;
              named.set(group.index, byMembers.get(membersKey(group.memberIds)) ?? (await labelOrFallback(template, { prompts: group.samples })));
            }
            labels = named;
          }

          // A label is only unique against what is committed NOW: a user may have renamed a kept cluster since `run` chose the names. The
          // rows are locked (FOR UPDATE) so a rename in flight is waited for rather than racing the insert into `ux_topic_clusters`.
          const kept = await tx.query<{ label: string }>("SELECT label FROM topic_clusters WHERE project_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE", [
            payload.projectId,
            [...matched.values()],
          ]);
          const taken = new Set(kept.rows.map((row) => row.label.toLowerCase()));

          const sources = { model: 0, template: 0 };
          const plan: ClusterPlanEntry[] = plannedGroups.map((group) => {
            const existing = matched.get(group.index);
            if (existing !== undefined) return { clusterId: existing, memberIds: group.memberIds };
            const chosen = labels.get(group.index) ?? { label: "General questions", source: "template" as const };
            sources[chosen.source] += 1;
            return { clusterId: uuidV7(), memberIds: group.memberIds, newLabel: uniqueLabel(chosen.label, taken) };
          });
          const written = await writeClusters(tx, payload.workspaceId, payload.projectId, snapshot.model, plan);

          const members = plan.flatMap((entry) => entry.memberIds).length;
          const outliers = clusterable - members;
          incrementCounter("nominara_topic_cluster_runs_total", { outcome: "clustered" });
          observeValue("nominara_topic_cluster_clusters_written", plan.length, { reason: payload.reason });
          observeValue("nominara_topic_cluster_outlier_prompts", outliers);
          for (let i = 0; i < sources.model; i += 1) incrementCounter("nominara_topic_cluster_labels_total", { source: "model" });
          for (let i = 0; i < sources.template; i += 1) incrementCounter("nominara_topic_cluster_labels_total", { source: "template" });
          span.setAttributes({ "nominara.topic_cluster.clusters": plan.length, "nominara.topic_cluster.outliers": outliers });
          // Ids and counts only: never a label or a prompt (customer text).
          logger.log({
            event: "topic.cluster.committed",
            workspace_id: payload.workspaceId,
            project_id: payload.projectId,
            reason: payload.reason,
            clusters: plan.length,
            created: written.created,
            removed: written.deleted,
            members,
            outliers,
            model_labels: sources.model,
            template_labels: sources.template,
          });
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      });
    });
  };

  return phasedProcessor<Prepared, Fetched>({ prepare, run, commit });
}
