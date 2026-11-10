import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { ValkeyCacheAdapter } from "../../cache/valkey-cache.adapter.js";
import type { Cache } from "../../cache/cache.port.js";
import type { TextEmbedder } from "../../categories/classify.js";
import type { PromptNaturaliser } from "../../../modules/prompts/ports/naturaliser.js";
import { selectNaturaliser } from "../../../modules/prompts/naturaliser.selector.js";
import { SYSTEM_ACTOR_ID } from "../../../tenancy/constants.js";
import { withTenantContext } from "../../../tenancy/tenant-context.js";
import type { GeneratePass } from "../../promptgen/generate.js";
import {
  buildVectorDedupe,
  commitGeneration,
  failGeneration,
  generationJobPayloadSchema,
  prepareGeneration,
  ProjectGoneError,
  runGeneration,
  templateCacheFor,
  type GenerationPrepared,
  type TenantTx,
} from "../../promptgen/generation-job.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import type { QueueHandlerContext } from "../handlers.js";
import { textEmbedderFor } from "./embed-batch.handler.js";
import { phasedProcessor, type JobProcessor, type PhaseFailure } from "../worker-factory.js";

// STORY-045 / OWNER DECISION 95(a) (2026-11-10) - `prompt.generate`: the background half of POST /v1/projects/{id}/prompts/generate.
//
// A PHASED job (ADR-0003 / KAD-06). The middle of it awaits a model (the naturaliser) and an embedding provider (vector dedupe), so it holds no
// tenant transaction and no pooled connection across either await:
//   prepare  short tenant transaction: claim the generation, read the project and its hashes (src/lib/promptgen/generation-job.ts).
//   run      NO transaction: the pipeline, the naturaliser, the embedder; each vector comparison is a short transaction of its own.
//   commit   short tenant transaction: project lock, hashes re-read, inserts, settled row.
//
// The embedding provider is reached through `textEmbedderFor` (embed-batch.handler.ts), the one module eslint lets import it (NFR-ARCH-01), exactly
// as category classification in crawl.discover does. A request handler never reaches this file.
//
// IDEMPOTENT under at-least-once delivery, and a FAILED generation is settled on the LAST attempt only (an earlier one rides the queue's retry
// ladder). Nothing here charges: there is no wallet, ledger or entitlement statement on any path, failed or not (FR-FAN-01g).

const logger = new Logger("prompt.generate");
const tracer = trace.getTracer("nominara-api");

export interface PromptGenerateDeps {
  /** Injected in tests. Production selects from env on first use (PROMPT_NATURALISER; `none` = the template-only path). */
  readonly naturaliser?: PromptNaturaliser | null;
  /** Injected in tests. Production is the embedding provider the process is configured with. */
  readonly embedder?: TextEmbedder;
  /** Injected in tests. Production opens the Valkey cache on first use, only when a naturaliser will run. */
  readonly cache?: Cache;
}

/**
 * BullMQ increments `attemptsMade` when an attempt fails, so during attempt N it is N-1. An unknown attempt count is ONE attempt (the same default as
 * willBullmqRetry), so a failure always settles the generation rather than leaving it `running`.
 */
function isFinalAttempt(job: Pick<Job, "attemptsMade" | "opts">): boolean {
  const attempts = job.opts?.attempts ?? 1;
  return (job.attemptsMade ?? 0) + 1 >= attempts;
}

export function createPromptGenerateHandler(context: QueueHandlerContext, deps: PromptGenerateDeps = {}): JobProcessor {
  let naturaliser: PromptNaturaliser | null | undefined = deps.naturaliser;
  const naturaliserFor = (): PromptNaturaliser | null => (naturaliser === undefined ? (naturaliser = selectNaturaliser(context.env)) : naturaliser);
  let embedder: TextEmbedder | undefined = deps.embedder;
  const embedderFor = (): TextEmbedder => (embedder ??= textEmbedderFor(context.env));
  let cacheReady: Promise<Cache | null> | undefined;
  const cacheFor = (): Promise<Cache | null> =>
    (cacheReady ??=
      deps.cache !== undefined
        ? Promise.resolve(deps.cache)
        : (async () => {
            // The L5 cache is an optimisation: an unreachable Valkey means "no cache", never a failed generation.
            try {
              const adapter = new ValkeyCacheAdapter(context.env.VALKEY_CACHE_URL);
              await adapter.connect();
              return adapter;
            } catch {
              return null;
            }
          })());

  // One short tenant transaction on a connection that goes straight back to the pool. The signature was verified before `prepare` ran.
  const withTenantTx: TenantTx = async (workspaceId, fn) => {
    const client = await context.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, fn);
    } finally {
      client.release();
    }
  };

  const payloadOf = (job: Job) => generationJobPayloadSchema.parse((job.data as { payload: unknown }).payload);

  return phasedProcessor<GenerationPrepared, GeneratePass>({
    async prepare(tx: ClientBase, job: Job) {
      return tracer.startActiveSpan("prompts.generate.prepare", async (span) => {
        try {
          const payload = payloadOf(job);
          const prepared = await prepareGeneration(tx, payload);
          if (typeof prepared === "symbol") {
            // Settled already (a redelivery), not ours, or the project is gone: nothing to run.
            incrementCounter("nominara_prompts_generation_total", { outcome: "skipped" });
            logger.log({ event: "prompts.generation.skipped", workspace_id: payload.workspaceId, generation_id: payload.generationId });
          }
          return prepared;
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      });
    },

    async run(prepared: GenerationPrepared) {
      return tracer.startActiveSpan("prompts.generate.run", async (span) => {
        const started = Date.now();
        try {
          const useNaturaliser = naturaliserFor();
          const pass = await runGeneration(prepared, {
            naturaliser: useNaturaliser,
            vectorDedupe: buildVectorDedupe(embedderFor(), prepared.projectId, prepared.workspaceId, withTenantTx),
            cache: useNaturaliser === null ? null : await cacheFor().then((cache) => (cache === null ? null : templateCacheFor(cache, prepared.workspaceId, context.env.NODE_ENV))),
          });
          span.setAttribute("nominara.prompts.generated", pass.candidates.length);
          span.setAttribute("nominara.prompts.rejected", pass.rejected.length);
          observeValue("nominara_prompts_generation_run_seconds", (Date.now() - started) / 1000);
          return pass;
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      });
    },

    async commit(tx: ClientBase, prepared: GenerationPrepared, pass: GeneratePass) {
      return tracer.startActiveSpan("prompts.generate.commit", async (span) => {
        try {
          const outcome = await commitGeneration(tx, prepared, pass);
          incrementCounter("nominara_prompts_generation_total", { outcome: outcome === "committed" ? "succeeded" : "already_settled" });
          // IDs and counts only: never prompt text, a brand name or a model answer.
          logger.log({
            event: "prompts.generation.settled",
            workspace_id: prepared.workspaceId,
            project_id: prepared.projectId,
            generation_id: prepared.generationId,
            outcome,
            candidates: pass.candidates.length,
            rejected: pass.rejected.length,
          });
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      });
    },

    // `prepare` commits `running` BEFORE the external calls, so a job that then fails until its attempts run out would leave the generation
    // `running` for ever. On the LAST attempt only (an earlier one is the queue's retry ladder) settle it `failed`; a project deleted
    // mid-flight cannot succeed on a retry and settles at once. Fresh tenant transaction, after signature verification.
    async recover(tx: ClientBase, job: Job, failure: PhaseFailure<GenerationPrepared, GeneratePass>) {
      const gone = failure.error instanceof ProjectGoneError;
      if (!gone && !isFinalAttempt(job)) return false;
      const payload = generationJobPayloadSchema.safeParse((job.data as { payload: unknown }).payload);
      if (!payload.success) return false;
      const settled = await failGeneration(tx, payload.data.generationId, gone ? "project_not_found" : "generation_failed");
      if (settled) incrementCounter("nominara_prompts_generation_total", { outcome: "failed" });
      logger.warn({
        event: "prompts.generation.failed",
        workspace_id: payload.data.workspaceId,
        project_id: payload.data.projectId,
        generation_id: payload.data.generationId,
        phase: failure.phase,
        // The error's NAME only: a message can carry a statement or a fragment of what the model said.
        error: failure.error instanceof Error ? failure.error.name : "unknown",
        settled,
      });
      return true;
    },
  });
}
