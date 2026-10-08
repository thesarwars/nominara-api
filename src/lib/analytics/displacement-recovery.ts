import type { CitationGapEntry, ConceptGapEntry } from "../../../contracts/analytics/index.js";

// NEW-C-5 AC1 — how many tasks a recovery plan would create for a displacement.
// STORY-057 AC6/AC8: one content task per concept gap, one authority task per
// citation gap on a SEEDABLE domain, and none for a non-seedable one (it is
// recorded and visible, not actionable). The feed shows this count BEFORE the
// click; the plan generator (NEW-C-6) must use this same function so the two
// can never disagree.
//
// `seedableDomains` holds LOWER-CASED domains of the caller's workspace.

export function recoveryTaskCount(
  citationGap: readonly Pick<CitationGapEntry, "domain">[],
  conceptGap: readonly Pick<ConceptGapEntry, "concept">[],
  seedableDomains: ReadonlySet<string>,
): number {
  const authority = citationGap.filter((entry) => seedableDomains.has(entry.domain.toLowerCase())).length;
  return authority + conceptGap.length;
}
