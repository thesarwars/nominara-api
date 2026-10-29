// STORY-047 AC3 - which new group is which old cluster.
//
// BY MEMBERSHIP, NOT BY CENTROID. A user's rename must survive a model switch, and a centroid from another model's vector space
// cannot be compared (EC-23); membership can. That holds for a switch of the WHOLE project at once. A gradual re-embed releases the
// prompts re-embedded so far at every run, so the evidence thins out and a rename can be lost: STORY-186 must switch a project's
// prompts atomically (or keep membership evidence across the switch), and needs a gradual re-embed test when it has a producer. A group takes the old cluster most of its members came from, so the cluster keeps its
// id (goals and the UI hold it), its label and, if renamed, its `label_source = 'user'`.
//
// A cluster that DISSOLVES - no new group shares at least half of the smaller side with it - is deleted with its label, a user's
// rename included: there is no group left that is that topic. The label is then free for the new group to reuse (the writer deletes
// the dissolved cluster before inserting the new ones). Pinned by a test; transferring a user label to the best-overlapping
// unmatched group is a possible refinement the story does not ask for.

export interface GroupOverlap {
  readonly index: number;
  readonly memberCount: number;
  /** Old cluster id -> how many of this group's members were assigned to it before. */
  readonly overlaps: ReadonlyMap<string, number>;
}

export interface OldCluster {
  readonly id: string;
  /** Members it has now, counted from the prompt rows (not the stored `prompt_count`, which a failed run could leave stale). */
  readonly memberCount: number;
  readonly labelSource: "auto" | "user";
}

/**
 * Greedy, one-to-one: pairs are taken by descending overlap; a pair is eligible when the overlap is at least half of the SMALLER of
 * the two sides (a split keeps the label on the larger half; a cluster that lost most of its members still maps). On equal overlap a
 * user-labelled cluster wins - that is the one that must not be lost - then the lower id, so the result is deterministic.
 */
export function matchGroupsToClusters(groups: readonly GroupOverlap[], olds: readonly OldCluster[]): Map<number, string> {
  const oldById = new Map(olds.map((old) => [old.id, old]));
  const pairs: { index: number; id: string; overlap: number; user: boolean }[] = [];
  for (const group of groups) {
    for (const [id, overlap] of group.overlaps) {
      const old = oldById.get(id);
      if (old === undefined || overlap <= 0) continue;
      if (overlap * 2 < Math.min(group.memberCount, old.memberCount)) continue;
      pairs.push({ index: group.index, id, overlap, user: old.labelSource === "user" });
    }
  }
  pairs.sort((a, b) => b.overlap - a.overlap || Number(b.user) - Number(a.user) || a.id.localeCompare(b.id) || a.index - b.index);
  const matched = new Map<number, string>();
  const used = new Set<string>();
  for (const pair of pairs) {
    if (matched.has(pair.index) || used.has(pair.id)) continue;
    matched.set(pair.index, pair.id);
    used.add(pair.id);
  }
  return matched;
}
