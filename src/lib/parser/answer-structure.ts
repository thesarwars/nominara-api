import type { AnswerElement } from "../engines/contract.js";

// STORY-040 — answer form and position class.
//
// `tracking-engine.md` Stage 5, the same pass as rendering.ts.
//
// POSITION-CLASS MOVEMENT IS THE DIFFERENTIATING TREND, and the story is
// blunt about why storing it per mention is not optional: "A brand that stays
// mentioned while sliding from recommendation to also-consider is losing, and
// EVERY MENTION-COUNTING TOOL REPORTS IT AS FLAT. Storing the class per
// mention is what makes that trend available at all."

/** `mention_facts.answer_form`'s CHECK, verbatim. */
export type AnswerForm = "ranked_list" | "comparison_table" | "single_recommendation" | "neutral_enumeration" | "narrative";

/** `mention_facts.position_class`'s CHECK, verbatim. */
export type PositionClass = "recommendation" | "ranked" | "neutral_list" | "also_consider" | "caveat";

/**
 * AC4 — "the derivation method is recorded so the two are distinguishable in
 * analysis."
 *
 * The story's reason: "the two paths have different reliability, and an
 * analysis that mixes them without knowing would over-trust the inferred
 * half." A `derived` class came from which element the mention sits in; an
 * `inferred` one came from positional and linguistic cues and can be wrong in
 * ways the first cannot.
 */
export type DerivationMethod = "derived" | "inferred";

export interface AnswerStructure {
  readonly form: AnswerForm;
  readonly method: DerivationMethod;
  /** AC9 — true when the form fell back rather than being classified. */
  readonly fellBack: boolean;
}

/** An ordered list item: `1.` or `1)`. */
const ORDERED_ITEM = /^\s*\d+[.)]\s+\S/u;
/** A bulleted item. */
const BULLET_ITEM = /^\s*[-*+]\s+\S/u;
/** A markdown table row. */
const TABLE_ROW = /^\s*\|.*\|\s*$/u;

/**
 * Cues that make an enumeration a RANKING rather than a list.
 *
 * The distinction matters: `ranked_list` says the engine expressed an order
 * it stands behind, `neutral_enumeration` says it listed options. A numbered
 * list is not automatically a ranking — engines number neutral lists all the
 * time — so the ordinal alone is not enough.
 */
const RANKING_CUES: readonly string[] = ["best", "top", "ranked", "leading", "#1", "in order", "our pick"];

/** Cues that make a single-recommendation answer identifiable. */
const SINGLE_RECOMMENDATION_CUES: readonly string[] = [
  "the best choice is",
  "we recommend",
  "i recommend",
  "the top choice is",
  "your best option is",
  "the clear winner is",
];

/**
 * AC1 — the answer form, per prompt and per engine.
 *
 * PREFERS THE ELEMENTS. A `table_element` is a comparison table as a matter
 * of fact; reading the markdown to reach the same conclusion is a guess that
 * happens to be right. Where elements exist the method is `derived`.
 */
export function classifyAnswerForm(text: string, elements?: readonly AnswerElement[]): AnswerStructure {
  if (elements !== undefined && elements.length > 0) {
    if (elements.some((element) => element.kind === "table_element")) {
      return { form: "comparison_table", method: "derived", fellBack: false };
    }
    if (elements.some((element) => element.kind === "shopping_element")) {
      return { form: "ranked_list", method: "derived", fellBack: false };
    }
  }

  const lines = text.split("\n");
  const tableRows = lines.filter((line) => TABLE_ROW.test(line)).length;
  const ordered = lines.filter((line) => ORDERED_ITEM.test(line)).length;
  const bulleted = lines.filter((line) => BULLET_ITEM.test(line)).length;
  const lowered = text.toLowerCase();

  // Two rows is a header and one entry, which is not yet a comparison. Three
  // is a header, a separator and a row — the smallest real table.
  if (tableRows >= 3) return { form: "comparison_table", method: "inferred", fellBack: false };

  if (ordered >= 2) {
    const ranked = RANKING_CUES.some((cue) => lowered.includes(cue));
    return { form: ranked ? "ranked_list" : "neutral_enumeration", method: "inferred", fellBack: false };
  }

  if (bulleted >= 2) return { form: "neutral_enumeration", method: "inferred", fellBack: false };

  if (SINGLE_RECOMMENDATION_CUES.some((cue) => lowered.includes(cue))) {
    return { form: "single_recommendation", method: "inferred", fellBack: false };
  }

  // AC9 — "An unclassifiable answer falls back to the NARRATIVE form rather
  // than to null, and the fallback is recorded." Null would make the
  // distribution over a window incomputable; an unrecorded fallback would
  // make narrative look like a finding rather than an absence of one.
  return { form: "narrative", method: "inferred", fellBack: true };
}

export interface PositionInput {
  /** The normalised answer. */
  readonly text: string;
  readonly mention: { readonly start: number; readonly end: number };
  readonly answerForm: AnswerForm;
  /** 1-based, from the entity matcher, where the mention sits in a list. */
  readonly listPosition: number | null;
  /** The elements, in order, when the surface provides them. */
  readonly elements?: readonly AnswerElement[];
  /** Which element the mention sits in — the index into `elements`. */
  readonly elementIndex?: number;
}

export interface PositionResult {
  readonly positionClass: PositionClass;
  readonly method: DerivationMethod;
}

/** Openings that mark a trailing "also consider" section. */
const ALSO_CONSIDER_CUES: readonly string[] = [
  "also consider",
  "other options",
  "alternatives include",
  "you might also",
  "worth mentioning",
  "honourable mention",
  "honorable mention",
];

/** Language that makes the enclosing sentence a warning about the mention. */
const CAVEAT_CUES: readonly string[] = [
  "however",
  "but note",
  "be aware",
  "caveat",
  "drawback",
  "downside",
  "avoid",
  "struggles",
  "not suitable",
  "falls short",
];

const RECOMMENDATION_CUES: readonly string[] = [
  "we recommend",
  "i recommend",
  "the best choice",
  "best suited",
  "the top choice",
  "our pick",
  "go-to",
];

/**
 * AC2, AC3 and AC4 — the position class, DERIVED where the surface allows it.
 *
 * "On engines exposing per-element references the position class is derived
 * from which element the mention sits in, NOT INFERRED FROM CHARACTER
 * OFFSETS. A mention in the lead element is a recommendation; one in a
 * trailing element is a caveat."
 *
 * The story explains what that buys: "Character-offset heuristics confuse a
 * caveat at the end of a long recommendation paragraph with a genuine
 * trailing caveat. Per-element references remove the guess entirely."
 *
 * DETERMINISTIC, WITH NO MODEL CALL (AC6).
 */
export function classifyPositionClass(input: PositionInput): PositionResult {
  const derived = deriveFromElement(input);
  if (derived !== null) return { positionClass: derived, method: "derived" };
  return { positionClass: inferFromText(input), method: "inferred" };
}

function deriveFromElement(input: PositionInput): PositionClass | null {
  const { elements, elementIndex } = input;
  if (elements === undefined || elementIndex === undefined || elements.length === 0) return null;
  if (elementIndex < 0 || elementIndex >= elements.length) return null;

  if (elementIndex === 0) return "recommendation";
  if (elementIndex === elements.length - 1 && elements.length > 2) return "caveat";
  return input.answerForm === "ranked_list" ? "ranked" : "neutral_list";
}

function inferFromText(input: PositionInput): PositionClass {
  const sentence = enclosingParagraph(input.text, input.mention.start);
  const lowered = sentence.toLowerCase();

  // ORDER MATTERS: a caveat inside a recommendation clause is a caveat. A
  // sentence recommending a tool and then warning about it is warning about
  // it, and reading the recommendation first would lose the warning.
  if (CAVEAT_CUES.some((cue) => lowered.includes(cue))) return "caveat";
  if (isAfterAlsoConsiderHeading(input.text, input.mention.start)) return "also_consider";
  if (RECOMMENDATION_CUES.some((cue) => lowered.includes(cue))) return "recommendation";
  if (input.answerForm === "ranked_list" && input.listPosition !== null) return "ranked";
  return "neutral_list";
}

function enclosingParagraph(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const end = text.indexOf("\n", offset);
  return text.slice(start, end === -1 ? text.length : end);
}

/** Anything after an "also consider" line is in its tail until the next heading. */
function isAfterAlsoConsiderHeading(text: string, offset: number): boolean {
  const before = text.slice(0, offset).toLowerCase();
  const cueAt = Math.max(...ALSO_CONSIDER_CUES.map((cue) => before.lastIndexOf(cue)));
  if (cueAt === -1) return false;
  // A heading between the cue and the mention closes the tail.
  return !/\n#{1,6}\s/u.test(before.slice(cueAt));
}
