import { CORPUS } from "./constants.js";

/** Step 7: centroid_weight(p) = log1p(citation_frequency(url(p))) * avg_position_weight(url(p)). */
export function centroidWeight(citationFrequency: number, avgPositionWeight: number): number {
  if (!(citationFrequency > 0) || !(avgPositionWeight > 0)) return 0;
  return Math.log1p(citationFrequency) * avgPositionWeight;
}

/** EC-24: fewer than the documented minimum contributing passages. 0 is low-confidence like any other thin corpus. */
export function isLowConfidence(sourceCount: number): boolean {
  return sourceCount < CORPUS.minPassages;
}

/**
 * Under low confidence, recommendations past priority_rank 3 are dropped. FAIL CLOSED: a recommendation with no rank cannot be shown
 * to be inside the top 3, so a thin corpus does not get to report it.
 */
export function suppressRecommendations<T extends { readonly priority_rank: number | null }>(recommendations: readonly T[], lowConfidence: boolean): T[] {
  if (!lowConfidence) return [...recommendations];
  return recommendations.filter((rec) => rec.priority_rank !== null && rec.priority_rank <= CORPUS.suppressPastRank);
}

export function expiresAtFrom(fetchedAt: Date): Date {
  return new Date(fetchedAt.getTime() + CORPUS.ttlDays * 86_400_000);
}
