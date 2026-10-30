import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { ValidationFailedError } from "../../../api/errors/domain-errors.js";
import { embedBatchKey, splitIdsIntoJobs } from "../../embedding/embed-batch.js";
import type { EnqueueEmbedBatch } from "../../embedding/prompt-embedding-request.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { chunkDocument, type TokenCounter } from "../corpus/chunker.js";
import type { PageFetcher } from "../corpus/page-fetcher.js";
import { extractReadable } from "../corpus/readable.js";

// STORY-059 AC2 - open an alignment session for ONE URL and ONE cluster: fetch and chunk the LIVE page and ask for its chunks'
// vectors.
//
// THE SHAPE of STORY-058's corpus build, for the same reason (ADR-0003, NFR-ARCH-04):
//   1. fetch    (NO transaction, NO pooled connection)  the page through the guarded fetcher, readable extraction, chunking.
//   2. write    (one short tenant transaction)          the session and its chunks.
//   3. enqueue  (after the commit)                      embed.batch for the chunks. A failed enqueue FAILS OPEN (owner decision 7).
//
// A page the guard refuses, or that fails, opens NO session: there is nothing to align, and a session over no content would report a
// measured-looking nothing. The reason is a short code, never the address (a refused fetch's message can carry one).
//
// The session pins `embedding_model` (the corpus and the centroid are read under it), and a chunk is stored WITHOUT a vector or a
// model: embed.batch writes both together.
//
// WIRING. This is a library with no production caller yet: the route, its permission and the job processor that binds a tenant
// transaction (after verifying the job's HMAC), the provider's model, STORY-050's cl100k counter and the guarded fetcher are the
// follow-up the story report lists.

const tracer = trace.getTracer("nominara.geo-alignment");
const logger = new Logger("geo.alignment");

export interface AlignmentDeps {
  readonly workspaceId: string;
  /** Runs `fn` in one tenant-context transaction. Called once per step, never around the page fetch. */
  readonly runInTx: <T>(fn: (tx: ClientBase) => Promise<T>) => Promise<T>;
  readonly fetchPage: PageFetcher;
  readonly tokenizer: TokenCounter;
  /** The pinned model the session, its corpus and its centroid are read under. */
  readonly embeddingModel: string;
  readonly enqueueEmbed?: EnqueueEmbedBatch;
}

export interface OpenSessionInput {
  readonly projectId: string;
  readonly clusterId: string | null;
  readonly targetUrl: string;
  readonly engineKeys: readonly string[];
  readonly createdBy: string | null;
}

export interface OpenSessionResult {
  readonly sessionId: string;
  readonly chunks: number;
  readonly embedJobs: number;
  readonly embedEnqueueFailures: number;
}

export async function openAlignmentSession(deps: AlignmentDeps, input: OpenSessionInput): Promise<OpenSessionResult> {
  return tracer.startActiveSpan("geo.alignment.open_session", async (span) => {
    try {
      const result = await run(deps, input);
      span.setAttributes({ "nominara.alignment.chunks": result.chunks });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

const hashOf = (text: string): Buffer => createHash("sha256").update(text.replace(/\s+/g, " ").trim(), "utf8").digest();

async function run(deps: AlignmentDeps, input: OpenSessionInput): Promise<OpenSessionResult> {
  const page = await deps.fetchPage(input.targetUrl);
  if (page.kind !== "html") {
    incrementCounter("nominara_geo_alignment_sessions_total", { outcome: page.kind });
    throw new ValidationFailedError({
      message: "the page could not be fetched, so there is nothing to align",
      details: { issues: [{ path: ["target_url"], message: `page_${page.kind}:${page.reason}` }] },
    });
  }
  const markdown = extractReadable(page.html);
  const chunks = chunkDocument(markdown, deps.tokenizer);

  const written = await deps.runInTx(async (tx) => {
    const session = await tx.query<{ id: string }>(
      `INSERT INTO geo_alignments (workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model, live_content_md, created_by)
       SELECT p.workspace_id, p.id, $2, $3, $4::text[], $5, $6, $7
         FROM projects p WHERE p.id = $1 AND p.workspace_id = app.current_workspace() AND p.deleted_at IS NULL
       RETURNING id`,
      [input.projectId, input.targetUrl, input.clusterId, [...input.engineKeys], deps.embeddingModel, markdown, input.createdBy],
    );
    const sessionId = session.rows[0]?.id;
    if (sessionId === undefined) throw new ValidationFailedError({ message: "no such project", details: { issues: [{ path: ["project_id"], message: "no such project" }] } });
    if (chunks.length === 0) return { sessionId, ids: [] as string[] };
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO content_chunks (workspace_id, project_id, session_id, url, chunk_index, text, token_count, content_hash, is_draft)
       SELECT app.current_workspace(), $1, $2, $3, v.idx, v.text, v.tc, decode(v.ch, 'hex'), false
         FROM unnest($4::int[], $5::text[], $6::int[], $7::text[]) AS v(idx, text, tc, ch)
       RETURNING id`,
      [input.projectId, sessionId, input.targetUrl, chunks.map((c) => c.index), chunks.map((c) => c.text), chunks.map((c) => c.tokenCount), chunks.map((c) => hashOf(c.text).toString("hex"))],
    );
    return { sessionId, ids: inserted.rows.map((row) => row.id).sort() };
  });

  let embedJobs = 0;
  let embedEnqueueFailures = 0;
  if (deps.enqueueEmbed !== undefined) {
    for (const ids of splitIdsIntoJobs(written.ids)) {
      try {
        await deps.enqueueEmbed("embed.batch", deps.workspaceId, { table: "content_chunks", ids }, embedBatchKey("content_chunks", ids));
        embedJobs += 1;
        incrementCounter("nominara_embed_enqueued_total", { producer: "geo_alignment" });
      } catch {
        // FAIL OPEN: the chunks are committed and wait at `embedding IS NULL`.
        embedEnqueueFailures += 1;
        incrementCounter("nominara_embed_enqueue_failed_total", { producer: "geo_alignment" });
      }
    }
  }

  incrementCounter("nominara_geo_alignment_sessions_total", { outcome: "opened" });
  // Workspace ID and a count: no URL (the customer's own, but a URL can carry a token), no page text.
  logger.log({ event: "geo.alignment.session_opened", workspace_id: deps.workspaceId, chunks: chunks.length, embed_jobs: embedJobs });
  return { sessionId: written.sessionId, chunks: chunks.length, embedJobs, embedEnqueueFailures };
}
