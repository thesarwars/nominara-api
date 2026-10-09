import { createHash } from "node:crypto";
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
  return authorityTargets(citationGap, seedableDomains).length + conceptGap.length;
}

/**
 * NEW-C-6 — the authority tasks a plan makes: the FIRST gap entry of each seedable domain, in gap order.
 * The task fingerprint is per project + domain (owner decision 2026-10-08), so two URLs on one domain are
 * one task; counting them as two would make the feed's count promise a task the plan cannot create. The plan
 * and `recoveryTaskCount` both go through this function, so they cannot disagree.
 */
export function authorityTargets<T extends Pick<CitationGapEntry, "domain">>(
  citationGap: readonly T[],
  seedableDomains: ReadonlySet<string>,
): T[] {
  const seen = new Set<string>();
  const targets: T[] = [];
  for (const entry of citationGap) {
    const domain = entry.domain.toLowerCase();
    if (!seedableDomains.has(domain) || seen.has(domain)) continue;
    seen.add(domain);
    targets.push(entry);
  }
  return targets;
}

/** NEW-C-6 — `sha256('authority:{project_id}:{domain}')`, the domain lower-cased (owner decision 2026-10-08). */
export function authorityTaskFingerprint(projectId: string, domain: string): Buffer {
  return createHash("sha256").update(`authority:${projectId}:${domain.toLowerCase()}`).digest();
}
