import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import type { ClientBase } from "pg";
import { Redis } from "ioredis";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { geoAnalyzeJobPayloadSchema, geoAnalyzeKey, nameMatchJudgeJobPayloadSchema, type GeoAnalyzeJobPayload } from "../../../../contracts/analytics/index.js";
import { SYSTEM_ACTOR_ID } from "../../../tenancy/constants.js";
import { withTenantContext } from "../../../tenancy/tenant-context.js";
import { cl100kTokenizer } from "../../aux/tokenizer-cl100k.js";
import { advanceAlignmentDraft, advanceAlignmentSession, ALIGNMENT_JOB, failStrandedDraft, failStrandedSession, type AdvanceOutcome, type DraftOutcome } from "../../geo/alignment/index.js";
import { createGuardedPageFetcher, type PageFetcher } from "../../geo/corpus/page-fetcher.js";
import { embedBatchEnqueuerFor, type EnqueueEmbedBatch } from "../../embedding/prompt-embedding-request.js";
import { commitJudging, prepareJudging, runJudging, type EngineBucketPort, type JudgingPrepared, type JudgingResult } from "../../geo/name-match-judge/judging.js";
import type { NameMatchJudge } from "../../geo/name-match-judge/port.js";
import { selectNameMatchJudge } from "../../geo/name-match-judge/select.js";
import { geminiPacingConfig } from "../../engines/engine-lease.js";
import { TokenBucket } from "../../engines/token-bucket.js";
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
// STORY-191 (owner decision 99c) - the same queue carries ONE more job, `name_match_judge`: it judges a project's ambiguous brand-name matches with a model,
// as a phased job of its own kind (src/lib/geo/name-match-judge/judging.ts): `prepare` reads the matches and the month's remaining budget in a short tenant
// transaction, `run` calls the model with NO transaction and NO pooled client (each call takes a token from the gemini engine bucket), `commit` stores the
// verdicts in a second short one. Its producer is the daily rollup, after its commit, and only when a model judge is configured.
//
// IDEMPOTENT under at-least-once delivery: every step of the library is (a re-run of a finished session is `settled`, the corpus is built on the first step only, a
// re-recompute of an unchanged draft is `idle`), and the re-queue key is per step.

const logger = new Logger("geo.analyze");
const tracer = trace.getTracer("nominara.geo-analyze");

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
  /** STORY-191 test seams: the model judge (production selects it from env) and the engine bucket (production is the cache Valkey's). */
  readonly judge?: NameMatchJudge | null;
  readonly bucket?: EngineBucketPort;
  readonly monthlyCap?: number;
}

type Prepared =
  | { readonly kind: "alignment"; readonly payload: GeoAnalyzeJobPayload }
  | { readonly kind: "name_match"; readonly workspaceId: string; readonly projectId: string; readonly judge: NameMatchJudge; readonly work: JudgingPrepared };

type Ran = AdvanceOutcome | DraftOutcome | "stopped" | JudgingResult;

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

  // The model judge and its bucket are built on the first judging job: constructing them at registration would open a connection in every process that
  // merely imports the registry.
  let judgeChosen: NameMatchJudge | null | undefined = deps.judge;
  const judgeFor = (): NameMatchJudge | null => (judgeChosen === undefined ? (judgeChosen = selectNameMatchJudge(context.env)) : judgeChosen);
  let bucketOpen: EngineBucketPort | undefined = deps.bucket;
  const bucketFor = (): EngineBucketPort => {
    if (bucketOpen === undefined) {
      // The cache instance (STORY-031 D6), over a connection that rejects rather than blocks; TokenBucket fails OPEN on a store error (D19).
      const redis = new Redis(context.env.VALKEY_CACHE_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
      redis.on("error", () => undefined);
      const bucket = new TokenBucket(redis);
      const config = geminiPacingConfig(context.env.GEMINI_REQUESTS_PER_MINUTE);
      bucketOpen = { tryAcquire: () => bucket.tryAcquire("gemini", config) };
    }
    return bucketOpen;
  };

  return phasedProcessor<Prepared, Ran>({
    async prepare(tx: ClientBase, job: Job) {
      const rawPayload = (job.data as { payload: unknown }).payload;
      const judging = nameMatchJudgeJobPayloadSchema.safeParse(rawPayload);
      if (judging.success) {
        return tracer.startActiveSpan("geo.name_match_judge.prepare", async (span) => {
          try {
            const judge = judgeFor();
            // The job judges under the judge THIS process is configured with. A job queued for another version (the model was changed, or unbound) is a no-op:
            // the new judge's own job is queued by the next rollup.
            if (judge === null || judge.version !== judging.data.judgeVersion) {
              incrementCounter("nominara_geo_name_match_judge_jobs_total", { outcome: "judge_mismatch" });
              return PHASES_DONE;
            }
            const work = await prepareJudging(tx, {
              projectId: judging.data.projectId,
              judgeVersion: judge.version,
              judgeModel: judge.model,
              ...(deps.monthlyCap === undefined ? {} : { monthlyCap: deps.monthlyCap }),
            });
            if (work === null) {
              incrementCounter("nominara_geo_name_match_judge_jobs_total", { outcome: "nothing_to_judge" });
              return PHASES_DONE;
            }
            return { kind: "name_match" as const, workspaceId: judging.data.workspaceId, projectId: judging.data.projectId, judge, work };
          } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            span.end();
          }
        });
      }
      const parsed = geoAnalyzeJobPayloadSchema.safeParse(rawPayload);
      if (!parsed.success) {
        // Not an alignment job (the queue also carries the daily geo analyses): not this handler's to run, and not a reason to retry.
        incrementCounter("nominara_geo_analyze_jobs_total", { outcome: "unrecognised" });
        logger.warn({ event: "geo.analyze.unrecognised_payload" });
        return PHASES_DONE;
      }
      return { kind: "alignment" as const, payload: parsed.data };
    },

    async run(prepared) {
      if (prepared.kind === "name_match") {
        return tracer.startActiveSpan("geo.name_match_judge.run", async (span) => {
          try {
            // NO transaction and NO pooled client in here: the model is awaited with neither held (ADR-0003).
            const result = await runJudging(prepared.work, { judge: prepared.judge, bucket: bucketFor() });
            span.setAttributes({ "nominara.name_match_judge.judged": result.verdicts.length, "nominara.name_match_judge.deferred": result.deferred });
            return result;
          } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            span.end();
          }
        });
      }
      const { payload } = prepared;
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
            // The cited pages are fetched ONCE per session, on its first step: a refused or failed page leaves no row to remember it by, so
            // every later step only looks for vectors (and the third party is not asked again every few seconds for the whole deadline).
            buildCorpus: payload.attempt === 0,
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

    // A step that failed on its LAST retry has no further job to enforce its deadline: the row is settled here, in a fresh tenant transaction, so a
    // session (or the draft this job belongs to) is never left pending behind a spent retry ladder. An earlier failure goes to the ladder untouched.
    async recover(tx, job, failure) {
      const attempts = job.opts?.attempts;
      if (attempts === undefined || (job.attemptsMade ?? 0) + 1 < attempts) return false;
      // A judging job has nothing to settle: it is idempotent and a retry re-reads what is still unjudged.
      const parsed = (failure.prepared?.kind === "alignment" ? failure.prepared.payload : undefined) ?? geoAnalyzeJobPayloadSchema.safeParse((job.data as { payload: unknown }).payload).data;
      if (parsed === undefined) return false;
      incrementCounter("nominara_geo_analyze_jobs_total", { outcome: "retries_exhausted", kind: parsed.kind });
      logger.error({ event: "geo.analyze.retries_exhausted", workspace_id: parsed.workspaceId, session_id: parsed.sessionId, kind: parsed.kind, error: failure.error instanceof Error ? failure.error.name : "unknown" });
      if (parsed.kind === "alignment_session") await failStrandedSession(tx, parsed.sessionId, "job_failed");
      else await failStrandedDraft(tx, parsed.sessionId, parsed.dueAt);
      return true;
    },

    async commit(tx, prepared, outcome) {
      if (prepared.kind === "name_match") {
        const result = outcome as JudgingResult;
        const written = await commitJudging(tx, prepared.work, result);
        incrementCounter("nominara_geo_name_match_judge_jobs_total", { outcome: result.bucketDenied ? "bucket_denied" : result.failedBatches > 0 ? "partial" : "judged" });
        // IDs and counts only: never the span, its window, the alias or a model answer.
        logger.log({
          event: "geo.name_match_judge.settled",
          workspace_id: prepared.workspaceId,
          project_id: prepared.projectId,
          judge_version: prepared.work.judgeVersion,
          judged: result.verdicts.length,
          written,
          deferred: result.deferred,
          model_calls: result.modelCalls,
          failed_batches: result.failedBatches,
          bucket_denied: result.bucketDenied,
        });
        return;
      }
      const { payload } = prepared;
      incrementCounter("nominara_geo_analyze_jobs_total", { outcome: typeof outcome === "string" ? outcome : "state" in outcome ? outcome.state : "judged", kind: payload.kind });
    },
  });
}
