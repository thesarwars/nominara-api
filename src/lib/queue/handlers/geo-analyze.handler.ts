import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import type { ClientBase } from "pg";
import { geoAnalyzeJobPayloadSchema, geoAnalyzeKey, type GeoAnalyzeJobPayload } from "../../../../contracts/analytics/index.js";
import { SYSTEM_ACTOR_ID } from "../../../tenancy/constants.js";
import { withTenantContext } from "../../../tenancy/tenant-context.js";
import { cl100kTokenizer } from "../../aux/tokenizer-cl100k.js";
import { advanceAlignmentDraft, advanceAlignmentSession, ALIGNMENT_JOB, type AdvanceOutcome, type DraftOutcome } from "../../geo/alignment/index.js";
import { createGuardedPageFetcher, type PageFetcher } from "../../geo/corpus/page-fetcher.js";
import { embedBatchEnqueuerFor, type EnqueueEmbedBatch } from "../../embedding/prompt-embedding-request.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../connection.js";
import type { QueueHandlerContext } from "../handlers.js";
import { QueueProducer } from "../queue-producer.js";
import { signingKeysFromEnv, PHASES_DONE, phasedProcessor, type JobProcessor } from "../worker-factory.js";
import { selectedEmbeddingModel } from "./embed-batch.handler.js";

// STORY-192 - `geo.analyze` for the alignment session: the processor behind POST /geo/alignment and PATCH /geo/alignment/{id}.
//
// ORDER OF TRUST (NFR-SEC-04 / ISO-11). `createJobProcessor` verifies the job's HMAC FIRST - before it acquires a client, before any
// `set_config`, before this file runs - and sets the tenant context from the VERIFIED payload only. The transaction runner this file hands the
// alignment library is `withTenantContext` over a pooled client, bound to that same verified workspace and the SYSTEM actor.
//
// PHASED (ADR-0003 / KAD-06). Fetching the page and the cited corpus, and asking the embedding queue for vectors, are all outside any
// transaction: `prepare` and `commit` here are empty short transactions, and `run` opens its own short ones around each write.
//
// WAITING IS A RE-QUEUE, NOT A SLEEP. A step that finds a vector missing answers `waiting`; the job then queues the next step, delayed, with
// `attempt + 1` in its idempotency key, and ends. No worker slot is held while `embed.batch` works. The session fails at its deadline.
//
// EMBEDDING MODEL. The session is compared with `selectedEmbeddingModel(env)`, the provider's own model; a mismatch is `stale`, never waited on.
//
// IDEMPOTENT under at-least-once delivery: every step of the library is (a re-run of a finished session is `settled`, a re-fetch is cached, a
// re-recompute of an unchanged draft is `idle`), and the re-queue key is per step.

const logger = new Logger("geo.analyze");

/** A chain of re-queues this long is a bug or a runaway, not a slow embed: it stops and is counted. */
const MAX_ATTEMPTS = 500;

export interface GeoAnalyzeDeps {
  /** Test seams: the library steps, the page fetcher and the re-queue. */
  readonly advanceSession?: typeof advanceAlignmentSession;
  readonly advanceDraft?: typeof advanceAlignmentDraft;
  readonly fetchPage?: PageFetcher;
  readonly providerModel?: string;
  readonly enqueueEmbed?: EnqueueEmbedBatch;
  readonly requeue?: (payload: GeoAnalyzeJobPayload, delayMs: number) => Promise<unknown>;
  readonly pool?: Pool;
  readonly now?: () => Date;
}

interface Prepared {
  readonly payload: GeoAnalyzeJobPayload;
}

export function createGeoAnalyzeHandler(context: QueueHandlerContext, deps: GeoAnalyzeDeps = {}): JobProcessor {
  // Built on the first job that needs it: constructing a producer at registration would open a connection in every process that merely imports
  // the registry.
  let producer: QueueProducer | undefined;
  const producerFor = (): QueueProducer =>
    (producer ??= new QueueProducer(createQueueWorkerConnection(context.env.QUEUE_REDIS_URL), queueKeyPrefix(context.env.NODE_ENV), signingKeysFromEnv(context.env)));

  const enqueueEmbed: EnqueueEmbedBatch = deps.enqueueEmbed ?? ((queue, workspaceId, payload, key) => embedBatchEnqueuerFor(producerFor())!(queue, workspaceId, payload, key));
  const requeue =
    deps.requeue ??
    ((payload: GeoAnalyzeJobPayload, delayMs: number) => {
      const { workspaceId: _w, kid: _k, ...rest } = payload;
      return producerFor().enqueueTenantJob("geo.analyze", payload.workspaceId, rest, { idempotencyKey: geoAnalyzeKey(payload), delayMs });
    });

  const runInTxFor = (workspaceId: string) => async <T>(fn: (tx: ClientBase) => Promise<T>): Promise<T> => {
    const client = await (deps.pool ?? context.pool).connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, fn);
    } finally {
      client.release();
    }
  };

  return phasedProcessor<Prepared, AdvanceOutcome | DraftOutcome | "stopped">({
    async prepare(_tx: ClientBase, job: Job) {
      const parsed = geoAnalyzeJobPayloadSchema.safeParse((job.data as { payload: unknown }).payload);
      if (!parsed.success) {
        // Not an alignment job (the queue also carries the daily geo analyses): not this handler's to run, and not a reason to retry.
        incrementCounter("nominara_geo_analyze_jobs_total", { outcome: "unrecognised" });
        logger.warn({ event: "geo.analyze.unrecognised_payload" });
        return PHASES_DONE;
      }
      return { payload: parsed.data };
    },

    async run({ payload }) {
      if (payload.attempt > MAX_ATTEMPTS) {
        incrementCounter("nominara_geo_analyze_jobs_total", { outcome: "attempt_cap" });
        return "stopped" as const;
      }
      const runInTx = runInTxFor(payload.workspaceId);
      if (payload.kind === "alignment_session") {
        const outcome = await (deps.advanceSession ?? advanceAlignmentSession)(
          {
            workspaceId: payload.workspaceId,
            runInTx,
            fetchPage: deps.fetchPage ?? createGuardedPageFetcher(),
            tokenizer: cl100kTokenizer,
            providerModel: deps.providerModel ?? selectedEmbeddingModel(context.env),
            enqueueEmbed,
            ...(deps.now === undefined ? {} : { now: deps.now }),
          },
          payload.sessionId,
        );
        if (outcome.state === "waiting") await requeue({ ...payload, attempt: payload.attempt + 1 }, ALIGNMENT_JOB.pollDelayMs);
        return outcome;
      }
      const outcome = await (deps.advanceDraft ?? advanceAlignmentDraft)(
        { workspaceId: payload.workspaceId, runInTx, tokenizer: cl100kTokenizer, enqueueEmbed, ...(deps.now === undefined ? {} : { now: deps.now }) },
        payload.sessionId,
      );
      if (outcome.state === "waiting") await requeue({ ...payload, attempt: payload.attempt + 1 }, ALIGNMENT_JOB.pollDelayMs);
      // A job that fired before the due time (clock skew, or a later edit moved it) comes back when it IS due. A superseded job has no due time
      // to wait for: the later edit queued its own.
      if (outcome.state === "not_due" && outcome.dueInMs !== null) await requeue({ ...payload, attempt: payload.attempt + 1 }, outcome.dueInMs);
      return outcome;
    },

    async commit(_tx, { payload }, outcome) {
      incrementCounter("nominara_geo_analyze_jobs_total", { outcome: typeof outcome === "string" ? outcome : outcome.state, kind: payload.kind });
    },
  });
}
