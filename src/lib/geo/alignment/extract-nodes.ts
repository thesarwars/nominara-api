import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { embedBatchKey, splitIdsIntoJobs } from "../../embedding/embed-batch.js";
import type { EnqueueEmbedBatch } from "../../embedding/prompt-embedding-request.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { classifyNodeType, requiresHumanReview } from "./node-types.js";
import { extractNodeCandidates, type CorpusDocument } from "./phrases.js";

// STORY-059 AC5 / AC6 / AC7 - semantic node extraction: the cited documents' phrases, kept at or above the corpus-prevalence
// threshold, typed by the deterministic map, EVIDENCED, and queued for their vectors.
//
// TWO SHORT TRANSACTIONS, no network between them (ADR-0003): read the corpus text, extract in memory, then write the nodes. The
// embed jobs are enqueued AFTER the commit; a failed enqueue FAILS OPEN (owner decision 7): the nodes are stored and wait at
// `embedding IS NULL` (no vector, no model), and the next extraction re-requests them.
//
// REPLACEMENT. A node set is one project-and-cluster's: it is deleted and rewritten, so a concept that fell below the threshold since
// the last run leaves with it. Sibling clusters' nodes are untouched. (`ux_semantic_nodes` treats a NULL cluster as distinct, so an
// upsert would stack duplicates for a cluster-less session; delete-and-insert has no such hole.)
//
// EVERY node carries `evidence_url` and `evidence_snippet`, both NOT NULL in the table: an unevidenced node cannot be stored.
// `embedding_model` stays NULL until embed.batch writes it WITH the vector (owner decision 2026-10-28 #4).

const tracer = trace.getTracer("nominara.geo-alignment");
const logger = new Logger("geo.alignment");

export interface ExtractNodesDeps {
  readonly workspaceId: string;
  /** Runs `fn` in one tenant-context transaction. Called twice, never around anything slow. */
  readonly runInTx: <T>(fn: (tx: ClientBase) => Promise<T>) => Promise<T>;
  /** Absent = the process has no queue producer: nodes are written and wait at `embedding IS NULL`. */
  readonly enqueueEmbed?: EnqueueEmbedBatch;
}

export interface ExtractNodesResult {
  readonly found: boolean;
  /** Documents the prevalence ratio was measured over (K). */
  readonly documents: number;
  readonly nodes: number;
  readonly embedJobs: number;
  readonly embedEnqueueFailures: number;
}

export async function extractSemanticNodes(deps: ExtractNodesDeps, sessionId: string): Promise<ExtractNodesResult> {
  return tracer.startActiveSpan("geo.alignment.extract_nodes", async (span) => {
    try {
      const result = await run(deps, sessionId);
      span.setAttributes({ "nominara.alignment.documents": result.documents, "nominara.alignment.nodes": result.nodes });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function run(deps: ExtractNodesDeps, sessionId: string): Promise<ExtractNodesResult> {
  const read = await deps.runInTx(async (tx) => {
    const session = await tx.query<{ project_id: string; prompt_cluster_id: string | null; embedding_model: string }>(
      "SELECT project_id, prompt_cluster_id, embedding_model FROM geo_alignments WHERE id = $1 AND workspace_id = app.current_workspace()",
      [sessionId],
    );
    const s = session.rows[0];
    if (s === undefined) return undefined;
    const passages = await tx.query<{ url: string; text: string; w: number }>(
      `SELECT url, text, centroid_weight AS w
         FROM corpus_passages
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2
          AND embedding_model = $3 AND expires_at > now()
        ORDER BY centroid_weight DESC, url, passage_index`,
      [s.project_id, s.prompt_cluster_id, s.embedding_model],
    );
    return { projectId: s.project_id, clusterId: s.prompt_cluster_id, passages: passages.rows };
  });
  if (read === undefined) return { found: false, documents: 0, nodes: 0, embedJobs: 0, embedEnqueueFailures: 0 };

  // A document is a URL: its passages joined, in the order of the heaviest first, so the evidence comes from the best-weighted source.
  const byUrl = new Map<string, string[]>();
  for (const passage of read.passages) byUrl.set(passage.url, [...(byUrl.get(passage.url) ?? []), passage.text]);
  const documents: CorpusDocument[] = [...byUrl.entries()].map(([url, texts]) => ({ url, text: texts.join("\n") }));
  const candidates = extractNodeCandidates(documents);

  const written = await deps.runInTx(async (tx) => {
    await tx.query(
      `DELETE FROM semantic_nodes WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2`,
      [read.projectId, read.clusterId],
    );
    if (candidates.length === 0) return [] as string[];
    const typed = candidates.map((c) => ({ c, type: classifyNodeType(c.phrase) }));
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO semantic_nodes
         (workspace_id, project_id, prompt_cluster_id, phrase, phrase_normalized, node_type, corpus_frequency, corpus_doc_ratio,
          evidence_url, evidence_snippet, requires_human_review)
       SELECT app.current_workspace(), $1, $2, v.phrase, v.norm, v.type, v.freq, v.ratio, v.url, v.snippet, v.review
         FROM unnest($3::text[], $4::text[], $5::text[], $6::int[], $7::real[], $8::text[], $9::text[], $10::boolean[])
              AS v(phrase, norm, type, freq, ratio, url, snippet, review)
       RETURNING id`,
      [
        read.projectId, read.clusterId,
        typed.map((t) => t.c.phrase), typed.map((t) => t.c.normalized), typed.map((t) => t.type), typed.map((t) => t.c.frequency),
        typed.map((t) => t.c.docRatio), typed.map((t) => t.c.evidenceUrl), typed.map((t) => t.c.evidenceSnippet), typed.map((t) => requiresHumanReview(t.type)),
      ],
    );
    return inserted.rows.map((row) => row.id).sort();
  });

  let embedJobs = 0;
  let embedEnqueueFailures = 0;
  if (deps.enqueueEmbed !== undefined) {
    for (const ids of splitIdsIntoJobs(written)) {
      try {
        await deps.enqueueEmbed("embed.batch", deps.workspaceId, { table: "semantic_nodes", ids }, embedBatchKey("semantic_nodes", ids));
        embedJobs += 1;
        incrementCounter("nominara_embed_enqueued_total", { producer: "geo_alignment" });
      } catch {
        embedEnqueueFailures += 1;
        incrementCounter("nominara_embed_enqueue_failed_total", { producer: "geo_alignment" });
      }
    }
  }

  incrementCounter("nominara_geo_alignment_nodes_extracted_total", { outcome: written.length > 0 ? "nodes" : "none" });
  // Workspace ID and counts only: no phrase, no URL, no snippet (competitor text is not ours to log).
  logger.log({ event: "geo.alignment.nodes_extracted", workspace_id: deps.workspaceId, documents: documents.length, candidates: candidates.length, nodes: written.length, embed_jobs: embedJobs });
  return { found: true, documents: documents.length, nodes: written.length, embedJobs, embedEnqueueFailures };
}
