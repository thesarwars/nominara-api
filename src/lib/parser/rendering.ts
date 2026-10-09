import type { AnswerElement } from "../engines/contract.js";

// STORY-039 — render form, attributes, and the D4 score.
//
// `scoring-models.md` §8, and `tracking-engine.md` Stage 5 — which says the
// render form and the position class "are extracted in the SAME PASS, from
// the structured elements where the vendor provides them and from the
// markdown structure otherwise". This file and answer-structure.ts share that
// input for exactly that reason.
//
// THE RETROACTIVITY POINT IS WHY THIS IS NOT DEFERRABLE. Attributes come from
// TYPED ELEMENTS in the response payload, and the stored text does not contain
// them. A capture taken before this exists has no rendering data and NO
// RE-PARSE CAN RECOVER IT — which is precisely the position a competitor
// retrofitting this differentiator finds themselves in.

/** `mention_facts.render_form`'s CHECK, verbatim. */
export type RenderForm = "bare_text" | "linked" | "described" | "structured_row" | "featured";

/** `mention_facts.render_attrs`' documented set, verbatim. */
export type RenderAttr = "price" | "rating" | "review_count" | "image" | "availability" | "description" | "link" | "spec";

/** §8's `attr_weight`, verbatim. */
export const ATTR_WEIGHT: Readonly<Record<RenderAttr, number>> = Object.freeze({
  price: 0.28,
  rating: 0.22,
  image: 0.16,
  spec: 0.14,
  description: 0.1,
  link: 0.06,
  availability: 0.04,
  // §8 folds review_count into rating ("includes review_count when present"),
  // so it carries no weight of its own. Recorded as an attribute anyway
  // because `render_attrs` lists it and a customer asking "does the answer
  // show my review count" deserves an answer — it just does not double-count.
  review_count: 0,
});

/** §8's `form_multiplier`, verbatim. */
export const FORM_MULTIPLIER: Readonly<Record<RenderForm, number>> = Object.freeze({
  featured: 1.15,
  structured_row: 1.1,
  described: 1.0,
  linked: 0.85,
  bare_text: 0.6,
});

/**
 * The engines that can render attributes at all.
 *
 * `tracking-engine.md` §8: "Priced product elements — the source of `price`,
 * `rating`, `seller` — appear on **AI Mode only**." The two Google surfaces
 * are the only ones that emit typed elements; the conversational engines
 * return prose, and no amount of parsing turns prose into a priced element.
 *
 * AC6 — an engine that cannot render attributes is EXCLUDED FROM ITS OWN
 * DENOMINATOR, not scored zero. The same fairness rule as a failed cell: a
 * measurement we cannot make is not a zero, and penalising a brand for an
 * engine's output format would be wrong.
 */
export const ATTRIBUTE_CAPABLE_ENGINES: readonly string[] = ["google_ai_mode", "google_aio"];

/** AC5 — priced elements are AI Mode's alone, and the score says so per engine. */
export const PRICED_ELEMENT_ENGINES: readonly string[] = ["google_ai_mode"];

export function engineRendersAttributes(engineKey: string): boolean {
  return ATTRIBUTE_CAPABLE_ENGINES.includes(engineKey);
}

export function engineHasPricedElements(engineKey: string): boolean {
  return PRICED_ELEMENT_ENGINES.includes(engineKey);
}

export interface RenderingInput {
  /** The normalised answer. */
  readonly text: string;
  /** The mention's span in `text`. */
  readonly mention: { readonly start: number; readonly end: number };
  readonly engineKey: string;
  /** The element containing the mention, where the vendor provided one. */
  readonly element?: AnswerElement;
  /** True when the answer names this mention as its primary recommendation. */
  readonly isPrimaryRecommendation?: boolean;
}

export interface RenderingResult {
  readonly form: RenderForm;
  readonly attrs: readonly RenderAttr[];
  /** §8's `render_score_adj`, clamped to [0,1]. */
  readonly score: number;
  /**
   * AC5 — which attributes were unavailable because of the SURFACE rather
   * than because the answer omitted them.
   *
   * "Surface-specific priced elements must be recorded as such, or blending
   * would make one surface look structurally worse at rendering than it is —
   * a comparison the interface then has to avoid making."
   */
  readonly surfaceUnavailable: readonly RenderAttr[];
  /** AC6 — false when this engine renders no attributes at all. */
  readonly countsTowardDenominator: boolean;
  /** Whether the form came from a typed element or from markdown structure. */
  readonly derivedFrom: "element" | "markdown";
}

export const PRICED_ATTRS: readonly RenderAttr[] = ["price", "rating", "review_count", "availability"];

/**
 * Attributes from a typed element — the ONLY place they can come from.
 *
 * The stored text does not contain them, which is the whole retroactivity
 * argument. Nothing here reads prose looking for a price: a "$49/mo" in a
 * sentence is the engine talking about pricing, not the engine merchandising
 * the brand, and scoring it as the latter would invert the finding the metric
 * exists to report.
 */
function attrsFromElement(element: AnswerElement): RenderAttr[] {
  const attrs: RenderAttr[] = [];
  if (element.price !== undefined) attrs.push("price");
  if (element.rating !== undefined) attrs.push("rating");
  if (element.reviewCount !== undefined) attrs.push("review_count");
  if (element.image !== undefined) attrs.push("image");
  if (element.availability !== undefined) attrs.push("availability");
  if (element.description !== undefined) attrs.push("description");
  if (element.link !== undefined || element.links.length > 0) attrs.push("link");
  if (element.spec !== undefined && Object.keys(element.spec).length > 0) attrs.push("spec");
  return attrs;
}

/** The one attribute markdown can honestly evidence: the mention is a link. */
function attrsFromMarkdown(text: string, mention: { start: number; end: number }): RenderAttr[] {
  return isMarkdownLinkText(text, mention) ? ["link"] : [];
}

function isMarkdownLinkText(text: string, mention: { start: number; end: number }): boolean {
  const before = text.lastIndexOf("[", mention.start);
  if (before === -1) return false;
  const after = text.indexOf("]", mention.end);
  return after !== -1 && text.slice(after).startsWith("](");
}

/** `| … |` on the mention's line — a comparison-table or spec row. */
function isTableRow(text: string, mention: { start: number; end: number }): boolean {
  const lineStart = text.lastIndexOf("\n", Math.max(0, mention.start - 1)) + 1;
  const lineEnd = text.indexOf("\n", mention.start);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  return line.trimStart().startsWith("|") && line.trimEnd().endsWith("|");
}

/**
 * How much text follows the mention on its own line — the `described` test.
 *
 * A mention with a clause after it has been described; a mention standing
 * alone in a list has been named. Sixteen characters is a low bar and
 * deliberately so: the alternative is a model call, and §5 requires this pass
 * to be deterministic.
 */
const DESCRIBED_MIN_TRAILING = 16;

function isDescribed(text: string, mention: { start: number; end: number }): boolean {
  const lineEnd = text.indexOf("\n", mention.end);
  const trailing = text.slice(mention.end, lineEnd === -1 ? text.length : lineEnd);
  // A LINK TARGET IS NOT A DESCRIPTION. `[HubSpot](https://hubspot.com)`
  // leaves 22 characters of URL after the mention, which is more than the
  // threshold and none of it is prose — so `linked` would be scored as
  // `described` and paid a 1.00 multiplier instead of 0.85. A mention that is
  // BOTH linked and described still reads as described, because the check
  // resumes after the target.
  const withoutTarget = trailing.replace(/^\]\([^)]*\)/u, "");
  return withoutTarget.replace(/^[\s—–\-:,.]+/u, "").length >= DESCRIBED_MIN_TRAILING;
}

/**
 * AC1 and AC4 — the form, the attributes, and the adjusted score.
 *
 * POPULATED ON EVERY MENTION FROM THE FIRST CAPTURE (AC3): not conditionally,
 * not for tracked entities only. An untracked entity that turns out to be a
 * competitor is promoted later, and its rendering history has to already
 * exist — the same precondition argument STORY-036's untracked mentions rest
 * on.
 */
export function classifyRendering(input: RenderingInput): RenderingResult {
  const capable = engineRendersAttributes(input.engineKey);
  const attrs = input.element !== undefined ? attrsFromElement(input.element) : attrsFromMarkdown(input.text, input.mention);
  const form = classifyRenderForm(input, attrs);

  const raw = attrs.reduce((total, attr) => total + ATTR_WEIGHT[attr], 0);
  const score = Math.min(1, Math.max(0, raw * FORM_MULTIPLIER[form]));

  return {
    form,
    attrs,
    score,
    // A priced attribute absent on an engine WITHOUT priced elements is a
    // property of the surface, not of the answer. Recorded so the interface
    // can compare an engine to its own history rather than to a surface that
    // was never able to answer.
    surfaceUnavailable: engineHasPricedElements(input.engineKey) ? [] : PRICED_ATTRS,
    countsTowardDenominator: capable,
    derivedFrom: input.element !== undefined ? "element" : "markdown",
  };
}

export function classifyRenderForm(input: RenderingInput, attrs: readonly RenderAttr[]): RenderForm {
  if (input.isPrimaryRecommendation === true) return "featured";
  if (input.element?.kind === "table_element" || input.element?.kind === "shopping_element") return "structured_row";
  if (isTableRow(input.text, input.mention)) return "structured_row";
  if (isDescribed(input.text, input.mention)) return "described";
  if (attrs.includes("link") || isMarkdownLinkText(input.text, input.mention)) return "linked";
  return "bare_text";
}

/**
 * §8's aggregate — prominence-weighted, over the mentions that count.
 *
 * NULL WHEN THERE ARE NO MENTIONS, never 0. §8's own rule: "Absence and a
 * bare-text mention are different facts." This is one of the two highest-risk
 * correctness bugs the plan names, and returning 0 here would be it.
 *
 * Mentions on attribute-incapable engines are dropped from BOTH the numerator
 * and the denominator, which is what "excluded from its own denominator"
 * means arithmetically.
 */
export function renderingQuality(
  mentions: readonly { readonly prominence: number; readonly rendering: RenderingResult }[],
): number | null {
  const counted = mentions.filter((mention) => mention.rendering.countsTowardDenominator);
  const denominator = counted.reduce((total, mention) => total + mention.prominence, 0);
  if (counted.length === 0 || denominator === 0) return null;

  const numerator = counted.reduce((total, mention) => total + mention.prominence * mention.rendering.score, 0);
  return 100 * (numerator / denominator);
}

/**
 * AC8 — the share of parsed mentions successfully classified, with an alarm
 * below the threshold.
 *
 * "Successfully classified" means an element was available and used.
 * A run in which every mention fell back to markdown on an
 * attribute-capable engine means the adapter stopped emitting elements —
 * which is a vendor change, and the same class of detector as STORY-037's
 * resolution-failure alarm.
 */
export const CLASSIFICATION_COVERAGE_FLOOR = 0.8;
export const COVERAGE_ALARM_MIN_SAMPLE = 50;

export function shouldAlertOnCoverage(capableMentions: number, classifiedFromElements: number): boolean {
  if (capableMentions < COVERAGE_ALARM_MIN_SAMPLE) return false;
  return classifiedFromElements / capableMentions < CLASSIFICATION_COVERAGE_FLOOR;
}
