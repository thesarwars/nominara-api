import type { Logger } from "@nestjs/common";
import { afterCommit } from "../../tenancy/tenant-context.js";
import type { QueueProducer } from "../queue/queue-producer.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { embedBatchKey, splitIdsIntoJobs } from "./embed-batch.js";

// STORY-133 DECISION 3 - prompt activation is the fourth producer of `embed.batch`.
//
// `tracked_prompts.embedding` is the column L2, generation dedupe and clustering read; a prompt that activates without an embed
// job queued is permanently invisible to all three. So the request is made INSIDE the activation's transaction and the job is
// enqueued AFTER COMMIT (`afterCommit`, the seam auto-top-up uses): a rolled-back activation queues nothing, so there is no
// orphan job, and a committed one always asks.
//
// The handler does the provider call (NFR-ARCH-01) - this file only enqueues and imports no provider. A failed enqueue is logged
// and counted, never thrown: the activation is committed and the customer's request must not fail for an optimisation. The
// prompt stays at `embedding IS NULL`, which L2 treats as "no suppression" (its guard stays), and the next activation or a replay
// asks again.

/** The slice of a tenant client this file needs: the activation services hold a `(sql, params) => rows` shape, not a full pg client. */
export interface EmbeddingRequestClient {
  query: <R>(sql: string, params: unknown[]) => Promise<{ rows: R[] }>;
}

export type EnqueueEmbedBatch = (
  queue: "embed.batch",
  workspaceId: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
) => Promise<unknown>;

/** The enqueue function for a queue producer, or `undefined` when the process has none (the producer is optional). */
export function embedBatchEnqueuerFor(producer: QueueProducer | undefined): EnqueueEmbedBatch | undefined {
  if (producer === undefined) return undefined;
  return (queue, workspaceId, payload, idempotencyKey) => producer.enqueueTenantJob(queue, workspaceId, payload, { idempotencyKey });
}

/**
 * Inside the activation's transaction, AFTER the prompts are written active: queue an embed job for those among `promptIds`
 * that are active and not yet embedded. Returns how many jobs were queued for the commit.
 */
export async function requestPromptEmbeddings(
  tx: EmbeddingRequestClient,
  workspaceId: string,
  promptIds: readonly string[],
  enqueue: EnqueueEmbedBatch,
  logger: Pick<Logger, "log" | "error">,
): Promise<number> {
  if (promptIds.length === 0) return 0;
  const pending = await tx.query<{ id: string }>(
    `SELECT id FROM tracked_prompts
      WHERE embedding IS NULL AND status = 'active' AND deleted_at IS NULL AND id = ANY($1::uuid[])
      ORDER BY id`,
    [[...promptIds]],
  );
  const ids = pending.rows.map((row) => row.id);
  const jobs = splitIdsIntoJobs(ids);
  for (const job of jobs) {
    const key = embedBatchKey("tracked_prompts", job);
    afterCommit(() => {
      void enqueue("embed.batch", workspaceId, { table: "tracked_prompts", ids: job }, key)
        .then(() => {
          incrementCounter("nominara_embed_enqueued_total", { producer: "prompts" });
          logger.log({ event: "embed.batch.enqueued", workspace_id: workspaceId, table: "tracked_prompts", count: job.length });
        })
        .catch((error: unknown) => {
          incrementCounter("nominara_embed_enqueue_failed_total", { producer: "prompts" });
          logger.error({ event: "embed.batch.enqueue_failed", workspace_id: workspaceId, count: job.length, error: error instanceof Error ? error.name : "unknown" });
        });
    });
  }
  return jobs.length;
}
