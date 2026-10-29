import type { SemanticNodeType } from "../../../../contracts/analytics/index.js";
import { ALIGNMENT } from "./constants.js";

// STORY-059 - the SCALAR half of the projected-gain estimator (aux-and-geo-analysis.md section 7). The vector half - the blend, the
// normalisation and the cosines - is SQL (compute.ts): no embedding is ever read into the application.

/** alpha = min(0.25, t_e / (t_v + t_e) * kappa): the share of the chunk's embedding a phrase is modelled to take. */
export function blendAlpha(phraseTokens: number, chunkTokens: number): number {
  if (!(phraseTokens > 0)) return 0;
  const chunk = chunkTokens > 0 ? chunkTokens : 0;
  return Math.min(ALIGNMENT.alphaCap, (phraseTokens / (chunk + phraseTokens)) * ALIGNMENT.kappa);
}

/** 0.85^(rank-1) for the rank-th node (1-based). Concepts overlap, so a naive sum would overstate. */
export function diminishingFactor(rank: number): number {
  if (!Number.isInteger(rank) || rank < 1) throw new RangeError("a rank is a positive integer");
  return ALIGNMENT.diminishing ** (rank - 1);
}

/** The projection panel's sum: gains in rank order, each weighted by its diminishing factor. */
export function diminishedSum(gainsInRankOrder: readonly number[]): number {
  return gainsInRankOrder.reduce((sum, gain, index) => sum + gain * diminishingFactor(index + 1), 0);
}

export function typeMultiplier(type: SemanticNodeType): number {
  return type === "compliance" || type === "metric" ? ALIGNMENT.claimMultiplier : 1;
}

/** projected_gain x corpus_doc_ratio x severity multiplier; null (not 0) when the node has no modeled gain. */
export function priorityScore(projectedGain: number | null, corpusDocRatio: number, type: SemanticNodeType): number | null {
  if (projectedGain === null) return null;
  return projectedGain * corpusDocRatio * typeMultiplier(type);
}
