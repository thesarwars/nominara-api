import { describe, expect, it } from "vitest";
import {
  blendAcrossEngines,
  CLASS_PENALTY,
  citationDiversity,
  citationShare,
  clamp01,
  confidenceFor,
  confidenceHalfWidth,
  competitorCitationShare,
  displacementImpact,
  entityProminence,
  firstSlotOwnership,
  frequencyScore,
  listRankScore,
  positionScore,
  mentionProminence,
  measuredCellCount,
  presenceRate,
  responseShareOfVoice,
  sentimentBand,
  sentimentScore,
  shareOfVoice,
  shouldAlertOnNegativeSentiment,
  visibilityDelta,
  visibilityScore,
  type Cell,
  type CitationSlot,
  type MentionInput,
} from "../../../src/lib/scoring/index.js";

// STORY-041's nine scenarios.
//
// EPIC-05 calls this "the second most load-bearing story in the repository
// after tenant context — four differentiators and every chart read from it."
// Two rules have their own sections below because the plan names them as the
// highest-risk correctness bugs in the product.

function mention(over: Partial<MentionInput> = {}): MentionInput {
  return {
    entityKey: "hubspot",
    charStart: 0,
    listPosition: null,
    clause: "neutral",
    contrastivePivotAway: false,
    inLink: false,
    ...over,
  };
}

function cell(over: Partial<Cell> = {}): Cell {
  return { status: "answered", engineWeight: 1, sov: 0, brandPresent: false, ...over };
}

describe("STORY-041 · scenario 1 — the reference's worked example", () => {
  // §2.4: a 2,418-character response.
  //
  // ⚠ **THE REFERENCE'S TABLE DOES NOT REPRODUCE FROM THE REFERENCE'S OWN
  // FORMULA.** Scenario 1 asks that "every intermediate value matches", and
  // three of its four rows cannot. Recomputed from §2.1 exactly as written:
  //
  //   entity        base      × bonus     §2.4 states     implied bonus
  //   HubSpot     0.8581      1.0297          0.874           1.019
  //   Salesforce  0.7204      0.6131          0.612           0.850   ✓
  //   Zoho        0.6548      0.4911          0.411           0.628
  //   Pipedrive   0.5457      0.4093          0.187           0.343
  //
  // SALESFORCE IS THE CONTROL. It is the only row whose `clause_bonus` is
  // 1.00, and it reproduces to three decimals — including the 0.851
  // contrastive-pivot factor. The three that fail are exactly the three with
  // a non-unit bonus, and their implied multipliers (1.019, 0.628, 0.343)
  // match neither the documented bonuses (1.20, 0.75, 0.75) nor each other.
  //
  // Pipedrive settles it: its UNBONUSED base is 0.5457 and the table states
  // 0.187 — no multiplication by 0.75 reaches that. The formula is the
  // specification and the table is an illustration of it, so THE FORMULA
  // WINS. Recorded as a specification defect in the story rather than
  // reverse-engineered into the code, because a scoring library fitted to
  // four hand-typed numbers is fitted to a typo.
  //
  // The intermediate components below — position, frequency and list rank —
  // DO all match §2.4's table, which is what locates the error in the final
  // column rather than in the inputs.
  const L = 2418;
  const mentions: MentionInput[] = [
    mention({ entityKey: "hubspot", charStart: 52, listPosition: 1, clause: "recommendation" }),
    mention({ entityKey: "salesforce", charStart: 176, listPosition: 2, clause: "neutral", contrastivePivotAway: true }),
    mention({ entityKey: "zoho", charStart: 259, listPosition: 3, clause: "tail" }),
    mention({ entityKey: "pipedrive", charStart: 1094, listPosition: null, clause: "tail" }),
  ];

  const prominence = entityProminence({ responseLength: L, mentions });

  it.each([
    ["position_score", positionScore(52, L), 0.979],
    ["frequency_score", frequencyScore(1), 0.333],
    ["list_rank_score", listRankScore(1), 1.0],
    ["list_rank_score(2)", listRankScore(2), 0.707],
    ["list_rank_score(3)", listRankScore(3), 0.577],
    ["list_rank_score(none)", listRankScore(null), 0.65],
    // Two decimals, not three: §2.4 prints its inputs already rounded, and
    // `position_score` is 0.97849 against a printed 0.979 — a gap of 0.0005
    // that is the printing, not the arithmetic.
  ])("%s matches §2.4's table", (_label, actual, expected) => {
    expect(actual).toBeCloseTo(expected, 2);
  });

  it.each([
    ["hubspot", 1.0297],
    ["salesforce", 0.6131],
    ["zoho", 0.4911],
    ["pipedrive", 0.4093],
  ])("prominence(%s) = %f — from §2.1's FORMULA, not §2.4's table", (entity, expected) => {
    expect(prominence.get(entity)).toBeCloseTo(expected, 3);
  });

  it("SALESFORCE reproduces the reference exactly — the control that locates the error", () => {
    // The only row with `clause_bonus = 1.00`. It matching, while the three
    // rows with a non-unit bonus miss by 15–120%, is what says the error is in
    // the table's bonus column and not in the formula.
    //
    // Two decimals because §2.4 reaches 0.612 as "0.719 × 0.851" from an
    // already-rounded 0.719; the unrounded chain gives 0.6131. The three
    // failing rows are not off by rounding — Pipedrive is off by a factor of
    // two.
    expect(prominence.get("salesforce")).toBeCloseTo(0.612, 2);
  });

  it("the denominator and every share match the worked example", () => {
    const { sov, denominator } = responseShareOfVoice({ responseLength: L, mentions }, "hubspot");

    // §2.4 states 2.084, which is the sum of its own four (three incorrect)
    // figures. Recomputed from the formula the sum is 2.543, and the shares
    // below follow from it. The SHAPE the example demonstrates is unchanged
    // and is what actually matters: HubSpot leads, Pipedrive is untracked and
    // still in the denominator.
    expect(denominator).toBeCloseTo(2.543, 3);
    expect(sov.get("hubspot")).toBeCloseTo(1.0297 / 2.543, 3);
    expect(sov.get("salesforce")).toBeCloseTo(0.6131 / 2.543, 3);
    expect(sov.get("zoho")).toBeCloseTo(0.4911 / 2.543, 3);
    expect(sov.get("hubspot")).toBeGreaterThan(sov.get("salesforce")!);
    // Scenario 3 — Pipedrive is UNTRACKED and still in the denominator. "A
    // brand that is 1-of-2 mentioned has a genuinely higher share than one
    // that is 1-of-9, and excluding unknown competitors would inflate every
    // score."
    expect(sov.get("pipedrive")).toBeCloseTo(0.4093 / 2.543, 3);
  });

  it("scenario 6 — the contrastive pivot factor is applied", () => {
    // Salesforce's 0.719 × 0.851 = 0.612. Without the factor it would be 0.719
    // and would outrank Zoho by more than it should.
    const without = mentionProminence({ ...mentions[1]!, contrastivePivotAway: false }, 1, L);
    // §2.4's own "0.719 × 0.851 = 0.612", reproduced to three decimals.
    expect(without).toBeCloseTo(0.720, 3);
    expect(prominence.get("salesforce")).toBeCloseTo(without * 0.851, 6);
  });
});

describe("STORY-041 · scenario 4 — THE HIGHEST-RISK CORRECTNESS BUG", () => {
  // §2.3: "Absent cells contribute sov = 0 to the numerator and w to the
  // denominator — NOT EXCLUSION. Excluding absent cells would report a brand
  // mentioned in 1 of 90 cells as having 100% share of voice."
  //
  // `NFR-ANL-02` requires this dedicated test. The story adds: "the wrong
  // behaviour is the intuitive one."

  const cells: Cell[] = [
    cell({ sov: 1, brandPresent: true }),
    ...Array.from({ length: 89 }, () => cell({ sov: 0, brandPresent: false })),
  ];

  it("a brand present in ONE of ninety cells has a share of 1/90, not 1", () => {
    expect(shareOfVoice(cells)).toBeCloseTo(1 / 90, 10);
    expect(shareOfVoice(cells)).not.toBeCloseTo(1, 2);
  });

  it("the same holds under engine weights", () => {
    const weighted: Cell[] = [
      cell({ sov: 1, brandPresent: true, engineWeight: 2 }),
      cell({ sov: 0, brandPresent: false, engineWeight: 2 }),
    ];
    expect(shareOfVoice(weighted)).toBeCloseTo(0.5, 10);
  });

  it("a REFUSAL counts in the denominator — a refusal is data", () => {
    // §2.5: "Engine refused to answer: sov = 0, flag engine_refused_to_answer,
    // THE CELL COUNTS IN THE DENOMINATOR."
    const withRefusal: Cell[] = [cell({ sov: 1, brandPresent: true }), cell({ status: "refused", sov: 0 })];
    expect(shareOfVoice(withRefusal)).toBeCloseTo(0.5, 10);
  });
});

describe("STORY-041 · scenario 5 — a failed cell is excluded from BOTH sides", () => {
  // §2.5's line, and the distinction the whole file rests on: "'The engine did
  // not mention you' is data. 'We could not ask' is not."

  it("a failed cell changes nothing", () => {
    const clean: Cell[] = [cell({ sov: 1, brandPresent: true }), cell({ sov: 0 })];
    const withFailure: Cell[] = [...clean, cell({ status: "failed", sov: 0 })];

    expect(shareOfVoice(withFailure)).toBeCloseTo(shareOfVoice(clean)!, 10);
    expect(presenceRate(withFailure)).toBeCloseTo(presenceRate(clean)!, 10);
    expect(measuredCellCount(withFailure)).toBe(2);
  });

  it("a window of nothing but failures is NULL, not zero", () => {
    // Zero is a real, terrible result. No measurement is not a result.
    const failed = [cell({ status: "failed" }), cell({ status: "failed" })];
    expect(shareOfVoice(failed)).toBeNull();
    expect(presenceRate(failed)).toBeNull();
  });
});

describe("STORY-041 · scenario 2 — placement beats repetition", () => {
  it("a brand named ten times in an aside does not outrank one recommended once", () => {
    // §2.1: entity prominence is the MAXIMUM over mentions, not the sum.
    // Summing rewards repetition, which is the cheap thing to manufacture.
    const L = 1000;
    const aside = entityProminence({
      responseLength: L,
      mentions: Array.from({ length: 10 }, (_, i) => mention({ entityKey: "loud", charStart: 500 + i, clause: "tail" })),
    });
    const recommended = entityProminence({
      responseLength: L,
      mentions: [mention({ entityKey: "quiet", charStart: 20, listPosition: 1, clause: "recommendation" })],
    });

    expect(recommended.get("quiet")!).toBeGreaterThan(aside.get("loud")!);
  });

  it("frequency still helps, but saturates at three", () => {
    const L = 1000;
    const three = entityProminence({
      responseLength: L,
      mentions: Array.from({ length: 3 }, (_, i) => mention({ charStart: 10 + i })),
    });
    const twenty = entityProminence({
      responseLength: L,
      mentions: Array.from({ length: 20 }, (_, i) => mention({ charStart: 10 + i })),
    });
    // The extra seventeen buy nothing; only the position of the best mention
    // separates them.
    expect(twenty.get("hubspot")!).toBeCloseTo(three.get("hubspot")!, 2);
  });
});

describe("STORY-041 · §2.5's edge cases", () => {
  it("scenario 8 — no entities detected: all zero, flagged", () => {
    const result = responseShareOfVoice({ responseLength: 500, mentions: [] }, "hubspot");
    expect(result.denominator).toBe(0);
    expect(result.sov.size).toBe(0);
    expect(result.flags).toContain("no_entities_detected");
  });

  it("scenario 7 — a single-entity answer has complete share, and is FLAGGED", () => {
    // "Often a navigational prompt, so the UI de-emphasises it."
    const result = responseShareOfVoice({ responseLength: 500, mentions: [mention()] }, "hubspot");
    expect(result.sov.get("hubspot")).toBe(1);
    expect(result.flags).toContain("single_entity_answer");
  });

  it("a brand only inside a citation URL has sov 0 and is flagged", () => {
    // §2.1: link mentions are EXCLUDED from prominence — that is a citation,
    // counted in §4.
    const result = responseShareOfVoice(
      { responseLength: 500, mentions: [mention({ inLink: true }), mention({ entityKey: "rival", charStart: 10 })] },
      "hubspot",
    );
    expect(result.sov.get("hubspot")).toBeUndefined();
    expect(result.flags).toContain("citation_only_presence");
  });

  it("clamps, and never divides by zero", () => {
    expect(clamp01(-5)).toBe(0);
    expect(clamp01(5)).toBe(1);
    expect(mentionProminence(mention(), 1, 0)).not.toBeNaN();
  });
});

describe("STORY-041 · §4 citation metrics", () => {
  function slot(over: Partial<CitationSlot> = {}): CitationSlot {
    return { positionWeight: 1, isOwned: false, isCompetitor: false, countsTowardShare: true, normalizedUrl: "https://a", ...over };
  }

  it("weights owned citations by slot", () => {
    // Slot 1 = 1.000, slot 2 = 0.707.
    const share = citationShare([slot({ isOwned: true }), slot({ positionWeight: 0.707 })]);
    expect(share).toBeCloseTo(1 / 1.707, 4);
  });

  it("EXCLUDES an unresolved citation from both sides", () => {
    // §4: "counted as neither owned nor foreign — so an unresolvable link
    // cannot inflate or deflate the metric."
    const clean = citationShare([slot({ isOwned: true }), slot()]);
    const withUnresolved = citationShare([slot({ isOwned: true }), slot(), slot({ countsTowardShare: false })]);
    expect(withUnresolved).toBeCloseTo(clean!, 10);
  });

  it("returns NULL when nothing was cited, not 0", () => {
    // 0 would read as "cited, none of them mine".
    expect(citationShare([])).toBeNull();
    expect(competitorCitationShare([])).toBeNull();
    expect(citationDiversity([])).toBeNull();
  });

  it("detects over-reliance on one page", () => {
    const onePage = [slot({ isOwned: true }), slot({ isOwned: true }), slot({ isOwned: true })];
    const threePages = [
      slot({ isOwned: true, normalizedUrl: "https://a" }),
      slot({ isOwned: true, normalizedUrl: "https://b" }),
      slot({ isOwned: true, normalizedUrl: "https://c" }),
    ];
    expect(citationDiversity(onePage)).toBeCloseTo(1 / 3, 5);
    expect(citationDiversity(threePages)).toBe(1);
  });

  it("first-slot ownership ignores cells that cited nothing", () => {
    expect(firstSlotOwnership([{ firstSlotOwned: true }, { firstSlotOwned: false }, { firstSlotOwned: null }])).toBe(0.5);
    expect(firstSlotOwnership([{ firstSlotOwned: null }])).toBeNull();
  });
});

describe("STORY-041 · §6 sentiment", () => {
  it("weights by prominence — a closing caveat is not a recommendation", () => {
    const buriedNegative = sentimentScore([
      { prominence: 0.9, sentimentScore: 1 },
      { prominence: 0.1, sentimentScore: -1 },
    ])!;
    expect(buriedNegative).toBeGreaterThan(50);
  });

  it("returns NULL with no mentions, NEVER 50", () => {
    // `NFR-ANL-04`. 50 is the exact midpoint of the displayed bands, so a
    // project with no coverage would render as a solidly Neutral brand
    // rather than as one nobody talks about. "A neutral-looking number for
    // 'no data' is a lie."
    expect(sentimentScore([])).toBeNull();
    expect(sentimentScore([{ prominence: 0, sentimentScore: -1 }])).toBeNull();
    expect(sentimentBand(null)).toBeNull();
  });

  it("maps to §6's displayed bands", () => {
    expect(sentimentBand(85)).toBe("positive");
    expect(sentimentBand(70)).toBe("positive");
    expect(sentimentBand(69)).toBe("neutral");
    expect(sentimentBand(45)).toBe("neutral");
    expect(sentimentBand(44)).toBe("negative");
  });

  it("alerts on the negative-cell rate only at n >= 30", () => {
    expect(shouldAlertOnNegativeSentiment(100, 6)).toBe(true);
    expect(shouldAlertOnNegativeSentiment(100, 4)).toBe(false);
    expect(shouldAlertOnNegativeSentiment(20, 20)).toBe(false);
    expect(shouldAlertOnNegativeSentiment(29, 29)).toBe(false);
    expect(shouldAlertOnNegativeSentiment(30, 30)).toBe(true);
  });

  // scoring-models.md section 6 / 15 state ">= 0.05" ("crossing 0.05 with n >= 30"); the helper had a strict ">" (owner decision 22).
  it("the level is >= 0.05: exactly 0.05 meets it", () => {
    expect(shouldAlertOnNegativeSentiment(100, 5)).toBe(true);
    expect(shouldAlertOnNegativeSentiment(60, 3)).toBe(true);
    expect(shouldAlertOnNegativeSentiment(1000, 49)).toBe(false);
  });
});

describe("STORY-041 · §3 the Visibility Score", () => {
  it("is the documented weighted composite", () => {
    const score = visibilityScore({ presenceRate: 1, shareOfVoice: 1, citationShare: 1, sentimentScore: 100 });
    expect(score).toBeCloseTo(100, 10);

    const half = visibilityScore({ presenceRate: 0.5, shareOfVoice: 0.5, citationShare: 0.5, sentimentScore: 50 });
    expect(half).toBeCloseTo(50, 10);
  });

  it("reads weights from CONFIGURATION, so an override changes the number", () => {
    const components = { presenceRate: 1, shareOfVoice: 0, citationShare: 0, sentimentScore: 0 };
    const standard = visibilityScore(components)!;
    const presenceHeavy = visibilityScore(components, {
      presence: 0.7,
      shareOfVoice: 0.1,
      citationShare: 0.1,
      sentimentQuality: 0.1,
    })!;
    expect(presenceHeavy).toBeGreaterThan(standard);
  });

  it("RENORMALISES over the components that exist rather than scoring a null as zero", () => {
    // A project with presence and share but no citations is scored on
    // presence and share. Substituting 0 would state the brand scored zero on
    // citation share — "cited, none of them mine" — rather than "nothing
    // cited anything".
    const withCitations = visibilityScore({ presenceRate: 1, shareOfVoice: 1, citationShare: 1, sentimentScore: 100 })!;
    const withoutCitations = visibilityScore({ presenceRate: 1, shareOfVoice: 1, citationShare: null, sentimentScore: 100 })!;
    expect(withoutCitations).toBeCloseTo(withCitations, 10);
  });

  it("is NULL when nothing is measurable", () => {
    expect(visibilityScore({ presenceRate: null, shareOfVoice: null, citationShare: null, sentimentScore: null })).toBeNull();
  });

  it("blends across engines by weight, leaving unscored engines out", () => {
    expect(blendAcrossEngines([{ score: 80, engineWeight: 3 }, { score: 40, engineWeight: 1 }])).toBeCloseTo(70, 10);
    expect(blendAcrossEngines([{ score: 80, engineWeight: 1 }, { score: null, engineWeight: 1 }])).toBe(80);
    expect(blendAcrossEngines([{ score: null, engineWeight: 1 }])).toBeNull();
  });
});

describe("STORY-041 · scenario 9 — an under-sampled window produces NO delta", () => {
  // `NFR-ANL-03` forbids a trend delta at n < 30. §3: "If either window has
  // n < 30, the delta is NULL, NOT 0."
  //
  // A zero delta claims nothing changed. On a four-cell project that is a
  // claim nobody is entitled to make, and it renders as a flat trend arrow —
  // the most confident-looking thing in the interface.

  it("is null when the CURRENT window is under-sampled", () => {
    expect(visibilityDelta({ score: 70, measuredCells: 12 }, { score: 60, measuredCells: 200 })).toBeNull();
  });

  it("is null when the PRIOR window is under-sampled", () => {
    expect(visibilityDelta({ score: 70, measuredCells: 200 }, { score: 60, measuredCells: 12 })).toBeNull();
  });

  it("is the difference when both windows are sampled", () => {
    expect(visibilityDelta({ score: 70, measuredCells: 30 }, { score: 60, measuredCells: 30 })).toBeCloseTo(10, 10);
  });

  it("bands confidence at §3's thresholds", () => {
    expect(confidenceFor(29)).toBe("low");
    expect(confidenceFor(30)).toBe("medium");
    expect(confidenceFor(119)).toBe("medium");
    expect(confidenceFor(120)).toBe("high");
  });

  it("narrows the half-width as the sample grows, and is null with no cells", () => {
    const few = confidenceHalfWidth(0.5, 30)!;
    const many = confidenceHalfWidth(0.5, 300)!;
    expect(many).toBeLessThan(few);
    expect(confidenceHalfWidth(0.5, 0)).toBeNull();
    expect(confidenceHalfWidth(null, 100)).toBeNull();
  });
});

describe("STORY-041 · §9 displacement impact", () => {
  const base = {
    presenceLost: true,
    beforePosition: 1,
    afterPosition: null,
    classPenalty: "recommendation_to_absent" as const,
    funnelStage: "decision" as const,
    topicRankByIntent: 1,
    engineWeight: 1,
    maxEngineWeight: 1,
    citationGap: 1,
  };

  it("scores a total loss on a decision prompt near the top", () => {
    expect(displacementImpact(base)).toBeGreaterThan(80);
  });

  it("RAISES the score for a recoverable loss", () => {
    // §9's apparent inversion, and its reason: "A loss the brand can plausibly
    // recover deserves more attention than a loss to an incumbent with forty
    // citations. Unrecoverable losses are still recorded and still visible;
    // they simply do not crowd the top of the queue."
    const recoverable = displacementImpact({ ...base, citationGap: 1 });
    const hopeless = displacementImpact({ ...base, citationGap: 40 });
    expect(recoverable).toBeGreaterThan(hopeless);
  });

  it("weights an awareness prompt below a decision one", () => {
    expect(displacementImpact({ ...base, funnelStage: "awareness" })).toBeLessThan(displacementImpact(base));
  });

  it("applies §9's class penalties in the documented order", () => {
    expect(CLASS_PENALTY.recommendation_to_absent).toBeGreaterThan(CLASS_PENALTY.any_to_caveat);
    expect(CLASS_PENALTY.any_to_caveat).toBeGreaterThan(CLASS_PENALTY.recommendation_to_ranked);
    expect(CLASS_PENALTY.recommendation_to_ranked).toBeGreaterThan(CLASS_PENALTY.ranked_to_also_consider);
    expect(CLASS_PENALTY.ranked_to_also_consider).toBeGreaterThan(CLASS_PENALTY.render_downgrade_only);
  });

  it("never leaves [0,100], even with absurd positions", () => {
    const score = displacementImpact({ ...base, presenceLost: false, beforePosition: 90, afterPosition: 1 });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});
