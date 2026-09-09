// STORY-041 — `scoring-models.md` §2.1 and §2.2.
//
// ⚠ THIS DIRECTORY IMPORTS NOTHING. Not the standard library's clock, not
// randomness, not a database, not a logger, not another module of this
// codebase. `tracking-engine.md` Stage 6: "All per-result metrics are
// computed by the pure functions in `src/lib/scoring`."
//
// AC1 makes the constraint absolute rather than aspirational, and the story
// says why: "A hidden dependency on the clock or on a database read would
// make the golden set unable to distinguish a bug from an environment
// difference, and the gate would become advisory."
//
// So every input arrives as an argument and every output is a return value.
// A reviewer can verify the rule by reading the import list, which is empty.

/** Clamp to [0,1]. Everything in §2 is a ratio and nothing may leave the range. */
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** §2.1's four components, and the two multipliers applied after them. */
export const PROMINENCE_WEIGHTS = Object.freeze({ position: 0.4, frequency: 0.2, listRank: 0.4 });

/** §2.1 — `clause_bonus`. */
export const CLAUSE_BONUS = Object.freeze({
  /** In a recommendation clause. */
  recommendation: 1.2,
  /** Anywhere ordinary. */
  neutral: 1.0,
  /** Only in an "also consider" or caveat tail. */
  tail: 0.75,
});

/** §2.5 — "Contrastive pivot away from the entity: prominence × 0.851 (fitted on the golden set)." */
export const CONTRASTIVE_PIVOT_FACTOR = 0.851;

/** §2.1 — a mention not in a ranked list still scores, at a documented constant. */
export const UNRANKED_LIST_SCORE = 0.65;

/** §2.1 — `frequency_score` saturates at three occurrences. */
export const FREQUENCY_SATURATION = 3;

export type ClauseKind = keyof typeof CLAUSE_BONUS;

export interface MentionInput {
  /** Which entity this mention is of. Grouping key for §2.1's entity-level max. */
  readonly entityKey: string;
  /** `mention_facts.char_start`, into the normalised response. */
  readonly charStart: number;
  /** 1-based rank within a ranked list, or null. */
  readonly listPosition: number | null;
  readonly clause: ClauseKind;
  /** §2.5's contrastive-pivot case. */
  readonly contrastivePivotAway: boolean;
  /**
   * §2.1 — "Mentions with `in_link = true` — the brand appears only inside a
   * URL — are EXCLUDED. That is a citation, counted in §4."
   */
  readonly inLink: boolean;
}

export interface ResponseInput {
  /** `L` in §2.1 — the response length in characters. */
  readonly responseLength: number;
  readonly mentions: readonly MentionInput[];
}

/** §2.1 — `position_score(m) = 1 − (char_start(m) / L)`. */
export function positionScore(charStart: number, responseLength: number): number {
  // A zero-length response has no positions. Guarded rather than dividing:
  // `1 - 0/0` is NaN, and a NaN propagating into a headline score is the
  // failure mode that is hardest to trace back here.
  if (responseLength <= 0) return 0;
  return clamp01(1 - charStart / responseLength);
}

/** §2.1 — `frequency_score(e) = min(1, occurrences(e) / 3)`. */
export function frequencyScore(occurrences: number): number {
  return clamp01(occurrences / FREQUENCY_SATURATION);
}

/** §2.1 — `1 / sqrt(list_position)` in a ranked list, else the documented constant. */
export function listRankScore(listPosition: number | null): number {
  if (listPosition === null || listPosition < 1) return UNRANKED_LIST_SCORE;
  return 1 / Math.sqrt(listPosition);
}

/**
 * §2.1 — one mention's prominence.
 *
 * The clamp is INSIDE the clause bonus, exactly as the reference writes it:
 * `clamp01(0.40·position + 0.20·frequency + 0.40·listRank) · clause_bonus`.
 * A recommendation clause can therefore take a mention above 1.0, and §2.2
 * never divides by anything that assumes otherwise. Clamping afterwards
 * instead would silently cap every first-position recommendation at 1.0 and
 * flatten the top of the distribution — the reference's own worked example
 * gives HubSpot 0.874 with a 1.20 bonus, which only reproduces this way.
 */
export function mentionProminence(mention: MentionInput, occurrences: number, responseLength: number): number {
  const base = clamp01(
    PROMINENCE_WEIGHTS.position * positionScore(mention.charStart, responseLength) +
      PROMINENCE_WEIGHTS.frequency * frequencyScore(occurrences) +
      PROMINENCE_WEIGHTS.listRank * listRankScore(mention.listPosition),
  );
  const withClause = base * CLAUSE_BONUS[mention.clause];
  return mention.contrastivePivotAway ? withClause * CONTRASTIVE_PIVOT_FACTOR : withClause;
}

/**
 * §2.1 — entity prominence in one response is the MAXIMUM over its mentions,
 * NOT the sum.
 *
 * The reference states the consequence: "so a brand named ten times in a
 * dismissive aside cannot outrank a brand recommended once." Summing rewards
 * repetition over placement, and repetition is the cheap thing to
 * manufacture.
 *
 * Link-only mentions are dropped first. A brand appearing solely inside a
 * citation URL has `prominence = 0` here and a `citation_share > 0` in §4 —
 * §2.5's `citation_only_presence` case.
 */
export function entityProminence(response: ResponseInput): Map<string, number> {
  const visible = response.mentions.filter((mention) => !mention.inLink);

  const occurrences = new Map<string, number>();
  for (const mention of visible) {
    occurrences.set(mention.entityKey, (occurrences.get(mention.entityKey) ?? 0) + 1);
  }

  const best = new Map<string, number>();
  for (const mention of visible) {
    const value = mentionProminence(mention, occurrences.get(mention.entityKey) ?? 1, response.responseLength);
    best.set(mention.entityKey, Math.max(best.get(mention.entityKey) ?? 0, value));
  }
  return best;
}

/** §2.5's flags, verbatim. */
export type ResponseFlag =
  | "no_entities_detected"
  | "engine_refused_to_answer"
  | "citation_only_presence"
  | "single_entity_answer";

export interface ResponseShare {
  /** Per entity, `prominence(e,c) / denominator(c)`. */
  readonly sov: Map<string, number>;
  readonly denominator: number;
  readonly flags: readonly ResponseFlag[];
}

/**
 * §2.2 — per-response share of voice.
 *
 * THE DENOMINATOR INCLUDES UNTRACKED ENTITIES (`Other(c)`), and the reference
 * is emphatic: "a brand that is 1-of-2 mentioned has a genuinely higher share
 * than one that is 1-of-9, and excluding unknown competitors would inflate
 * every score." Nothing in this function distinguishes tracked from untracked
 * — that is the point, and it is why STORY-036 records untracked entities at
 * all.
 */
export function responseShareOfVoice(response: ResponseInput, brandKey: string): ResponseShare {
  const prominence = entityProminence(response);
  const denominator = [...prominence.values()].reduce((total, value) => total + value, 0);

  const sov = new Map<string, number>();
  for (const [entityKey, value] of prominence) {
    // §2.2 — `= 0 otherwise`. A zero denominator means nothing was detected,
    // and every share is 0 rather than NaN.
    sov.set(entityKey, denominator > 0 ? value / denominator : 0);
  }

  const flags: ResponseFlag[] = [];
  if (prominence.size === 0) flags.push("no_entities_detected");
  if (prominence.size === 1 && prominence.has(brandKey)) flags.push("single_entity_answer");
  // §2.5 — the brand appears ONLY inside a URL. Detectable exactly here:
  // it has link mentions and no visible ones.
  if (
    !prominence.has(brandKey) &&
    response.mentions.some((mention) => mention.entityKey === brandKey && mention.inLink)
  ) {
    flags.push("citation_only_presence");
  }

  return { sov, denominator, flags };
}
