import type { ConceptGapEntry } from "../../../contracts/analytics/index.js";
import { ALIGNMENT } from "../geo/alignment/constants.js";
import { normalisePhrase } from "../geo/alignment/phrases.js";

// STORY-057 AC4/AC5 - the concept gap of a displacement: phrases in the cited-passage corpus at or above the prevalence
// threshold and absent from the brand's page, each with its corpus prevalence and an evidence URL.
//
// EVIDENCE OR DROP. A concept with no usable evidence URL is dropped, never kept with a caveat: the entry contract requires
// `evidence_url`, and this is the one place an entry is made, so an unevidenced concept cannot reach the record. A prevalence
// that is not a number in [0, 1] cannot be shown to meet the threshold and is dropped the same way.

/** product-spec FR-GEO-A1c / geo-and-vectors.md: "present in >= 30% of cited passages". One number, shared with the alignment code. */
export const CONCEPT_PREVALENCE_THRESHOLD = ALIGNMENT.minDocRatio;

export interface ConceptCandidate {
  readonly phrase: string;
  /** Fraction of the cited documents containing the phrase (`semantic_nodes.corpus_doc_ratio`). */
  readonly prevalence: number;
  readonly evidenceUrl: string | null | undefined;
}

export interface ConceptGapResult {
  readonly entries: ConceptGapEntry[];
  /** Candidates under the threshold, or whose prevalence is not a share in [0, 1]. */
  readonly droppedBelowThreshold: number;
  /** Candidates with no usable evidence URL: dropped, not caveated. */
  readonly droppedNoEvidence: number;
}

function usableEvidenceUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? trimmed : null;
  } catch {
    return null;
  }
}

/** Candidates arrive best-ranked first; the first of two spellings of one concept is kept. */
export function deriveConceptGap(candidates: readonly ConceptCandidate[]): ConceptGapResult {
  const entries: ConceptGapEntry[] = [];
  const seen = new Set<string>();
  let droppedBelowThreshold = 0;
  let droppedNoEvidence = 0;
  for (const candidate of candidates) {
    const { prevalence } = candidate;
    if (!Number.isFinite(prevalence) || prevalence < CONCEPT_PREVALENCE_THRESHOLD || prevalence > 1) {
      droppedBelowThreshold += 1;
      continue;
    }
    const evidenceUrl = usableEvidenceUrl(candidate.evidenceUrl);
    const concept = candidate.phrase.trim();
    if (evidenceUrl === null || concept === "") {
      droppedNoEvidence += 1;
      continue;
    }
    const key = normalisePhrase(concept);
    if (seen.has(key)) continue;
    seen.add(key);
    // Rounded for storage only AFTER the threshold test; a 4-place value hides float4 noise (0.3 stored as 0.30000001).
    entries.push({ concept, prevalence: Math.round(prevalence * 10_000) / 10_000, evidence_url: evidenceUrl });
  }
  return { entries, droppedBelowThreshold, droppedNoEvidence };
}
