import type { ProposedCompetitor } from "../../../contracts/projects/index.js";
import { MAX_PROPOSED_COMPETITORS } from "../discovery/competitors.js";

// STORY-189 AC5 / owner decisions 88(c) and 91 — curated category peers, proposed as competitors.
//
// Peers come from a curated list per category (`category_peers`), NEVER from other customers' projects. Each is proposed with the basis
// "category peer" and a fixed confidence of 1.0 (decision 91: the list is curated, so there is no per-entry estimate to carry), AFTER
// the site's own comparison links, inside the same limit of five (STORY-043 AC11, product-spec §2.1).

export const CATEGORY_PEER_BASIS = "category peer";
export const CURATED_PEER_CONFIDENCE = 1;

export interface CategoryPeer {
  readonly name: string;
  readonly root_domain: string;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The project's own domain, or a subdomain of it. */
function isOwn(domain: string, ownDomain: string): boolean {
  const d = domain.toLowerCase();
  const o = ownDomain.toLowerCase();
  return d === o || d.endsWith(`.${o}`);
}

export function mergeCategoryPeers(input: {
  readonly own: readonly ProposedCompetitor[];
  readonly peers: readonly CategoryPeer[];
  readonly ownDomain: string;
}): ProposedCompetitor[] {
  const merged: ProposedCompetitor[] = [...input.own].slice(0, MAX_PROPOSED_COMPETITORS);
  const seenNames = new Set(merged.map((c) => norm(c.name)));
  const seenDomains = new Set(merged.flatMap((c) => (c.root_domain === undefined ? [] : [c.root_domain.toLowerCase()])));

  for (const peer of input.peers) {
    if (merged.length >= MAX_PROPOSED_COMPETITORS) break;
    if (isOwn(peer.root_domain, input.ownDomain)) continue;
    if (seenNames.has(norm(peer.name)) || seenDomains.has(peer.root_domain.toLowerCase())) continue;
    merged.push({ name: peer.name, root_domain: peer.root_domain, confidence: CURATED_PEER_CONFIDENCE, basis: CATEGORY_PEER_BASIS });
    seenNames.add(norm(peer.name));
    seenDomains.add(peer.root_domain.toLowerCase());
  }
  return merged;
}
