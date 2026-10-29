import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { alignmentRecommendationSchema, CLAIM_BEARING_NODE_TYPES, semanticNodeTypeSchema, type AlignmentRecommendation } from "../../../../contracts/analytics/index.js";
import type { TokenCounter } from "../corpus/chunker.js";
import { isLowConfidence, suppressRecommendations } from "../corpus/weights.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import { ALIGNMENT } from "./constants.js";
import { accuracyWarningFor } from "./node-types.js";
import { normalisePhrase } from "./phrases.js";
import { lockNodeScope } from "./scope-lock.js";

// STORY-059 AC5-AC9, AC13 - everything that happens to the nodes once they hold vectors, in ONE transaction with no network:
//
//   1. DEDUPE    collapse nodes at pairwise cosine >= 0.93, keeping the higher corpus_doc_ratio (SQL, `<=>`)
//   2. PRESENCE  the normalised phrase appears in the draft (else the live page) on word boundaries
//   3. COVERAGE  |present| / |required|; NULL when nothing is required (no node is not "fully covered", and not "uncovered")
//   4. GAIN      the additive-blend estimate per (node, chunk), the node keeping its BEST chunk's (SQL)
//   5. RANK      projected_gain x corpus_doc_ratio x type multiplier, over the nodes still missing
//   6. RECOMMEND the missing nodes, labelled and flagged, suppressed under low confidence (EC-24), written onto the session
//
// All vector arithmetic is SQL. The application passes scalars in (token counts, constants) and reads scalars out.
//
// DEDUPE IS GREEDY, not transitive. Nodes are taken in priority order (higher prevalence, then the SHORTER phrase, then the phrase,
// then id); each kept node removes the not-yet-kept nodes within 0.93 of it. So in a chain A~B~C where A and C are not near, B
// collapses into A and C SURVIVES: B was removed, and a removed node removes nothing. A transitive rule would delete C for being near
// a node that is itself gone. The loop is bounded by the node count (at most 100 per extraction) and each pass is one statement.
//
// SESSION STATE LIVES ON SHARED ROWS. present_in_content, projected_gain and priority_rank are written onto semantic_nodes rows that
// every session of the same (project, cluster) shares, and an extraction replaces the scope's rows (new ids). Only the per-session
// `recommendations` snapshot on geo_alignments is session state: analysing session B overwrites what session A was computed from,
// and a node_id in A's snapshot (or later in patches.applied_node_ids) can point at a row a re-extraction deleted. No consumer may read
// the node columns as session state. Writers of one scope are serialised by a transaction-scoped advisory lock (scope-lock.ts).
//
// PRESENCE has two branches in the reference: the normalised phrase, OR a phrase of the content at cosine >= 0.90 to it. Only the
// first is built. The second needs a vector for every phrase of the CONTENT, and no table stores one (a content chunk is 512 tokens
// and is never within 0.90 of a four-word phrase); storing them is a schema change this story did not name. It is a DESIGN decision
// (for example, content-phrase rows embedded through embed.batch), not something real embeddings alone would flip: AC7 stays open
// until the owner chooses where those vectors are stored. Until then a close
// paraphrase reads as ABSENT, which errs toward recommending a concept the page may already express - never toward hiding a gap.
//
// THE GAIN is the best chunk's. The reference defines the gain of "this chunk"; a node is reported at the chunk it helps most, which is
// where inserting it would be done. Token counts for the phrase are the embedding model's (the `tokenizer` port); the chunk's are
// the ones stored when it was chunked.

const tracer = trace.getTracer("nominara.geo-alignment");
const logger = new Logger("geo.alignment");

const GENERIC_REVIEW_WARNING = "This concept needs a human check. Only add it if it is true of your product.";

export interface AnalyseNodesSummary {
  readonly found: boolean;
  /** Nodes removed as near-duplicates of a higher-prevalence node. */
  readonly collapsed: number;
  readonly nodes: number;
  readonly present: number;
  readonly missing: number;
  /** Missing nodes with a modeled gain and therefore a rank. */
  readonly ranked: number;
  readonly coverageRatio: number | null;
  /** The recommendations written onto the session, after suppression. */
  readonly recommendations: number;
  readonly lowConfidence: boolean;
}

export interface AnalyseNodesOptions {
  /** Model the gain against the draft's chunks instead of the live page's. */
  readonly draft?: boolean;
}

interface SessionRow {
  project_id: string;
  prompt_cluster_id: string | null;
  embedding_model: string;
  live_content_md: string | null;
  draft_content_md: string | null;
  centroid_source_count: number;
}

export async function analyseNodes(tx: ClientBase, sessionId: string, tokenizer: TokenCounter, options: AnalyseNodesOptions = {}): Promise<AnalyseNodesSummary> {
  return tracer.startActiveSpan("geo.alignment.analyse_nodes", async (span) => {
    try {
      const summary = await run(tx, sessionId, tokenizer, options.draft === true);
      span.setAttributes({ "nominara.alignment.nodes": summary.nodes, "nominara.alignment.collapsed": summary.collapsed, "nominara.alignment.ranked": summary.ranked });
      return summary;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function run(tx: ClientBase, sessionId: string, tokenizer: TokenCounter, draft: boolean): Promise<AnalyseNodesSummary> {
  const found = await tx.query<SessionRow & { workspace_id: string }>(
    `SELECT workspace_id, project_id, prompt_cluster_id, embedding_model, live_content_md, draft_content_md, centroid_source_count
       FROM geo_alignments WHERE id = $1 AND workspace_id = app.current_workspace()`,
    [sessionId],
  );
  const s = found.rows[0];
  if (s === undefined) return { found: false, collapsed: 0, nodes: 0, present: 0, missing: 0, ranked: 0, coverageRatio: null, recommendations: 0, lowConfidence: true };
  const scope = [s.project_id, s.prompt_cluster_id] as const;
  // Held to commit: another analysis or extraction of this scope waits instead of interleaving its DELETEs and UPDATEs with ours.
  await lockNodeScope(tx, s.project_id, s.prompt_cluster_id);

  // ---- 1. dedupe ----------------------------------------------------------------------------------------------------
  let collapsed = 0;
  const kept: string[] = [];
  for (;;) {
    const next = await tx.query<{ id: string }>(
      `SELECT id FROM semantic_nodes
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2
          AND embedding IS NOT NULL AND embedding_model = $3 AND NOT (id = ANY($4::uuid[]))
        ORDER BY corpus_doc_ratio DESC, cardinality(string_to_array(phrase_normalized, ' ')), phrase_normalized, id
        LIMIT 1`,
      [...scope, s.embedding_model, kept],
    );
    const keeper = next.rows[0]?.id;
    if (keeper === undefined) break;
    const removed = await tx.query(
      `DELETE FROM semantic_nodes d USING semantic_nodes k
        WHERE k.id = $5 AND k.workspace_id = app.current_workspace()
          AND d.workspace_id = app.current_workspace() AND d.project_id = $1 AND d.prompt_cluster_id IS NOT DISTINCT FROM $2
          AND d.id <> k.id AND d.embedding IS NOT NULL AND d.embedding_model = $3 AND NOT (d.id = ANY($4::uuid[]))
          AND (1 - (d.embedding <=> k.embedding)) >= $6`,
      [...scope, s.embedding_model, kept, keeper, ALIGNMENT.dedupeCosine],
    );
    collapsed += removed.rowCount ?? 0;
    kept.push(keeper);
  }

  // ---- 2. presence --------------------------------------------------------------------------------------------------
  const nodes = await tx.query<{ id: string; phrase_normalized: string }>(
    `SELECT id, phrase_normalized FROM semantic_nodes
      WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2 ORDER BY id`,
    [...scope],
  );
  // The same flag selects the content and the chunks: a live analysis reports the live page, a draft analysis the draft (else the live page).
  const content = ` ${normalisePhrase((draft ? (s.draft_content_md ?? s.live_content_md) : s.live_content_md) ?? "")} `;
  const presentIds = new Set(nodes.rows.filter((n) => content.includes(` ${normalisePhrase(n.phrase_normalized)} `)).map((n) => n.id));
  await tx.query(
    `UPDATE semantic_nodes n SET present_in_content = (n.id = ANY($3::uuid[]))
      WHERE n.workspace_id = app.current_workspace() AND n.project_id = $1 AND n.prompt_cluster_id IS NOT DISTINCT FROM $2`,
    [...scope, [...presentIds]],
  );

  // The review flag follows the TYPE: a claim-bearing node is flagged whether or not the extraction that wrote it set the column.
  await tx.query(
    `UPDATE semantic_nodes SET requires_human_review = true
      WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2
        AND node_type = ANY($3::text[]) AND NOT requires_human_review`,
    [...scope, [...CLAIM_BEARING_NODE_TYPES]],
  );

  // ---- 3. coverage --------------------------------------------------------------------------------------------------
  const coverage = await tx.query<{ coverage: number | null }>(
    `UPDATE geo_alignments g
        SET coverage_ratio = c.ratio, updated_at = now()
       FROM (SELECT (count(*) FILTER (WHERE present_in_content))::real / NULLIF(count(*), 0) AS ratio
               FROM semantic_nodes WHERE workspace_id = app.current_workspace() AND project_id = $2 AND prompt_cluster_id IS NOT DISTINCT FROM $3) c
      WHERE g.id = $1 AND g.workspace_id = app.current_workspace()
      RETURNING g.coverage_ratio AS coverage`,
    [sessionId, ...scope],
  );

  // ---- 4. projected gain --------------------------------------------------------------------------------------------
  const modelable = await tx.query<{ id: string; phrase: string }>(
    `SELECT id, phrase FROM semantic_nodes
      WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2
        AND NOT present_in_content AND embedding IS NOT NULL AND embedding_model = $3 ORDER BY id`,
    [...scope, s.embedding_model],
  );
  await tx.query(
    `WITH s AS (
       SELECT id, centroid, embedding_model FROM geo_alignments WHERE id = $1 AND workspace_id = app.current_workspace() AND centroid IS NOT NULL
     ), t AS (
       SELECT * FROM unnest($4::uuid[], $5::int[]) AS t(id, te)
     ), pairs AS (
       SELECT n.id AS node_id,
              (e.embedding::vector(1536) <=> s.centroid::vector(1536))
              - (l2_normalize(e.embedding::vector(1536) * array_fill((1 - a.alpha)::real, ARRAY[1536])::vector(1536)
                              + n.embedding::vector(1536) * array_fill(a.alpha::real, ARRAY[1536])::vector(1536))
                 <=> s.centroid::vector(1536)) AS gain
         FROM s
         JOIN semantic_nodes n ON n.workspace_id = app.current_workspace() AND n.project_id = $2 AND n.prompt_cluster_id IS NOT DISTINCT FROM $3
         JOIN t ON t.id = n.id
         JOIN content_chunks c ON c.session_id = s.id AND c.workspace_id = app.current_workspace() AND c.is_draft = $8
        CROSS JOIN LATERAL (
          SELECT x.embedding FROM content_chunks x
           WHERE x.workspace_id = app.current_workspace() AND x.content_hash = c.content_hash AND x.is_draft = c.is_draft
             AND x.embedding_model = s.embedding_model AND x.embedding IS NOT NULL
           LIMIT 1
        ) e
        CROSS JOIN LATERAL (SELECT LEAST($6::double precision, t.te::double precision / NULLIF(c.token_count + t.te, 0) * $7::double precision) AS alpha) a
        WHERE n.embedding IS NOT NULL AND n.embedding_model = s.embedding_model AND NOT n.present_in_content AND t.te > 0
     ), best AS (
       SELECT node_id, max(gain) AS gain FROM pairs GROUP BY node_id
     )
     UPDATE semantic_nodes n
        SET projected_gain = (SELECT best.gain FROM best WHERE best.node_id = n.id), computed_at = now()
      WHERE n.workspace_id = app.current_workspace() AND n.project_id = $2 AND n.prompt_cluster_id IS NOT DISTINCT FROM $3`,
    [sessionId, ...scope, modelable.rows.map((n) => n.id), modelable.rows.map((n) => tokenizer.count(n.phrase)), ALIGNMENT.alphaCap, ALIGNMENT.kappa, draft],
  );

  // ---- 5. priority rank ---------------------------------------------------------------------------------------------
  await tx.query(
    `WITH r AS (
       SELECT id, row_number() OVER (
                ORDER BY projected_gain * corpus_doc_ratio * (CASE WHEN node_type IN ('compliance', 'metric') THEN $3::double precision ELSE 1 END) DESC,
                         corpus_doc_ratio DESC, phrase_normalized, id) AS rk
         FROM semantic_nodes
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2
          AND NOT present_in_content AND projected_gain IS NOT NULL AND projected_gain > 0
     )
     UPDATE semantic_nodes n SET priority_rank = (SELECT r.rk FROM r WHERE r.id = n.id)::smallint
      WHERE n.workspace_id = app.current_workspace() AND n.project_id = $1 AND n.prompt_cluster_id IS NOT DISTINCT FROM $2`,
    [...scope, ALIGNMENT.claimMultiplier],
  );

  // ---- 6. recommendations -------------------------------------------------------------------------------------------
  const missing = await tx.query<{
    id: string; phrase: string; node_type: string; corpus_doc_ratio: number; projected_gain: number | null; priority_rank: number | null;
    evidence_url: string; evidence_snippet: string; requires_human_review: boolean;
  }>(
    `SELECT id, phrase, node_type, corpus_doc_ratio, projected_gain, priority_rank, evidence_url, evidence_snippet, requires_human_review
       FROM semantic_nodes
      WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2 AND NOT present_in_content
      ORDER BY priority_rank NULLS LAST, corpus_doc_ratio DESC, phrase_normalized, id`,
    [...scope],
  );
  // A node modeled to move the page AWAY from the centroid (gain <= 0) is not a recommendation: it has no rank and would be shown to a
  // customer as a concept to add. A node with NO modeled gain (null) is kept, labelled as such, and is dropped under low confidence.
  const recommendations: AlignmentRecommendation[] = missing.rows.filter((n) => n.projected_gain === null || n.projected_gain > 0).map((n) => {
    const type = semanticNodeTypeSchema.parse(n.node_type);
    return alignmentRecommendationSchema.parse({
      node_id: n.id,
      phrase: n.phrase,
      node_type: type,
      corpus_doc_ratio: n.corpus_doc_ratio,
      projected_gain: n.projected_gain,
      priority_rank: n.priority_rank,
      evidence_url: n.evidence_url,
      evidence_snippet: n.evidence_snippet,
      requires_human_review: n.requires_human_review,
      accuracy_warning: n.requires_human_review ? (accuracyWarningFor(type) ?? GENERIC_REVIEW_WARNING) : null,
      auto_insert: false,
    });
  });
  const lowConfidence = isLowConfidence(s.centroid_source_count);
  const shown = suppressRecommendations(recommendations, lowConfidence);
  await tx.query("UPDATE geo_alignments SET recommendations = $2::jsonb, updated_at = now() WHERE id = $1 AND workspace_id = app.current_workspace()", [sessionId, JSON.stringify(shown)]);

  const summary: AnalyseNodesSummary = {
    found: true,
    collapsed,
    nodes: nodes.rows.length,
    present: presentIds.size,
    missing: missing.rows.length,
    ranked: missing.rows.filter((n) => n.priority_rank !== null).length,
    coverageRatio: coverage.rows[0]?.coverage ?? null,
    recommendations: shown.length,
    lowConfidence,
  };
  incrementCounter("nominara_geo_alignment_nodes_analysed_total", { low_confidence: String(lowConfidence) });
  observeValue("nominara_geo_alignment_nodes_collapsed", collapsed);
  logger.log({ event: "geo.alignment.nodes_analysed", workspace_id: s.workspace_id, nodes: summary.nodes, collapsed, present: summary.present, ranked: summary.ranked, shown: shown.length, low_confidence: lowConfidence });
  return summary;
}
