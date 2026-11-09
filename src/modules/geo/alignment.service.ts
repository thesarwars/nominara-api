import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase, Pool } from "pg";
import {
  ALIGNMENT_TARGETS_MAX_DOMAINS,
  ALIGNMENT_TARGETS_MAX_PAGES,
  ALIGNMENT_TARGETS_MAX_SESSIONS,
  geoAnalyzeKey,
  type AlignmentPageSource,
  type AlignmentTargetsQuery,
  type AlignmentTargetsResponse,
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
import { ALIGNMENT_JOB, createAlignmentPatch, readSessionPayload, saveAlignmentDraft, settleOverdue } from "../../lib/geo/alignment/index.js";
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

  /**
   * `GET /v1/geo/alignment/targets` - what a session can be opened on: the project's topic clusters, its candidate pages and the newest session per
   * (page, cluster). Reads rows only (no fetch, no embedding, no write), so it is a plain tenant read. A page's TEXT is not returned: the specification
   * stores it only on a session after the worker fetched it, and nothing here may fetch (KAD-06).
   */
  async targets(query: AlignmentTargetsQuery): Promise<AlignmentTargetsResponse> {
    return tracer.startActiveSpan("geo.alignment.http.targets", async (span) => {
      try {
        const store = currentTenantStore()!;
        const tx = store.client;
        const projectId = query.project_id;

        const project = await tx.query<{ in_scope: boolean }>(
          `SELECT ${SCOPE_OK.replace("%P%", "id")} AS in_scope FROM projects WHERE id = $1 AND workspace_id = app.current_workspace() AND deleted_at IS NULL`,
          [projectId],
        );
        if (project.rows[0] === undefined) throw new NotFoundError({ message: "no such project" });
        if (!project.rows[0].in_scope) throw new ProjectOutOfScopeException();

        const clusters = await tx.query<{ cluster_id: string; label: string; prompt_count: number }>(
          "SELECT id AS cluster_id, label, prompt_count::int AS prompt_count FROM topic_clusters WHERE project_id = $1 AND workspace_id = app.current_workspace() ORDER BY label, id",
          [projectId],
        );

        // Candidate pages, each with every place it came from. Rank orders the sources (1 root, 2 session, 3 audit); a page that is the root sorts first.
        // A site file (robots.txt, llms.txt, a sitemap) is an audit's subject but not a page whose content can be aligned.
        const pages = await tx.query<{ target_url: string; ranks: number[] }>(
          `WITH cand AS (
             SELECT root_url AS url, 1 AS rank FROM projects WHERE id = $1 AND workspace_id = app.current_workspace()
             UNION ALL
             SELECT target_url, 2 FROM geo_alignments WHERE project_id = $1 AND workspace_id = app.current_workspace()
             UNION ALL
             SELECT url, 3 FROM aux_findings
              WHERE project_id = $1 AND workspace_id = app.current_workspace() AND url ~* '^https?://'
                AND url !~* '/(robots\\.txt|llms(-full)?\\.txt|sitemap[^/]*\\.xml)([?#].*)?$'
           )
           SELECT url AS target_url, array_agg(DISTINCT rank ORDER BY rank) AS ranks
             FROM cand GROUP BY url
            ORDER BY min(rank), url
            LIMIT $2`,
          [projectId, ALIGNMENT_TARGETS_MAX_PAGES],
        );
        const sourceOf: readonly AlignmentPageSource[] = ["project_root", "alignment_session", "aux_audit"];

        const sessions = await tx.query<{
          session_id: string; target_url: string; cluster_id: string | null; status: "pending" | "ready" | "stale" | "failed";
          baseline: number | null; band_low: number | null; band_high: number | null; percentile: number | null; coverage: number | null; updated_at: Date;
        }>(
          `SELECT * FROM (
             SELECT DISTINCT ON (target_url, prompt_cluster_id)
                    id AS session_id, target_url, prompt_cluster_id AS cluster_id, analysis_state AS status,
                    baseline_alignment AS baseline, target_band_low AS band_low, target_band_high AS band_high,
                    percentile_vs_corpus::int AS percentile, coverage_ratio AS coverage, updated_at
               FROM geo_alignments
              WHERE project_id = $1 AND workspace_id = app.current_workspace()
              ORDER BY target_url, prompt_cluster_id, updated_at DESC, id DESC
           ) newest ORDER BY updated_at DESC, session_id DESC LIMIT $2`,
          [projectId, ALIGNMENT_TARGETS_MAX_SESSIONS],
        );

        const corpus = await tx.query<{ passages: number }>(
          "SELECT count(*)::int AS passages FROM corpus_passages WHERE project_id = $1 AND workspace_id = app.current_workspace() AND expires_at > now()",
          [projectId],
        );
        const domains = await tx.query<{ domain: string }>(
          "SELECT DISTINCT domain FROM corpus_passages WHERE project_id = $1 AND workspace_id = app.current_workspace() AND expires_at > now() ORDER BY domain LIMIT $2",
          [projectId, ALIGNMENT_TARGETS_MAX_DOMAINS],
        );

        incrementCounter("nominara_geo_alignment_requests_total", { route: "targets", outcome: "ok" });
        logger.log({ event: "geo.alignment.targets_read", workspace_id: store.context.workspaceId, project_id: projectId, clusters: clusters.rows.length, pages: pages.rows.length });
        return {
          project_id: projectId,
          clusters: clusters.rows,
          pages: pages.rows.map((row) => ({ target_url: row.target_url, sources: row.ranks.map((rank) => sourceOf[rank - 1]!) })),
          // A figure belongs to a session only once it is `ready`: a pending one's columns are not final, and an unmeasured one is null, never 0.
          sessions: sessions.rows.map((row) => {
            const ready = row.status === "ready";
            return {
              session_id: row.session_id,
              target_url: row.target_url,
              cluster_id: row.cluster_id,
              status: row.status,
              alignment: ready ? row.baseline : null,
              target_band: ready && row.band_low !== null && row.band_high !== null ? ([row.band_low, row.band_high] as [number, number]) : null,
              percentile_vs_cited_docs: ready ? row.percentile : null,
              coverage_ratio: ready ? row.coverage : null,
              updated_at: row.updated_at.toISOString(),
            };
          }),
          corpus: { passages: corpus.rows[0]?.passages ?? 0, domains: domains.rows.map((row) => row.domain) },
          credits_charged: 0 as const,
        };
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
    // A session (or draft) still pending long past its deadline has lost its job: it is failed here, so the client never polls a row nothing will settle.
    await settleOverdue(tx, sessionId);
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
        // A draft is embedded by the provider's CURRENT model; a session pinned to another one could never find those vectors, so say so now.
        if (session.embedding_model !== selectedEmbeddingModel(loadEnv())) {
          throw new ConflictError({ message: "embedding_model_changed: the session was analysed under another embedding model, so a draft cannot be measured against it; open a new session", details: { current_state: session.analysis_state } });
        }
        const saved = await saveAlignmentDraft(tx, cl100kTokenizer, sessionId, body.draft_content_md, ALIGNMENT_JOB.draftDebounceMs);

        const job: GeoAnalyzeJobInput = { kind: "alignment_draft", projectId: session.project_id, sessionId, attempt: 0, dueAt: saved.dueText };
        // Nothing is embedded here: the vectors are asked for by the DEBOUNCED job, once, for the chunks that have none, so a burst of edits is one request.
        afterCommit(() => this.dispatch(workspaceId, job, ALIGNMENT_JOB.draftDebounceMs, () => this.failDraft(workspaceId, sessionId, saved.dueText)));

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
  private async assertVisible(tx: ClientBase, sessionId: string): Promise<{ project_id: string; analysis_state: string; embedding_model: string }> {
    const found = await tx.query<{ project_id: string; analysis_state: string; embedding_model: string; in_scope: boolean }>(
      `SELECT project_id, analysis_state, embedding_model, ${SCOPE_OK.replace("%P%", "project_id")} AS in_scope FROM geo_alignments WHERE id = $1 AND workspace_id = app.current_workspace()`,
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
