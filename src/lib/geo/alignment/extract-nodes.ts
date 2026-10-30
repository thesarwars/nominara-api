import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { embedBatchKey, splitIdsIntoJobs } from "../../embedding/embed-batch.js";
import type { EnqueueEmbedBatch } from "../../embedding/prompt-embedding-request.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { classifyNodeType, requiresHumanReview } from "./node-types.js";
import { extractNodeCandidates, type CorpusDocument } from "./phrases.js";
import { lockNodeScope } from "./scope-lock.js";

// STORY-059 AC5 / AC6 / AC7 - semantic node extraction: the cited documents' phrases, kept at or above the corpus-prevalence
// threshold, typed by the deterministic map, EVIDENCED, and queued for their vectors.
//
// TWO SHORT TRANSACTIONS, no network between them (ADR-0003): read the corpus text, extract in memory, then write the nodes. The
// embed jobs are enqueued AFTER the commit; a failed enqueue FAILS OPEN (owner decision 7): the nodes are stored and wait at
// `embedding IS NULL` (no vector, no model), and the next extraction re-requests them.
//
// RECONCILIATION. A node set is one project-and-cluster's: a concept that fell below the threshold since the last run is deleted, a
// concept that is still there keeps its row and its vector, a new one is inserted. A row the analysis COLLAPSED into a near-duplicate
// (`collapsed_into_id`) is still a row: it is updated, never re-inserted, and never re-requested, so the collapse survives the next
// extraction (review round 3). Its marker is cleared only when its vector is from another model than the session's - the collapse was
// judged in a different vector space, so it is re-embedded and re-judged. A deleted keeper clears the markers of its rows (ON DELETE SET NULL). Sibling clusters' nodes are untouched. (`ux_semantic_nodes`
// treats a NULL cluster as distinct, so an ON CONFLICT upsert would stack duplicates for a cluster-less session; update-then-insert
// under the scope lock has no such hole.) Only nodes still at `embedding IS NULL` are requested from embed.batch.
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
    return { projectId: s.project_id, clusterId: s.prompt_cluster_id, model: s.embedding_model, passages: passages.rows };
  });
  if (read === undefined) return { found: false, documents: 0, nodes: 0, embedJobs: 0, embedEnqueueFailures: 0 };

  // A document is a URL: its passages joined, in the order of the heaviest first, so the evidence comes from the best-weighted source.
  const byUrl = new Map<string, string[]>();
  for (const passage of read.passages) byUrl.set(passage.url, [...(byUrl.get(passage.url) ?? []), passage.text]);
  const documents: CorpusDocument[] = [...byUrl.entries()].map(([url, texts]) => ({ url, text: texts.join("\n") }));
  const candidates = extractNodeCandidates(documents);

  const written = await deps.runInTx(async (tx) => {
    await lockNodeScope(tx, read.projectId, read.clusterId);
    // Re-extraction invalidates every judgement of the scope: the nodes below are reset to "absent, unranked", so no alignment of the
    // scope may keep a coverage_ratio that says they were judged. `coverage_ratio IS NOT NULL` is what STORY-057's concept gap reads as
    // "judged", and only `analyseNodes` sets it again.
    await tx.query(
      `UPDATE geo_alignments SET coverage_ratio = NULL, recommendations = '[]'::jsonb
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2`,
      [read.projectId, read.clusterId],
    );
    // The scope's nodes are RECONCILED, not replaced: a phrase that did not change keeps its row and its vector (and its model), so a
    // repeated extraction does not pay to embed the same text again. Only a phrase that is new, or whose vector is from another model, waits
    // at NULL and is requested. The per-session analysis columns are reset: they are recomputed by `analyseNodes`.
    const typed = candidates.map((c) => ({ c, type: classifyNodeType(c.phrase) }));
    const norms = typed.map((t) => t.c.normalized);
    await tx.query(
      `DELETE FROM semantic_nodes
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2 AND NOT (phrase_normalized = ANY($3::text[]))`,
      [read.projectId, read.clusterId, norms],
    );
    if (typed.length === 0) return [] as string[];
    const values = [
      typed.map((t) => t.c.phrase), norms, typed.map((t) => t.type), typed.map((t) => t.c.frequency),
      typed.map((t) => t.c.docRatio), typed.map((t) => t.c.evidenceUrl), typed.map((t) => t.c.evidenceSnippet), typed.map((t) => requiresHumanReview(t.type)),
    ];
    const rows = `unnest($3::text[], $4::text[], $5::text[], $6::int[], $7::real[], $8::text[], $9::text[], $10::boolean[])
                  AS v(phrase, norm, type, freq, ratio, url, snippet, review)`;
    await tx.query(
      `UPDATE semantic_nodes n
          SET phrase = v.phrase, node_type = v.type, corpus_frequency = v.freq, corpus_doc_ratio = v.ratio, evidence_url = v.url,
              evidence_snippet = v.snippet, requires_human_review = v.review, present_in_content = false, projected_gain = NULL,
              priority_rank = NULL, computed_at = now(),
              embedding = CASE WHEN n.embedding_model = $11 THEN n.embedding END,
              embedding_model = CASE WHEN n.embedding_model = $11 THEN n.embedding_model END,
              collapsed_into_id = CASE WHEN n.embedding_model = $11 THEN n.collapsed_into_id END
         FROM ${rows}
        WHERE n.workspace_id = app.current_workspace() AND n.project_id = $1 AND n.prompt_cluster_id IS NOT DISTINCT FROM $2 AND n.phrase_normalized = v.norm`,
      [read.projectId, read.clusterId, ...values, read.model],
    );
    await tx.query(
      `INSERT INTO semantic_nodes
         (workspace_id, project_id, prompt_cluster_id, phrase, phrase_normalized, node_type, corpus_frequency, corpus_doc_ratio,
          evidence_url, evidence_snippet, requires_human_review)
       SELECT app.current_workspace(), $1, $2, v.phrase, v.norm, v.type, v.freq, v.ratio, v.url, v.snippet, v.review
         FROM ${rows}
        WHERE NOT EXISTS (
          SELECT 1 FROM semantic_nodes n
           WHERE n.workspace_id = app.current_workspace() AND n.project_id = $1 AND n.prompt_cluster_id IS NOT DISTINCT FROM $2 AND n.phrase_normalized = v.norm
        )`,
      [read.projectId, read.clusterId, ...values],
    );
    const waiting = await tx.query<{ id: string }>(
      `SELECT id FROM semantic_nodes
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2 AND collapsed_into_id IS NULL AND embedding IS NULL`,
      [read.projectId, read.clusterId],
    );
    return waiting.rows.map((row) => row.id).sort();
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

  incrementCounter("nominara_geo_alignment_nodes_extracted_total", { outcome: candidates.length > 0 ? "nodes" : "none" });
  // Workspace ID and counts only: no phrase, no URL, no snippet (competitor text is not ours to log).
  logger.log({ event: "geo.alignment.nodes_extracted", workspace_id: deps.workspaceId, documents: documents.length, candidates: candidates.length, nodes_waiting: written.length, embed_jobs: embedJobs });
  return { found: true, documents: documents.length, nodes: candidates.length, embedJobs, embedEnqueueFailures };
}
