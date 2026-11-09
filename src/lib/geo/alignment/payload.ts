import type { ClientBase } from "pg";
import {
  ALIGNMENT_CAVEAT,
  ALIGNMENT_ESTIMATE_METHOD,
  alignmentRecommendationSchema,
  alignmentSessionPayloadSchema,
  type AlignmentRecommendation,
  type AlignmentRecommendationWire,
  type AlignmentSessionPayload,
} from "../../../../contracts/analytics/index.js";
import { NotFoundError } from "../../../api/errors/domain-errors.js";
import { isLowConfidence } from "../corpus/weights.js";
import { ALIGNMENT } from "./constants.js";
import { diminishedSum } from "./gain.js";

// STORY-059 AC10 / AC12 / AC13 - the session as the API returns it, in the wire shape of api-specification.md section 8, validated against the
// contract on the way out. The row's flat columns and the stored recommendations (`geo_alignments`, `content_chunks`) are MAPPED here: nested
// alignment, coverage and centroid blocks, per-chunk alignment, and each recommendation with its kind, guardrail and evidence[] (review r2).
//
// Validation here is the point: the estimate label, `generation: "disabled"` and `auto_insert: false` are literals of the schema, so a
// payload that dropped one cannot be built. The recommendations are read from the column `analyseNodes` wrote (already suppressed
// for a thin corpus), so the payload and the stored session cannot disagree.
//
// THE PROJECTION is scalar arithmetic over the SHOWN recommendations' gains: the naive sum beside the sum with 0.85^(i-1)
// applied in rank order. Both are in CHUNK units (each gain is the change in the best chunk's cosine), so there is deliberately NO
// projected page alignment: the page figure is a token-weighted mean over all chunks, and adding a chunk gain to it would overstate it
// by roughly the number of chunks (the over-projection the story calls trust-destroying). The projection is null altogether when no
// shown recommendation has a modeled gain (nothing to project).

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
};

/** A stored recommendation (the jsonb column's shape) as the section 8 wire recommendation. Every stored node is one the page does NOT yet hold. */
function toWire(r: AlignmentRecommendation): AlignmentRecommendationWire {
  return {
    id: r.node_id,
    kind: "semantic_node",
    node_id: r.node_id,
    node_type: r.node_type,
    phrase: r.phrase,
    severity: null,
    corpus_doc_ratio: r.corpus_doc_ratio,
    present_in_content: false,
    projected_gain: r.projected_gain,
    priority_rank: r.priority_rank,
    guardrail: "phrase_only",
    requires_human_review: r.requires_human_review,
    warning: r.accuracy_warning,
    evidence: [{ domain: hostOf(r.evidence_url), url: r.evidence_url, snippet: r.evidence_snippet }],
    auto_insert: false,
  };
}

export async function readSessionPayload(tx: ClientBase, sessionId: string): Promise<AlignmentSessionPayload> {
  const result = await tx.query<{
    id: string; project_id: string; target_url: string; prompt_cluster_id: string | null; engine_keys: string[]; embedding_model: string; embedding_dims: number;
    baseline_alignment: number | null; current_alignment: number | null; target_band_low: number | null; target_band_high: number | null;
    percentile_vs_corpus: number | null; coverage_ratio: number | null; centroid_source_count: number; centroid_domains: string[];
    recommendations: unknown; analysis_state: "pending" | "ready" | "stale" | "failed"; analysis_reason: string | null; draft_state: "pending" | "ready" | "failed" | null; live_content_md: string | null;
    cluster_label: string | null; cluster_prompt_count: number | null;
  }>(
    `SELECT g.id, g.project_id, g.target_url, g.prompt_cluster_id, g.engine_keys, g.embedding_model, g.embedding_dims, g.baseline_alignment, g.current_alignment,
            g.target_band_low, g.target_band_high, g.percentile_vs_corpus, g.coverage_ratio, g.centroid_source_count, g.centroid_domains, g.recommendations,
            g.analysis_state, g.analysis_reason, g.draft_state, g.live_content_md, tc.label AS cluster_label, tc.prompt_count AS cluster_prompt_count
       FROM geo_alignments g
       LEFT JOIN topic_clusters tc ON tc.id = g.prompt_cluster_id AND tc.workspace_id = app.current_workspace()
      WHERE g.id = $1 AND g.workspace_id = app.current_workspace()`,
    [sessionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new NotFoundError({ message: "no such alignment session" });

  // STORY-192: an analysis that is not READY shows no coverage, recommendation or projection, whatever an earlier step left in the columns, and no
  // baseline (the live baseline is not taken while a chunk waits): a partial figure is never shown as final. A ready one shows everything.
  const ready = row.analysis_state === "ready";
  const stored = ready ? alignmentRecommendationSchema.array().parse(row.recommendations) : [];
  const recommendations = stored.map(toWire);
  const modeled = stored
    .filter((r) => r.projected_gain !== null && r.priority_rank !== null)
    .sort((a, b) => a.priority_rank! - b.priority_rank!)
    .map((r) => r.projected_gain!);
  const diminished = diminishedSum(modeled);
  const projection =
    modeled.length === 0
      ? null
      : {
          naive_sum: modeled.reduce((sum, gain) => sum + gain, 0),
          diminished_sum: diminished,
          diminishing_returns_factor: ALIGNMENT.diminishing,
          method: ALIGNMENT_ESTIMATE_METHOD,
          confidence: "modeled" as const,
          caveat: ALIGNMENT_CAVEAT,
        };

  const chunks = ready ? await readChunks(tx, sessionId, row.draft_state === "ready") : [];
  const nodeCounts = ready && row.coverage_ratio !== null ? await readNodeCounts(tx, row.project_id, row.prompt_cluster_id, row.coverage_ratio) : { required: null, present: null };
  const builtAt = await tx.query<{ built_at: Date | null }>(
    `SELECT max(fetched_at) AS built_at FROM corpus_passages
      WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2 AND embedding_model = $3 AND centroid_weight > 0 AND expires_at > now()`,
    [row.project_id, row.prompt_cluster_id, row.embedding_model],
  );

  return alignmentSessionPayloadSchema.parse({
    alignment_id: row.id,
    target_url: row.target_url,
    prompt_cluster:
      row.prompt_cluster_id === null || row.cluster_label === null
        ? null
        : { cluster_id: row.prompt_cluster_id, label: row.cluster_label, prompt_count: row.cluster_prompt_count ?? 0, engines: row.engine_keys },
    embedding: { model: row.embedding_model, dims: row.embedding_dims, storage: "halfvec" },
    centroid: {
      source_passage_count: row.centroid_source_count,
      source_domains: row.centroid_domains,
      built_at: row.centroid_source_count === 0 ? null : (builtAt.rows[0]?.built_at?.toISOString() ?? null),
    },
    alignment: {
      baseline: ready ? row.baseline_alignment : null,
      current: ready ? row.current_alignment : null,
      target_band: !ready || row.target_band_low === null || row.target_band_high === null ? null : [row.target_band_low, row.target_band_high],
      percentile_vs_cited_docs: ready ? row.percentile_vs_corpus : null,
    },
    coverage: { required_nodes: nodeCounts.required, present_nodes: nodeCounts.present, coverage_ratio: ready ? row.coverage_ratio : null },
    content: { chunks },
    low_confidence: isLowConfidence(row.centroid_source_count),
    estimate: { method: ALIGNMENT_ESTIMATE_METHOD, confidence: "modeled", caveat: ALIGNMENT_CAVEAT },
    recommendations,
    projection,
    anti_filler_policy: { generation: "disabled", explanation: "Nominara returns phrases, structures, and schema - never generated prose." },
    status: row.analysis_state,
    status_reason: row.analysis_reason,
    draft_status: row.draft_state,
    // Decision 92 (the draft prefill): the LIVE page text, only once the analysis is final; null before a page was fetched. Never the draft.
    live_content_md: ready ? row.live_content_md : null,
  });
}

/** The page the session's alignment was measured on: the draft once its recompute is ready (it is what `current` is), else the live page. */
async function readChunks(tx: ClientBase, sessionId: string, draftReady: boolean): Promise<AlignmentSessionPayload["content"]["chunks"]> {
  const read = (isDraft: boolean) =>
    tx.query<{ chunk_index: number; heading_path: string[]; token_count: number; alignment: number | null }>(
      `SELECT chunk_index, heading_path, token_count, alignment FROM content_chunks
        WHERE session_id = $1 AND workspace_id = app.current_workspace() AND is_draft = $2 ORDER BY chunk_index`,
      [sessionId, isDraft],
    );
  let rows = draftReady ? (await read(true)).rows : [];
  if (rows.length === 0) rows = (await read(false)).rows;
  let weakest = -1;
  rows.forEach((chunk, i) => {
    if (chunk.alignment !== null && (weakest === -1 || chunk.alignment < rows[weakest]!.alignment!)) weakest = i;
  });
  return rows.map((chunk, i) => ({ chunk_index: chunk.chunk_index, heading_path: chunk.heading_path, token_count: chunk.token_count, alignment: chunk.alignment, weakest: i === weakest }));
}

/**
 * The scope's live (not collapsed) concepts, and how many the page holds. The nodes are SHARED by every session of the project and cluster, so
 * the counts describe this session only while they still give ITS coverage ratio; once a later session has moved them on they are null (never a
 * count that disagrees with the ratio beside it).
 */
async function readNodeCounts(tx: ClientBase, projectId: string, clusterId: string | null, ratio: number): Promise<{ required: number | null; present: number | null }> {
  const counted = await tx.query<{ required: number; present: number }>(
    `SELECT count(*)::int AS required, (count(*) FILTER (WHERE present_in_content))::int AS present FROM semantic_nodes
      WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2 AND collapsed_into_id IS NULL`,
    [projectId, clusterId],
  );
  const { required, present } = counted.rows[0] ?? { required: 0, present: 0 };
  return required > 0 && Math.abs(present / required - ratio) < 1e-5 ? { required, present } : { required: null, present: null };
}
