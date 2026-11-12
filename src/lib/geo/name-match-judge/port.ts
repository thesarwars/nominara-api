// STORY-191 AC1 - the seam a model-backed name-match judge fills, the same port-plus-adapter shape as the prompt naturaliser. The verdicts are
// the same three `judgeNameMatch` returns, so the A2 analysis reads either judge's through one vocabulary.

export type NameMatchVerdict = "about_brand" | "not_about_brand" | "unjudged";

/** What the model is shown for one match: the brand's alias, the matched span, and a bounded window of context. Nothing else of the answer. */
export interface NameMatchQuery {
  readonly alias: string;
  readonly span: string;
  readonly before: string;
  readonly after: string;
}

export interface NameMatchJudge {
  /** The model id alone, for audit. */
  readonly model: string;
  /** The model AND the prompt revision (`<model>:name-match-vN`): the key a stored verdict is read back by. */
  readonly version: string;
  /**
   * One verdict per query, in order. MUST return exactly `queries.length` verdicts or throw: a short array is never padded, because pairing survivors
   * against the wrong matches would attach a verdict to a match it was not about. `unjudged` is the model's way of saying it cannot decide; an
   * implementation never turns uncertainty into `about_brand`.
   */
  judge(queries: readonly NameMatchQuery[]): Promise<readonly NameMatchVerdict[]>;
}
