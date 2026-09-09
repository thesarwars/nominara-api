// STORY-038 step 2 — the cue lexicon.
//
// `tracking-engine.md` Stage 4 names five families and their polarities:
//
//   endorsement  ('recommended','best choice','ideal for','go-to')      +
//   capability   ('offers deeper','supports','handles')                 +weak
//   listing      ('options include','such as','among them')              0
//   caveat       ('flagged for','struggles with','limited','lacks')      −
//   defect       ('outage','degradation','bug','security incident')      −−
//
// ⚠ THE REFERENCE SPECIFIES "612 TUNED ENTRIES". THIS IS NOT THAT LEXICON.
//
// 612 entries tuned against a labelled corpus is a CURATION deliverable, not
// an implementation one, and the corpus it would be tuned against is
// STORY-106's golden set — deferred behind STORY-028. What is here is the
// families, the polarities, the scoring machinery, and a seed set built from
// the reference's own examples plus their obvious neighbours. It is enough to
// exercise every rule and to classify unambiguous language correctly; it is
// NOT enough to hit an accuracy gate, and STORY-038's scenario 13 cannot run.
//
// Recorded rather than approximated: a made-up 612 entries would look like the
// specified lexicon and behave like a guess.

export type CueFamily = "endorsement" | "capability" | "listing" | "caveat" | "defect";

/** §4's polarity column, as numbers. `listing` is 0 — a neutral cue is a real signal that the mention is enumerated, not absent evidence. */
export const FAMILY_POLARITY: Readonly<Record<CueFamily, number>> = Object.freeze({
  endorsement: 1.0,
  capability: 0.4,
  listing: 0,
  caveat: -0.7,
  defect: -1.0,
});

export interface Cue {
  readonly phrase: string;
  readonly family: CueFamily;
}

/**
 * Longest phrases first, so "best choice" is not scored as two weaker cues.
 *
 * "highly recommended" is DELIBERATELY ABSENT as a phrase. Listing it would
 * consume the intensifier along with the cue and the multiplier would never
 * apply — "highly recommended" would score exactly what "recommended" scores.
 * Composing them is both more accurate and the only way the intensifier
 * mechanism is reachable at all. The same reasoning keeps every other
 * intensifier out of the cue list.
 */
export const CUES: readonly Cue[] = [
  // endorsement
  { phrase: "best choice", family: "endorsement" },
  { phrase: "top choice", family: "endorsement" },
  { phrase: "the go-to", family: "endorsement" },
  { phrase: "go-to", family: "endorsement" },
  { phrase: "ideal for", family: "endorsement" },
  { phrase: "best suited", family: "endorsement" },
  { phrase: "stands out", family: "endorsement" },
  { phrase: "market leader", family: "endorsement" },
  { phrase: "recommended", family: "endorsement" },
  { phrase: "excellent", family: "endorsement" },
  { phrase: "outstanding", family: "endorsement" },
  // capability
  { phrase: "offers deeper", family: "capability" },
  { phrase: "integrates with", family: "capability" },
  { phrase: "scales to", family: "capability" },
  { phrase: "supports", family: "capability" },
  { phrase: "handles", family: "capability" },
  { phrase: "provides", family: "capability" },
  { phrase: "includes", family: "capability" },
  { phrase: "offers", family: "capability" },
  // listing
  { phrase: "options include", family: "listing" },
  { phrase: "among them", family: "listing" },
  { phrase: "alternatives include", family: "listing" },
  { phrase: "such as", family: "listing" },
  // caveat
  { phrase: "struggles with", family: "caveat" },
  { phrase: "falls short", family: "caveat" },
  { phrase: "flagged for", family: "caveat" },
  { phrase: "criticised for", family: "caveat" },
  { phrase: "criticized for", family: "caveat" },
  { phrase: "steep learning curve", family: "caveat" },
  { phrase: "expensive", family: "caveat" },
  { phrase: "limited", family: "caveat" },
  { phrase: "lacks", family: "caveat" },
  { phrase: "clunky", family: "caveat" },
  { phrase: "confusing", family: "caveat" },
  // defect
  { phrase: "security incident", family: "defect" },
  { phrase: "data breach", family: "defect" },
  { phrase: "service degradation", family: "defect" },
  { phrase: "degradation", family: "defect" },
  { phrase: "outage", family: "defect" },
  { phrase: "downtime", family: "defect" },
  { phrase: "vulnerability", family: "defect" },
  { phrase: "broken", family: "defect" },
  { phrase: "bug", family: "defect" },
];

/** Multipliers on the cue that follows them. */
export const INTENSIFIERS: Readonly<Record<string, number>> = Object.freeze({
  very: 1.5,
  extremely: 1.8,
  highly: 1.5,
  particularly: 1.3,
  especially: 1.3,
  somewhat: 0.6,
  slightly: 0.5,
  "a bit": 0.5,
  fairly: 0.8,
});

/**
 * Negations, which FLIP the cue rather than zeroing it.
 *
 * "not recommended" is a negative verdict, not an absent one — zeroing it
 * would read as neutral and lose the strongest signal in the sentence.
 */
export const NEGATIONS: readonly string[] = ["not", "never", "no", "isn't", "isn’t", "doesn't", "doesn’t", "without", "hardly", "rarely"];

/** How far before a cue an intensifier or negation still applies, in tokens. */
export const MODIFIER_WINDOW = 3;

/**
 * Distance decay — a cue next to the mention says more about it than one at
 * the far end of the sentence.
 *
 * Halves every 40 characters. Without decay, a sentence praising one tool and
 * criticising another attributes both verdicts to whichever mention is being
 * scored, which is the exact failure AC1 ("per mention, not per response")
 * exists to prevent.
 */
export const DECAY_HALF_LIFE = 40;

export function distanceDecay(characters: number): number {
  return Math.pow(0.5, Math.abs(characters) / DECAY_HALF_LIFE);
}
