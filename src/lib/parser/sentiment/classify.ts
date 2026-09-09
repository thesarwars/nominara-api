import type { Span } from "../normalize.js";
import { adjudicate, type NegativeReason, type SentimentArbiter } from "./arbiter.js";
import { CUES, distanceDecay, FAMILY_POLARITY, INTENSIFIERS, MODIFIER_WINDOW, NEGATIONS } from "./lexicon.js";
import { evidenceWindow } from "./window.js";

// STORY-038 steps 2–6 — score, adjust, calibrate, escalate, adjudicate.
//
// PER MENTION, NOT PER RESPONSE (AC1). The same answer can endorse the brand
// and criticise a competitor, and the distance decay in `lexicon.ts` is what
// makes that hold: a cue next to one mention barely reaches the other.

/** `mention_facts.sentiment_label`'s CHECK, verbatim. */
export type SentimentLabel = "positive" | "neutral" | "negative";

/** `mention_facts.sentiment_method`'s CHECK, verbatim. */
export type SentimentMethod = "lexicon" | "heuristic" | "llm_arbiter" | "arbiter_rejected";

export interface StructuralContext {
  /** 1-based list position, or null outside a list. */
  readonly listPosition: number | null;
  readonly isRankedList: boolean;
  readonly inRecommendationClause: boolean;
  /** The sentence pivots away from this mention — "X is good, but Y is better". */
  readonly contrastivePivotAway: boolean;
  readonly inAlsoConsiderTail: boolean;
  /** A complaint-source citation shares the sentence. */
  readonly nearComplaintCitation: boolean;
}

export const NEUTRAL_STRUCTURE: StructuralContext = Object.freeze({
  listPosition: null,
  isRankedList: false,
  inRecommendationClause: false,
  contrastivePivotAway: false,
  inAlsoConsiderTail: false,
  nearComplaintCitation: false,
});

export interface SentimentVerdict {
  readonly label: SentimentLabel;
  readonly score: number;
  readonly confidence: number;
  readonly method: SentimentMethod;
  /** AC3 — there is no verdict without the sentence that caused it. */
  readonly evidenceSpan: Span;
  readonly evidenceText: string;
  readonly negativeReasons: readonly NegativeReason[];
  /** Whether the confidence band called for the arbiter, whatever came of it. */
  readonly escalated: boolean;
}

/**
 * §4 step 3 — structural adjustments, DETERMINISTIC AND WITH NO MODEL CALL.
 *
 * The five numbers are the reference's, verbatim. They are additive on the
 * lexicon score rather than multiplicative because the reference writes them
 * with signs and magnitudes ("+0.15", "−0.30") rather than as factors, and a
 * multiplicative reading would make every adjustment vanish on a
 * zero-scoring sentence — where a mention sitting alone at position one of a
 * ranked list is precisely the case worth a nudge.
 */
export function structuralAdjustment(context: StructuralContext): number {
  let adjustment = 0;
  if (context.isRankedList && context.listPosition === 1) adjustment += 0.15;
  if (context.inRecommendationClause) adjustment += 0.2;
  if (context.contrastivePivotAway) adjustment -= 0.25;
  if (context.inAlsoConsiderTail) adjustment -= 0.3;
  if (context.nearComplaintCitation) adjustment -= 0.2;
  return adjustment;
}

interface ScoredCue {
  readonly family: string;
  readonly contribution: number;
}

/**
 * §4 step 2 — `Σ(cue polarity × intensifier × negation-flip × distance decay)`.
 *
 * Cues are matched longest-first and consumed, so "best choice" scores once as
 * an endorsement rather than twice as two weaker overlapping cues.
 */
export function lexiconScore(evidence: string, mentionOffsetInEvidence: number): { score: number; cues: ScoredCue[] } {
  const lowered = evidence.toLowerCase();
  const consumed = new Array<boolean>(lowered.length).fill(false);
  const cues: ScoredCue[] = [];
  let score = 0;

  const ordered = [...CUES].sort((a, b) => b.phrase.length - a.phrase.length);
  for (const cue of ordered) {
    let from = 0;
    for (;;) {
      const at = lowered.indexOf(cue.phrase, from);
      if (at === -1) break;
      from = at + 1;
      if (consumed.slice(at, at + cue.phrase.length).some(Boolean)) continue;
      for (let i = at; i < at + cue.phrase.length; i += 1) consumed[i] = true;

      const modifiers = precedingModifiers(lowered, at);
      const contribution =
        FAMILY_POLARITY[cue.family] *
        modifiers.intensifier *
        modifiers.negationFlip *
        distanceDecay(at - mentionOffsetInEvidence);
      score += contribution;
      cues.push({ family: cue.family, contribution });
    }
  }

  return { score, cues };
}

/** The intensifier and negation applying to a cue, from the few tokens before it. */
function precedingModifiers(lowered: string, cueStart: number): { intensifier: number; negationFlip: number } {
  const before = lowered.slice(0, cueStart).trimEnd().split(/\s+/u).slice(-MODIFIER_WINDOW);
  let intensifier = 1;
  let negationFlip = 1;

  for (const token of before) {
    const word = token.replace(/[^\p{L}'’-]/gu, "");
    if (NEGATIONS.includes(word)) negationFlip = -1;
    const factor = INTENSIFIERS[word];
    if (factor !== undefined) intensifier = factor;
  }
  return { intensifier, negationFlip };
}

/**
 * §4 step 4 — `confidence = |score| mapped through a logistic fitted on the
 * golden set`.
 *
 * ⚠ NOT FITTED. The golden set is STORY-106's and is deferred behind
 * STORY-028, so there is nothing to fit against. The midpoint and steepness
 * below are chosen so the reference's own band — `[0.35, 0.75]` — lands where
 * it is supposed to. Calibrated against the three cases that have to be right:
 * NO CUE AT ALL is confidently neutral (0 → 0.10, below the band); a SINGLE
 * FULL-STRENGTH CUE is confident (0.8 → 0.94, above it); and a SINGLE WEAK
 * CAPABILITY CUE — "HubSpot supports pipelines", which is genuinely
 * ambiguous — lands inside it (0.35 → 0.50) and escalates. A midpoint that
 * put an unambiguous endorsement inside the band was the first thing tried
 * and would have escalated most mentions, blowing §4's 12% target.
 *
 * **Refitting these two numbers against the labelled corpus is part of
 * STORY-106's work**, and until it happens the escalation RATE is calibrated
 * against three hand-picked cases rather than a distribution — so §4's 12%
 * target cannot yet be evaluated.
 *
 * Stated here rather than buried: a calibration curve that looks fitted and
 * is not is worse than one that says so.
 */
export const CALIBRATION_MIDPOINT = 0.35;
export const CALIBRATION_STEEPNESS = 6;

export function calibrateConfidence(score: number): number {
  return 1 / (1 + Math.exp(-CALIBRATION_STEEPNESS * (Math.abs(score) - CALIBRATION_MIDPOINT)));
}

/** §4 step 5 — `if confidence ∈ [0.35, 0.75] → capture.arbitrate`. */
export const ESCALATION_BAND = Object.freeze({ low: 0.35, high: 0.75 });

export function isInEscalationBand(confidence: number): boolean {
  return confidence >= ESCALATION_BAND.low && confidence <= ESCALATION_BAND.high;
}

/** A score either side of the dead zone is a verdict; inside it, neutral. */
const NEUTRAL_BAND = 0.15;

export function labelFor(score: number): SentimentLabel {
  if (score > NEUTRAL_BAND) return "positive";
  if (score < -NEUTRAL_BAND) return "negative";
  return "neutral";
}

export interface ClassifyInput {
  /** The whole normalised answer. */
  readonly text: string;
  /** The mention's span in `text`. */
  readonly mention: Span;
  readonly structure?: StructuralContext;
  /** Unbound in production today — see arbiter.ts. */
  readonly arbiter?: SentimentArbiter;
}

/**
 * One mention's verdict.
 *
 * THE ARBITER IS CALLED ONLY INSIDE THE BAND (AC7). The story's note is the
 * whole cost-and-safety argument: "Most mentions are unambiguous, so a
 * deterministic pass resolves the large majority at zero model cost. Calling a
 * model on everything would multiply cost and — more importantly — make the
 * metric depend on a model's mood for cases the lexicon already gets right."
 *
 * With no arbiter bound, an in-band mention finalises on the deterministic
 * result and reports `escalated: true` anyway — so the escalation RATE is
 * measurable before a model exists, which is what AC12's alarm needs.
 */
export async function classifyMention(input: ClassifyInput): Promise<SentimentVerdict> {
  const structure = input.structure ?? NEUTRAL_STRUCTURE;
  const window = evidenceWindow(input.text, input.mention);
  const mentionOffset = input.mention.start - window.span.start;

  const lexicon = lexiconScore(window.text, mentionOffset);
  const adjustment = structuralAdjustment(structure);
  const score = lexicon.score + adjustment;
  const confidence = calibrateConfidence(score);
  const escalated = isInEscalationBand(confidence);

  const base = {
    score,
    evidenceSpan: window.span,
    evidenceText: window.text,
    negativeReasons: reasonsFor(score, structure),
  };

  if (!escalated) {
    return {
      ...base,
      label: labelFor(score),
      confidence,
      // `heuristic` when the structure moved the number, `lexicon` when the
      // cues alone decided it. The distinction is what makes a disputed
      // verdict traceable to a rule rather than to "the classifier".
      method: adjustment === 0 ? "lexicon" : "heuristic",
      escalated: false,
    };
  }

  if (input.arbiter === undefined) {
    // No model bound. The deterministic answer stands and says which rule
    // produced it — NOT `arbiter_rejected`, which would claim a model
    // answered badly when none was asked.
    return { ...base, label: labelFor(score), confidence, method: adjustment === 0 ? "lexicon" : "heuristic", escalated: true };
  }

  const outcome = await adjudicate(input.arbiter, window.text);
  if (outcome.kind === "rejected") {
    // FAILS CLOSED TO NEUTRAL. The worst case is a lost signal, never a wrong
    // verdict — which is what makes a successful injection worthless.
    return { ...base, label: "neutral", confidence: 0, method: "arbiter_rejected", negativeReasons: [], escalated: true };
  }

  return {
    ...base,
    label: outcome.response.label,
    confidence: outcome.response.confidence,
    method: "llm_arbiter",
    negativeReasons: outcome.response.negative_reasons,
    escalated: true,
  };
}

/**
 * The deterministic slice of the negative reason taxonomy.
 *
 * ONLY WHAT IS DERIVABLE. `complaint_thread_cited` follows from a complaint
 * citation sharing the sentence — that is a structural fact, not a reading.
 * The other ten reasons require understanding the sentence, and inventing
 * them from a cue family would put a confident cause on a verdict nobody
 * diagnosed. The arbiter supplies them when it is bound; until then a
 * negative mention with no discernible reason carries none, which is the
 * honest answer.
 */
function reasonsFor(score: number, structure: StructuralContext): NegativeReason[] {
  if (score >= 0) return [];
  return structure.nearComplaintCitation ? ["complaint_thread_cited"] : [];
}
