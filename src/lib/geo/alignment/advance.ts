import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { ValidationFailedError } from "../../../api/errors/domain-errors.js";
import { embedBatchKey, splitIdsIntoJobs, type EmbedTable } from "../../embedding/embed-batch.js";
import type { EnqueueEmbedBatch } from "../../embedding/prompt-embedding-request.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import { buildCorpus } from "../corpus/build-corpus.js";
import type { TokenCounter } from "../corpus/chunker.js";
import { computeCentroid } from "../corpus/centroid.js";
import type { PageFetcher } from "../corpus/page-fetcher.js";
import { analyseNodes } from "./analyse-nodes.js";
import { writeAlignmentAnalysis } from "./analysis.js";
import { computeAlignment } from "./compute.js";
import { ALIGNMENT_JOB } from "./constants.js";
import { extractSemanticNodes } from "./extract-nodes.js";
import { openAlignmentSession } from "./session.js";

// STORY-192 - one STEP of an alignment session, driven by the `geo.analyze` job.
//
// A session cannot be finished in one job: its page, its cited passages and its concepts each need a vector, and `embed.batch` writes those
// asynchronously. So a step does everything that can be done NOW, asks for the vectors it is waiting on, and answers `waiting`; the job
// puts itself back on the queue (delayed) and the next step finds the vectors in. Every step is IDEMPOTENT under at-least-once delivery:
//
//   settled   the session is not `pending` (ready, stale or failed): nothing is read, fetched, embedded or written
//   gone      no such session in this workspace (RLS): nothing happens
//   stale     opened under another embedding model than the provider's. `embed.batch` filters corpus passages by the PROVIDER's model, so
//             the rows this session waits on would never be embedded; it is marked stale with the reason, not left waiting (audit minor)
//   failed    the page could not be fetched, or the vectors did not arrive before the deadline; a short reason code, never an address
//   waiting   something of the scope still lacks a vector. The payload says `pending`; no partial figure is shown as final
//   ready     every vector is in; the figures are final and the analysis is written (ADR-0003: the write is the last, short transaction)
//
// ADR-0003 / KAD-06: the page fetch and the corpus fetches (inside openAlignmentSession / buildCorpus) hold NO transaction; every other
// step is one short tenant transaction handed in by the caller, and an embed request is enqueued only AFTER its transaction committed.

const tracer = trace.getTracer("nominara.geo-alignment");
const logger = new Logger("geo.alignment");

export interface AdvanceDeps {
  readonly workspaceId: string;
  /** Runs `fn` in one tenant-context transaction. Never wrapped around a fetch. */
  readonly runInTx: <T>(fn: (tx: ClientBase) => Promise<T>) => Promise<T>;
  readonly fetchPage: PageFetcher;
  /** STORY-050's cl100k_base counter in production: the embedding model's own tokenizer. */
  readonly tokenizer: TokenCounter;
  /** The SELECTED PROVIDER's model. A session pinned to any other model is stale. */
  readonly providerModel: string;
  readonly enqueueEmbed?: EnqueueEmbedBatch;
  readonly now?: () => Date;
  /**
   * Whether this step fetches the cited pages. Default true. The job sets it only on a session's FIRST step: `buildCorpus` remembers a URL only
   * if it left live passages, so a refused, failed or empty page would be fetched again on every poll for the whole deadline.
   */
  readonly buildCorpus?: boolean;
}

export type AdvanceOutcome = { readonly state: "ready" | "waiting" | "stale" | "failed" | "settled" | "gone"; readonly reason: string | null };

interface SessionRow {
  project_id: string;
  prompt_cluster_id: string | null;
  target_url: string;
  engine_keys: string[];
  embedding_model: string;
  analysis_state: string;
  analysis_reason: string | null;
  fetched: boolean;
  created_at: Date;
  created_by: string | null;
}

export async function advanceAlignmentSession(deps: AdvanceDeps, sessionId: string): Promise<AdvanceOutcome> {
  const started = performance.now();
  return tracer.startActiveSpan("geo.alignment.advance", async (span) => {
    try {
      const outcome = await step(deps, sessionId);
      span.setAttribute("nominara.alignment.state", outcome.state);
      incrementCounter("nominara_geo_alignment_advance_total", { state: outcome.state });
      observeValue("nominara_geo_alignment_advance_seconds", (performance.now() - started) / 1000, { state: outcome.state });
      // The workspace ID and a state: never the URL (it can carry a token), a page's text or the workspace's name.
      logger.log({ event: "geo.alignment.advanced", workspace_id: deps.workspaceId, session_id: sessionId, state: outcome.state, reason: outcome.reason });
      return outcome;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      incrementCounter("nominara_geo_alignment_advance_total", { state: "error" });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** A fetcher reason is a short code; this keeps it inside the column's CHECK whatever a fetcher returns. */
const reasonCode = (text: string): string => text.toLowerCase().replace(/[^a-z0-9_:.-]/g, "_").slice(0, 80) || "unknown";

async function markState(deps: AdvanceDeps, sessionId: string, state: "stale" | "failed", reason: string): Promise<void> {
  await deps.runInTx((tx) =>
    tx.query(
      `UPDATE geo_alignments SET analysis_state = $2, analysis_reason = $3, updated_at = now()
        WHERE id = $1 AND workspace_id = app.current_workspace() AND analysis_state = 'pending'`,
      [sessionId, state, reasonCode(reason)],
    ),
  );
}

async function step(deps: AdvanceDeps, sessionId: string): Promise<AdvanceOutcome> {
  const now = (deps.now ?? (() => new Date()))();

  // ---- 1. read, and decide whether there is anything to do -----------------------------------------------------------------
  const session = await deps.runInTx(async (tx) => {
    const found = await tx.query<SessionRow>(
      `SELECT project_id, prompt_cluster_id, target_url, engine_keys, embedding_model, analysis_state, analysis_reason,
              live_content_md IS NOT NULL AS fetched, created_at, created_by
         FROM geo_alignments WHERE id = $1 AND workspace_id = app.current_workspace()`,
      [sessionId],
    );
    return found.rows[0];
  });
  if (session === undefined) return { state: "gone", reason: null };
  if (session.analysis_state !== "pending") return { state: "settled", reason: session.analysis_reason };

  if (session.embedding_model !== deps.providerModel) {
    await markState(deps, sessionId, "stale", "embedding_model_changed");
    return { state: "stale", reason: "embedding_model_changed" };
  }
  if (now.getTime() - new Date(session.created_at).getTime() > ALIGNMENT_JOB.sessionDeadlineMs) {
    const reason = session.fetched ? "embedding_timeout" : "page_timeout";
    await markState(deps, sessionId, "failed", reason);
    return { state: "failed", reason };
  }

  // ---- 2. the live page: fetched with NO transaction open ---------------------------------------------------------------------
  if (!session.fetched) {
    try {
      await openAlignmentSession(
        { workspaceId: deps.workspaceId, runInTx: deps.runInTx, fetchPage: deps.fetchPage, tokenizer: deps.tokenizer, embeddingModel: session.embedding_model, ...(deps.enqueueEmbed === undefined ? {} : { enqueueEmbed: deps.enqueueEmbed }) },
        { projectId: session.project_id, clusterId: session.prompt_cluster_id, targetUrl: session.target_url, engineKeys: session.engine_keys, createdBy: session.created_by, sessionId },
      );
    } catch (error) {
      if (!(error instanceof ValidationFailedError)) throw error;
      // The page could not be fetched (or the project is gone): there is nothing to align, so the session fails with the fetcher's short code.
      const issue = (error.details as { issues?: { path?: string[]; message?: string }[] } | undefined)?.issues?.[0];
      const reason = issue?.path?.[0] === "project_id" ? "no_such_project" : (issue?.message ?? "page_failed");
      await markState(deps, sessionId, "failed", reason);
      return { state: "failed", reason: reasonCode(reason) };
    }
  }

  // ---- 3. the cited corpus: idempotent (live passages are refreshed, never re-fetched), fetched with NO transaction open. Once per session:
  //         the job asks on the first step only (`buildCorpus`), later steps wait for vectors without touching a third party --------------
  if (session.prompt_cluster_id !== null && deps.buildCorpus !== false) {
    const corpus = await buildCorpus(
      { workspaceId: deps.workspaceId, runInTx: deps.runInTx, fetchPage: deps.fetchPage, tokenizer: deps.tokenizer, embeddingModel: session.embedding_model, ...(deps.enqueueEmbed === undefined ? {} : { enqueueEmbed: deps.enqueueEmbed }), now: () => now },
      { projectId: session.project_id, clusterId: session.prompt_cluster_id },
    );
    // A partial corpus is never hidden: the session's own disclosed source count says how many passages the centroid is made of.
    if (corpus.status === "partial") incrementCounter("nominara_geo_alignment_corpus_partial_total");
  }

  // ---- 4. vectors still missing for the live chunks or the corpus: ask again (a failed enqueue earlier fails open) and wait ------
  const missing = await deps.runInTx(async (tx) => {
    const chunks = await tx.query<{ id: string }>(
      `SELECT c.id FROM content_chunks c JOIN geo_alignments g ON g.id = c.session_id
        WHERE g.id = $1 AND g.workspace_id = app.current_workspace() AND c.workspace_id = app.current_workspace() AND NOT c.is_draft
          AND NOT EXISTS (SELECT 1 FROM content_chunks x
                           WHERE x.workspace_id = app.current_workspace() AND x.content_hash = c.content_hash AND x.is_draft = c.is_draft
                             AND x.embedding_model = g.embedding_model AND x.embedding IS NOT NULL)
        ORDER BY c.id`,
      [sessionId],
    );
    const passages = await tx.query<{ id: string }>(
      `SELECT cp.id FROM corpus_passages cp JOIN geo_alignments g ON g.id = $1
        WHERE g.workspace_id = app.current_workspace() AND cp.workspace_id = app.current_workspace() AND cp.project_id = g.project_id
          AND cp.prompt_cluster_id IS NOT DISTINCT FROM g.prompt_cluster_id AND cp.embedding_model = g.embedding_model
          AND cp.embedding IS NULL AND cp.centroid_weight > 0 AND cp.expires_at > now()
        ORDER BY cp.id`,
      [sessionId],
    );
    return { chunks: chunks.rows.map((r) => r.id), passages: passages.rows.map((r) => r.id) };
  });
  if (missing.chunks.length > 0 || missing.passages.length > 0) {
    await requestEmbeds(deps, "content_chunks", missing.chunks);
    await requestEmbeds(deps, "corpus_passages", missing.passages);
    return { state: "waiting", reason: "vectors_pending" };
  }

  // ---- 5. every chunk and passage has its vector: centroid and live alignment (SQL), then the concepts ------------------------
  await deps.runInTx(async (tx) => {
    await computeCentroid(tx, sessionId);
    await computeAlignment(tx, sessionId);
  });
  await extractSemanticNodes(
    { workspaceId: deps.workspaceId, runInTx: deps.runInTx, ...(deps.enqueueEmbed === undefined ? {} : { enqueueEmbed: deps.enqueueEmbed }) },
    sessionId,
  );

  // ---- 6. analyse the concepts. Pending = a concept lacks its vector: wait. Otherwise finish, and write the analysis, in ONE short transaction
  const finished = await deps.runInTx(async (tx) => {
    const summary = await analyseNodes(tx, sessionId, deps.tokenizer);
    if (!summary.found) return "gone" as const;
    if (summary.pending) {
      const pendingNodes = await pendingNodeIds(tx, sessionId);
      return { pendingNodes };
    }
    const marked = await tx.query(
      `UPDATE geo_alignments SET analysis_state = 'ready', analysis_reason = NULL, updated_at = now()
        WHERE id = $1 AND workspace_id = app.current_workspace() AND analysis_state = 'pending'`,
      [sessionId],
    );
    if ((marked.rowCount ?? 0) === 1) await writeAlignmentAnalysis(tx, sessionId, now);
    return "ready" as const;
  });
  if (finished === "gone") return { state: "gone", reason: null };
  if (finished === "ready") return { state: "ready", reason: null };
  await requestEmbeds(deps, "semantic_nodes", finished.pendingNodes);
  return { state: "waiting", reason: "concepts_pending" };
}

/** The scope's concepts that still lack a vector under the session's model (the ones `embed.batch` is asked for). */
export async function pendingNodeIds(tx: ClientBase, sessionId: string): Promise<string[]> {
  const nodes = await tx.query<{ id: string }>(
    `SELECT n.id FROM semantic_nodes n JOIN geo_alignments g ON g.id = $1
      WHERE n.workspace_id = app.current_workspace() AND g.workspace_id = app.current_workspace() AND n.project_id = g.project_id
        AND n.prompt_cluster_id IS NOT DISTINCT FROM g.prompt_cluster_id AND n.collapsed_into_id IS NULL
        AND (n.embedding IS NULL OR n.embedding_model IS DISTINCT FROM g.embedding_model) ORDER BY n.id`,
    [sessionId],
  );
  return nodes.rows.map((r) => r.id);
}

/** Asks `embed.batch` for the vectors of `ids`, AFTER the transaction that found them closed. Fails open: the rows wait at `embedding IS NULL`. */
export async function requestEmbeds(deps: { readonly workspaceId: string; readonly enqueueEmbed?: EnqueueEmbedBatch }, table: EmbedTable, ids: readonly string[]): Promise<void> {
  if (deps.enqueueEmbed === undefined || ids.length === 0) return;
  for (const batch of splitIdsIntoJobs([...ids])) {
    try {
      await deps.enqueueEmbed("embed.batch", deps.workspaceId, { table, ids: batch }, embedBatchKey(table, batch));
      incrementCounter("nominara_embed_enqueued_total", { producer: "geo_alignment" });
    } catch {
      incrementCounter("nominara_embed_enqueue_failed_total", { producer: "geo_alignment" });
    }
  }
}
