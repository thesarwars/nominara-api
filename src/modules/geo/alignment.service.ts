import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase, Pool } from "pg";
import {
  geoAnalyzeKey,
  type AlignmentSessionPayload,
  type CreateAlignmentPatchResponse,
  type GeoAnalyzeJobInput,
  type OpenAlignmentRequest,
  type OpenAlignmentResponse,
  type UpdateAlignmentDraftRequest,
} from "../../../contracts/analytics/index.js";
import { ConflictError, NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { loadEnv } from "../../config/env.js";
import { cl100kTokenizer } from "../../lib/aux/tokenizer-cl100k.js";
import { embedBatchEnqueuerFor } from "../../lib/embedding/prompt-embedding-request.js";
import { ALIGNMENT_JOB, createAlignmentPatch, readSessionPayload, requestEmbeds, saveAlignmentDraft } from "../../lib/geo/alignment/index.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { selectedEmbeddingModel } from "../../lib/queue/handlers/embed-batch.handler.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { incrementCounter, observeValue } from "../../lib/telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { ProjectOutOfScopeException } from "../../tenancy/errors.js";
import { afterCommit, currentTenantStore, withTenantContext } from "../../tenancy/tenant-context.js";
import { AuxService } from "../aux/aux.service.js";

// STORY-192 - the alignment session's HTTP side (api-specification.md "GEO", `optimizer:use`, 0 credits and unlimited). OWNS `geo_alignments`
// and the alignment half of `patches` (coding-standards.md: one table, one owning service); the work itself is `src/lib/geo/alignment/`, run by the
// `geo.analyze` job.
//
// THE QUEUE BOUNDARY (KAD-06). Nothing here fetches a page, calls an embedding provider or an engine, or waits for one: a request writes a row
// (or a draft and its chunks, which is pure CPU) in the ambient transaction and, AFTER the commit, enqueues a signed job and returns. A failed enqueue
// is compensated (the session or draft is marked failed with `dispatch_failed`), never left pending for ever.
//
// Tenancy: every query runs on the ambient context-carrying client; RLS is the filter. The project scope predicate (`app.current_scope_projects()`)
// is the in-depth layer for a scoped manager, as in AuxService. A permission denial is the guard's 403; a session that is not this workspace's is a 404.

const SCOPE_OK = `(cardinality(app.current_scope_projects()) = 0 OR %P% = ANY(app.current_scope_projects()))`;

const tracer = trace.getTracer("nominara.geo-alignment-http");
const logger = new Logger("geo.alignment.http");

interface Actor {
  readonly id: string | null;
}

@Injectable()
export class AlignmentService {
  constructor(
    @Optional() @Inject(PG_POOL) private readonly pool?: Pool,
    @Optional() private readonly queues?: QueueProducer,
    @Optional() private readonly aux?: AuxService,
  ) {}

  /** `POST /v1/geo/alignment` - opens a PENDING session and queues the job that advances it. Charges nothing. */
  async open(body: OpenAlignmentRequest, actor: Actor): Promise<OpenAlignmentResponse> {
    return tracer.startActiveSpan("geo.alignment.http.open", async (span) => {
      try {
        const store = currentTenantStore()!;
        const tx = store.client;
        const workspaceId = store.context.workspaceId;

        const project = await tx.query<{ in_scope: boolean }>(
          `SELECT ${SCOPE_OK.replace("%P%", "id")} AS in_scope FROM projects WHERE id = $1 AND workspace_id = app.current_workspace() AND deleted_at IS NULL`,
          [body.project_id],
        );
        if (project.rows[0] === undefined) throw new NotFoundError({ message: "no such project" });
        if (!project.rows[0].in_scope) throw new ProjectOutOfScopeException();

        const cluster = await tx.query("SELECT 1 FROM topic_clusters WHERE id = $1 AND project_id = $2 AND workspace_id = app.current_workspace()", [body.prompt_cluster_id, body.project_id]);
        if (cluster.rows.length === 0) {
          throw new ValidationFailedError({ message: "no such topic cluster in this project", details: { issues: [{ path: ["prompt_cluster_id"], message: "no such topic cluster in this project" }] } });
        }

        const engines = await tx.query<{ engine_key: string }>("SELECT engine_key FROM project_engines WHERE project_id = $1 AND workspace_id = app.current_workspace() AND enabled ORDER BY engine_key", [body.project_id]);
        const sessionId = uuidV7();
        await tx.query(
          `INSERT INTO geo_alignments (id, workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model, created_by, analysis_state)
           VALUES ($1, app.current_workspace(), $2, $3, $4, $5::text[], $6, $7, 'pending')`,
          [sessionId, body.project_id, body.target_url, body.prompt_cluster_id, engines.rows.map((row) => row.engine_key), selectedEmbeddingModel(loadEnv()), actor.id],
        );

        const job: GeoAnalyzeJobInput = { kind: "alignment_session", projectId: body.project_id, sessionId, attempt: 0 };
        afterCommit(() => this.dispatch(workspaceId, job, 0, () => this.failSession(workspaceId, sessionId)));

        incrementCounter("nominara_geo_alignment_requests_total", { route: "open", outcome: "queued" });
        logger.log({ event: "geo.alignment.opened", workspace_id: workspaceId, project_id: body.project_id, session_id: sessionId });
        return { session_id: sessionId, status: "pending" as const, poll_url: `/v1/geo/alignment/${sessionId}`, credits_charged: 0 as const };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /** `GET /v1/geo/alignment/{id}` - the payload (§8). Reads rows only: nothing is computed, fetched or embedded here. */
  async get(sessionId: string): Promise<AlignmentSessionPayload> {
    const tx = currentTenantStore()!.client;
    await this.assertVisible(tx, sessionId);
    incrementCounter("nominara_geo_alignment_requests_total", { route: "get", outcome: "ok" });
    return readSessionPayload(tx, sessionId);
  }

  /**
   * `PATCH /v1/geo/alignment/{id}` - stores the draft and queues the DEBOUNCED recompute. The recompute is in the database and free; this request
   * only writes the draft and its chunks (pure CPU), so it answers within the objective whatever the draft's size. Its latency is observed on
   * `nominara_geo_alignment_draft_request_seconds` against the 200 ms p95 objective.
   */
  async updateDraft(sessionId: string, body: UpdateAlignmentDraftRequest): Promise<AlignmentSessionPayload> {
    const started = performance.now();
    return tracer.startActiveSpan("geo.alignment.http.update_draft", async (span) => {
      try {
        const store = currentTenantStore()!;
        const tx = store.client;
        const workspaceId = store.context.workspaceId;
        const session = await this.assertVisible(tx, sessionId);
        // A draft is measured against the finished live analysis: while that is still pending (or stale or failed) there is nothing to measure it against.
        if (session.analysis_state !== "ready") {
          throw new ConflictError({ message: "the session is not ready: a draft can be saved once its analysis is final", details: { current_state: session.analysis_state } });
        }
        const saved = await saveAlignmentDraft(tx, cl100kTokenizer, sessionId, body.draft_content_md, ALIGNMENT_JOB.draftDebounceMs);

        const job: GeoAnalyzeJobInput = { kind: "alignment_draft", projectId: session.project_id, sessionId, attempt: 0, dueAt: saved.dueText };
        const enqueueEmbed = embedBatchEnqueuerFor(this.queues);
        afterCommit(() => {
          // The draft's vectors are asked for at once so they are usually in by the time the debounce window closes; failing open is fine, the job asks again.
          void requestEmbeds({ workspaceId, ...(enqueueEmbed === undefined ? {} : { enqueueEmbed }) }, "content_chunks", saved.chunkIds);
          this.dispatch(workspaceId, job, ALIGNMENT_JOB.draftDebounceMs, () => this.failDraft(workspaceId, sessionId, saved.dueText));
        });

        incrementCounter("nominara_geo_alignment_requests_total", { route: "update_draft", outcome: "queued" });
        const payload = await readSessionPayload(tx, sessionId);
        observeValue("nominara_geo_alignment_draft_request_seconds", (performance.now() - started) / 1000);
        logger.log({ event: "geo.alignment.draft_saved", workspace_id: workspaceId, session_id: sessionId, chunks: saved.chunkIds.length });
        return payload;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /** `POST /v1/geo/alignment/{id}/patch` - an immutable copy-ready patch, cut from the measured draft. Free. */
  async createPatch(sessionId: string, actor: Actor): Promise<CreateAlignmentPatchResponse> {
    const tx = currentTenantStore()!.client;
    await this.assertVisible(tx, sessionId);
    const patchId = await createAlignmentPatch(tx, sessionId, actor.id);
    incrementCounter("nominara_geo_alignment_requests_total", { route: "patch", outcome: "created" });
    if (this.aux === undefined) throw new Error("AlignmentService: the AUX patch reader is not wired");
    return this.aux.getPatch(patchId);
  }

  /** The 404 (RLS makes a foreign session absent) and the scope refusal, in one read. Returns what the callers need next. */
  private async assertVisible(tx: ClientBase, sessionId: string): Promise<{ project_id: string; analysis_state: string }> {
    const found = await tx.query<{ project_id: string; analysis_state: string; in_scope: boolean }>(
      `SELECT project_id, analysis_state, ${SCOPE_OK.replace("%P%", "project_id")} AS in_scope FROM geo_alignments WHERE id = $1 AND workspace_id = app.current_workspace()`,
      [sessionId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such alignment session" });
    if (!row.in_scope) throw new ProjectOutOfScopeException();
    return row;
  }

  /** After the commit: sign and enqueue the job. A failure is compensated, counted and logged with the error NAME only. */
  private dispatch(workspaceId: string, job: GeoAnalyzeJobInput, delayMs: number, compensate: () => Promise<void>): void {
    const queues = this.queues;
    const fail = (error: unknown): Promise<void> => {
      incrementCounter("nominara_geo_alignment_requests_total", { route: job.kind, outcome: "dispatch_failed" });
      logger.error({ event: "geo.alignment.dispatch_failed", workspace_id: workspaceId, session_id: job.sessionId, error: error instanceof Error ? error.name : "unknown" });
      return compensate().catch((compensationError: unknown) => {
        logger.error({ event: "geo.alignment.compensation_failed", workspace_id: workspaceId, session_id: job.sessionId, error: compensationError instanceof Error ? compensationError.name : "unknown" });
      });
    };
    if (queues === undefined) {
      void fail(new Error("no queue producer"));
      return;
    }
    void queues
      .enqueueTenantJob("geo.analyze", workspaceId, { ...job }, { idempotencyKey: geoAnalyzeKey(job), ...(delayMs > 0 ? { delayMs } : {}) })
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

  private failSession(workspaceId: string, sessionId: string): Promise<void> {
    return this.inFreshTx(workspaceId, (tx) =>
      tx.query(
        `UPDATE geo_alignments SET analysis_state = 'failed', analysis_reason = 'dispatch_failed', updated_at = now()
          WHERE id = $1 AND workspace_id = app.current_workspace() AND analysis_state = 'pending'`,
        [sessionId],
      ),
    );
  }

  /** Only the draft this request saved: a later edit (a later due time) has its own job and is left alone. */
  private failDraft(workspaceId: string, sessionId: string, dueText: string): Promise<void> {
    return this.inFreshTx(workspaceId, (tx) =>
      tx.query(
        `UPDATE geo_alignments SET draft_state = 'failed', draft_recompute_due_at = NULL, updated_at = now()
          WHERE id = $1 AND workspace_id = app.current_workspace() AND draft_state = 'pending' AND draft_recompute_due_at::text = $2`,
        [sessionId, dueText],
      ),
    );
  }
}
