import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase, Pool } from "pg";
import {
  generatePromptsResponseSchema,
  type GeneratePromptsAcceptedResponse,
  type GeneratePromptsRequest,
  type PromptGeneration,
} from "../../../contracts/prompts/index.js";
import { NotFoundError, PreconditionUnmetError } from "../../api/errors/domain-errors.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { failGeneration, promptGenerateKey } from "../../lib/promptgen/generation-job.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { afterCommit, currentTenantStore, withTenantContext } from "../../tenancy/tenant-context.js";

// STORY-045 - `POST /v1/projects/{id}/prompts/generate` and `GET /v1/projects/{id}/prompts/generations/{id}`.
// api-specification.md §5, tracking-engine.md §4; OWNER DECISION 95(a) (2026-11-10): generation is a background job.
//
// OWNS `prompt_generations` (coding-standards.md: one table, one owning service); the pass itself is src/lib/promptgen/, run by the
// `prompt.generate` job (src/lib/queue/handlers/prompt-generate.handler.ts).
//
// THE QUEUE BOUNDARY (KAD-06). Nothing here calls a model or an embedding provider, or waits for one: the request validates, records ONE pending
// row in the ambient transaction and, AFTER the commit, enqueues a signed job and returns 202. That is why this service holds no naturaliser,
// no embedder and no cache any more - the naturaliser and vector dedupe run in the job, outside any transaction (ADR-0003). A failed enqueue is
// compensated (the generation is settled failed(dispatch_failed)), never left pending for ever.
//
// Tenancy: every query runs on the ambient context-carrying client and carries `workspace_id = app.current_workspace()`; RLS is the guarantee.
// The route's `@ProjectParam` guard has already checked the project is inside a scoped caller's scope.

const tracer = trace.getTracer("nominara.prompt-generation-http");
const logger = new Logger("prompts.generation.http");

@Injectable()
export class PromptsService {
  constructor(
    @Optional() @Inject(PG_POOL) private readonly pool?: Pool,
    @Optional() private readonly queues?: QueueProducer,
  ) {}

  /** `POST /v1/projects/{id}/prompts/generate` - records a PENDING generation and queues the job that runs it. Charges nothing, ever. */
  async requestGeneration(projectId: string, request: GeneratePromptsRequest): Promise<GeneratePromptsAcceptedResponse> {
    return tracer.startActiveSpan("prompts.generation.http.request", async (span) => {
      try {
        // BOTH REFUSALS BEFORE ANYTHING IS RECORDED. A caller who asked for something this build cannot do is told so, rather than handed a
        // pointer to a pass that silently did something else.
        this.refuseUnsupported(request);

        const store = currentTenantStore();
        if (store === undefined) throw new Error("PromptsService.requestGeneration requires an active tenant context");
        const tx = store.client;
        const workspaceId = store.context.workspaceId;

        const project = await tx.query<{ id: string }>(
          `SELECT id FROM projects WHERE id = $1 AND workspace_id = app.current_workspace() AND deleted_at IS NULL`,
          [projectId],
        );
        if (project.rows[0] === undefined) throw new NotFoundError({ message: "no such project" });

        const generationId = uuidV7();
        await tx.query(
          `INSERT INTO prompt_generations (id, workspace_id, project_id, status, request)
           VALUES ($1, app.current_workspace(), $2, 'pending', $3::jsonb)`,
          [generationId, projectId, JSON.stringify(request)],
        );

        afterCommit(() => this.dispatch(workspaceId, projectId, generationId));

        incrementCounter("nominara_prompts_generation_requests_total", { outcome: "queued" });
        logger.log({ event: "prompts.generation.requested", workspace_id: workspaceId, project_id: projectId, generation_id: generationId });
        return {
          generation_batch_id: generationId,
          status: "pending" as const,
          poll_url: `/v1/projects/${projectId}/prompts/generations/${generationId}`,
        };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /** `GET /v1/projects/{id}/prompts/generations/{generation_batch_id}` - the status of one pass and, once it succeeded, its result. */
  async readGeneration(projectId: string, generationId: string): Promise<PromptGeneration> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("PromptsService.readGeneration requires an active tenant context");
    const result = await store.client.query<{
      id: string;
      project_id: string;
      status: PromptGeneration["status"];
      result: unknown;
      failure_code: PromptGeneration["failure_code"];
      created_at: Date;
      completed_at: Date | null;
    }>(
      `SELECT id, project_id, status, result, failure_code, created_at, completed_at
         FROM prompt_generations
        WHERE id = $1 AND project_id = $2 AND workspace_id = app.current_workspace()`,
      [generationId, projectId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such prompt generation" });
    return {
      generation_batch_id: row.id,
      project_id: row.project_id,
      status: row.status,
      // Validated on the way out: a stored result that no longer fits the contract fails loudly here, not in a client.
      result: row.result === null ? null : generatePromptsResponseSchema.parse(row.result),
      failure_code: row.failure_code,
      requested_at: new Date(row.created_at).toISOString(),
      completed_at: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    };
  }

  /**
   * The two documented request members this build cannot honour: `422 precondition_unmet` and not a new error code (`error-code.schema.ts` is a
   * closed union). MESSAGE ONLY, no `details` (§2 states none for this code). REFUSED RATHER THAN IGNORED: a caller who set `auto_activate` and
   * received `activated: 0` cannot tell that apart from activation running and selecting nothing.
   */
  private refuseUnsupported(request: GeneratePromptsRequest): void {
    if (request.options?.auto_activate === true) {
      throw new PreconditionUnmetError({
        message: "auto_activate requires prompt activation, which is not implemented yet — STORY-046 owns the cap binding",
      });
    }
    if (request.generation?.strategy === "model_first") {
      throw new PreconditionUnmetError({
        message: "generation.strategy 'model_first' is reserved for custom grammars and is not implemented",
      });
    }
  }

  /** After the commit: sign and enqueue the job. A failure is compensated, counted and logged with the error NAME only. */
  private dispatch(workspaceId: string, projectId: string, generationId: string): void {
    const fail = (error: unknown): Promise<void> => {
      incrementCounter("nominara_prompts_generation_requests_total", { outcome: "dispatch_failed" });
      logger.error({ event: "prompts.generation.dispatch_failed", workspace_id: workspaceId, generation_id: generationId, error: error instanceof Error ? error.name : "unknown" });
      return this.inFreshTx(workspaceId, (tx) => failGeneration(tx, generationId, "dispatch_failed").then(() => undefined)).catch((compensationError: unknown) => {
        logger.error({ event: "prompts.generation.compensation_failed", workspace_id: workspaceId, generation_id: generationId, error: compensationError instanceof Error ? compensationError.name : "unknown" });
      });
    };
    if (this.queues === undefined) {
      void fail(new Error("no queue producer"));
      return;
    }
    void this.queues
      .enqueueTenantJob("prompt.generate", workspaceId, { generationId, projectId }, { idempotencyKey: promptGenerateKey(generationId) })
      .catch(fail);
  }

  private async inFreshTx(workspaceId: string, fn: (tx: ClientBase) => Promise<unknown>): Promise<void> {
    if (this.pool === undefined) return;
    const client = await this.pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, fn);
    } finally {
      client.release();
    }
  }
}
