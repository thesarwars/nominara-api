import type { ClientBase } from "pg";
import {
  ALIGNMENT_CAVEAT,
  ALIGNMENT_ESTIMATE_METHOD,
  alignmentRecommendationSchema,
  alignmentSessionPayloadSchema,
  type AlignmentSessionPayload,
} from "../../../../contracts/analytics/index.js";
import { NotFoundError } from "../../../api/errors/domain-errors.js";
import { isLowConfidence } from "../corpus/weights.js";
import { ALIGNMENT } from "./constants.js";
import { diminishedSum } from "./gain.js";

// STORY-059 AC9 / AC12 / AC13 - the session as the API would return it, validated against the contract on the way out.
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

export async function readSessionPayload(tx: ClientBase, sessionId: string): Promise<AlignmentSessionPayload> {
  const result = await tx.query<{
    id: string; target_url: string; prompt_cluster_id: string | null; embedding_model: string;
    baseline_alignment: number | null; current_alignment: number | null; target_band_low: number | null; target_band_high: number | null;
    percentile_vs_corpus: number | null; coverage_ratio: number | null; centroid_source_count: number; centroid_domains: string[];
    recommendations: unknown;
  }>(
    `SELECT id, target_url, prompt_cluster_id, embedding_model, baseline_alignment, current_alignment, target_band_low, target_band_high,
            percentile_vs_corpus, coverage_ratio, centroid_source_count, centroid_domains, recommendations
       FROM geo_alignments WHERE id = $1 AND workspace_id = app.current_workspace()`,
    [sessionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new NotFoundError({ message: "no such alignment session" });

  const recommendations = alignmentRecommendationSchema.array().parse(row.recommendations);
  const modeled = recommendations
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
        };

  return alignmentSessionPayloadSchema.parse({
    session_id: row.id,
    target_url: row.target_url,
    prompt_cluster_id: row.prompt_cluster_id,
    embedding_model: row.embedding_model,
    baseline_alignment: row.baseline_alignment,
    current_alignment: row.current_alignment,
    target_band: row.target_band_low === null || row.target_band_high === null ? null : { low: row.target_band_low, high: row.target_band_high },
    percentile_vs_corpus: row.percentile_vs_corpus,
    coverage_ratio: row.coverage_ratio,
    centroid_source_count: row.centroid_source_count,
    centroid_domains: row.centroid_domains,
    low_confidence: isLowConfidence(row.centroid_source_count),
    estimate: { method: ALIGNMENT_ESTIMATE_METHOD, confidence: "modeled", caveat: ALIGNMENT_CAVEAT },
    recommendations,
    projection,
    generation: "disabled",
  });
}
