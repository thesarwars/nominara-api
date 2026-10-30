// STORY-041 — `scoring-models.md` §2.3, §4 and §6.
//
// ⚠ IMPORTS NOTHING. See prominence.ts.

/**
 * One cell in a window, as the aggregate sees it.
 *
 * THE THREE STATES ARE NOT COLLAPSIBLE, and keeping them apart is most of
 * what this file does:
 *
 *   `answered`  the engine answered. The brand may or may not be in it.
 *   `refused`   the engine answered by refusing. §2.5: `sov = 0`, and THE
 *               CELL COUNTS IN THE DENOMINATOR — a refusal is data.
 *   `failed`    we could not ask. §2.5: EXCLUDED from both numerator and
 *               denominator.
 *
 * The reference states the distinction in one line and it is the whole
 * design: **"The engine did not mention you" is data. "We could not ask" is
 * not.**
 */
export type CellStatus = "answered" | "refused" | "failed";

export interface Cell {
  readonly status: CellStatus;
  /** `w_e` — `project_engines.weight`, default 1.0. */
  readonly engineWeight: number;
  /** The entity's per-response share, from §2.2. Ignored on a failed cell. */
  readonly sov: number;
  /** Whether the brand was present at all — §3's `PresenceRate`. */
  readonly brandPresent: boolean;
}

/**
 * §2.3 — share of voice over a timeframe.
 *
 * ⚠ **THE HIGHEST-RISK CORRECTNESS BUG IN THE PRODUCT LIVES IN THIS
 * FUNCTION**, and `NFR-ANL-02` requires it to have a dedicated test.
 *
 * AN ABSENT BRAND CONTRIBUTES `sov = 0` TO THE NUMERATOR AND `w` TO THE
 * DENOMINATOR. It is NOT excluded. The reference: "Excluding absent cells
 * would report a brand mentioned in 1 of 90 cells as having 100% share of
 * voice."
 *
 * The story is equally direct about why it is worth this much comment: "the
 * wrong behaviour is the intuitive one. Excluding absent cells feels like
 * 'only measure what we saw'." Every reviewer pauses here, so the code says
 * what it is doing rather than leaving the filter below to be read as an
 * oversight.
 *
 * A FAILED CELL IS THE ONLY THING FILTERED OUT, and for the opposite reason:
 * it is not a measurement at all.
 */
export function shareOfVoice(cells: readonly Cell[]): number | null {
  const measured = cells.filter((cell) => cell.status !== "failed");
  const denominator = measured.reduce((total, cell) => total + cell.engineWeight, 0);
  // Every cell in the window failed. That is not a share of zero — it is no
  // measurement, and `null` is the only honest answer.
  if (measured.length === 0 || denominator === 0) return null;

  // `cell.sov` is 0 for an absent brand and for a refusal, and both cells are
  // ALREADY in `denominator` above. Nothing else is needed for the rule to
  // hold — which is exactly why it is so easy to break by adding a filter.
  const numerator = measured.reduce((total, cell) => total + cell.engineWeight * cell.sov, 0);
  return numerator / denominator;
}

/**
 * §3 — `PresenceRate(T) = |{c : brand_present(c)}| / |C(T)|`.
 *
 * Over the MEASURED cells, for the same reason: a cell we could not ask is
 * not a cell the brand was absent from.
 */
export function presenceRate(cells: readonly Cell[]): number | null {
  const measured = cells.filter((cell) => cell.status !== "failed");
  if (measured.length === 0) return null;
  return measured.filter((cell) => cell.brandPresent).length / measured.length;
}

/** How many cells a score is based on — `n` in §3's confidence band. */
export function measuredCellCount(cells: readonly Cell[]): number {
  return cells.filter((cell) => cell.status !== "failed").length;
}

// ─────────────────────────────── §4 citations ───────────────────────────────

export interface CitationSlot {
  /** `pw(x) = 1/√slot_index`, precomputed by the parser. */
  readonly positionWeight: number;
  readonly isOwned: boolean;
  readonly isCompetitor: boolean;
  /**
   * §4 — "Unresolved citations ... are EXCLUDED from `citation_share` —
   * counted as neither owned nor foreign — so an unresolvable link cannot
   * inflate or deflate the metric."
   */
  readonly countsTowardShare: boolean;
  /** For `citation_diversity`. */
  readonly normalizedUrl: string;
}

/** §4 — `citation_share = Σ owned pw / Σ all pw`. */
export function citationShare(slots: readonly CitationSlot[]): number | null {
  const counted = slots.filter((slot) => slot.countsTowardShare);
  const total = counted.reduce((sum, slot) => sum + slot.positionWeight, 0);
  // No citations at all is not a share of zero — the answer cited nothing, so
  // there is no share to have. Zero would read as "cited, none of them mine".
  if (total === 0) return null;
  const owned = counted.filter((slot) => slot.isOwned).reduce((sum, slot) => sum + slot.positionWeight, 0);
  return owned / total;
}

/** §4 — as above, for `is_competitor`. */
export function competitorCitationShare(slots: readonly CitationSlot[]): number | null {
  const counted = slots.filter((slot) => slot.countsTowardShare);
  const total = counted.reduce((sum, slot) => sum + slot.positionWeight, 0);
  if (total === 0) return null;
  const competitor = counted.filter((slot) => slot.isCompetitor).reduce((sum, slot) => sum + slot.positionWeight, 0);
  return competitor / total;
}

/**
 * §4 — `citation_diversity = distinct owned URLs / owned citations`.
 *
 * "Detects over-reliance on one page": forty citations all pointing at one
 * blog post is a fragile position, and the ratio makes it visible.
 */
export function citationDiversity(slots: readonly CitationSlot[]): number | null {
  const owned = slots.filter((slot) => slot.isOwned && slot.countsTowardShare);
  if (owned.length === 0) return null;
  return new Set(owned.map((slot) => slot.normalizedUrl)).size / owned.length;
}

/** §4 — `first_slot_ownership = |{c : slot 1 is owned}| / |C|`, "the strongest single citation signal". */
export function firstSlotOwnership(cells: readonly { readonly firstSlotOwned: boolean | null }[]): number | null {
  // A cell with no citations at all has `null` and is not a cell where slot
  // one belonged to someone else.
  const withCitations = cells.filter((cell) => cell.firstSlotOwned !== null);
  if (withCitations.length === 0) return null;
  return withCitations.filter((cell) => cell.firstSlotOwned === true).length / withCitations.length;
}

// ─────────────────────────────── §6 sentiment ───────────────────────────────

export interface SentimentMention {
  /** §2.1's prominence — a closing caveat should not weigh as a recommendation does. */
  readonly prominence: number;
  /** Per mention, in [−1, 1]. */
  readonly sentimentScore: number;
}

/**
 * §6 — `SentimentScore(T) = 50 · (raw + 1)`, prominence-weighted.
 *
 * NULL WHEN THERE ARE NO MENTIONS, NEVER 50 (`NFR-ANL-04`). The reference
 * says it outright: "A neutral-looking number for 'no data' is a lie." 50 is
 * the exact midpoint of the displayed bands, so a project with no coverage
 * would render as a solidly Neutral brand rather than as one nobody talks
 * about.
 */
export function sentimentScore(mentions: readonly SentimentMention[]): number | null {
  const weightTotal = mentions.reduce((total, mention) => total + mention.prominence, 0);
  if (mentions.length === 0 || weightTotal === 0) return null;
  const weightedSum = mentions.reduce((total, mention) => total + mention.prominence * mention.sentimentScore, 0);
  return 50 * (weightedSum / weightTotal + 1);
}

/** §6's displayed bands. */
export function sentimentBand(score: number | null): "positive" | "neutral" | "negative" | null {
  if (score === null) return null;
  if (score >= 70) return "positive";
  if (score >= 45) return "neutral";
  return "negative";
}

/**
 * §6 — `negative_cell_rate` crossing 0.05 with `n ≥ 30` is the LEVEL of the negative-sentiment alert; §15 (`negative_spike`) adds the
 * RISE: up ≥ 0.03 against the prior window, which must meet its own `n ≥ 30`. Both are `≥` (owner decision 22, 2026-10-30; the level
 * was a strict `>` before, which the reference does not say).
 */
export const NEGATIVE_CELL_RATE_ALERT = 0.05;
export const NEGATIVE_ALERT_MIN_CELLS = 30;
export const NEGATIVE_CELL_RATE_RISE_ALERT = 0.03;

/** A rate difference is a difference of two quotients: compare it with a tolerance far under any real count ratio (1e-9). */
const RATE_EPSILON = 1e-9;

/** The §6 level alone: `negative_cell_rate ≥ 0.05` with `n ≥ 30`. */
export function shouldAlertOnNegativeSentiment(cells: number, negativeCells: number): boolean {
  if (cells < NEGATIVE_ALERT_MIN_CELLS) return false;
  return negativeCells / cells >= NEGATIVE_CELL_RATE_ALERT;
}

/**
 * The §15 rise: the rate is up ≥ 0.03 against the prior window, and the prior window meets its own sample floor. A prior window below
 * the floor (or empty) has no rate to rise from, so it is not a rise.
 */
export function negativeSentimentRose(cells: number, negativeCells: number, priorCells: number, priorNegativeCells: number): boolean {
  if (cells <= 0 || priorCells < NEGATIVE_ALERT_MIN_CELLS) return false;
  return negativeCells / cells - priorNegativeCells / priorCells >= NEGATIVE_CELL_RATE_RISE_ALERT - RATE_EPSILON;
}
