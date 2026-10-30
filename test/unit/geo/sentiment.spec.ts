import { describe, expect, it } from "vitest";
import { geoAnalysisWriteSchema, geoSentimentDetailSchema } from "../../../contracts/analytics/index.js";
import { buildSentiment, SENTIMENT_MIN_MENTIONS, type SentimentInput, type SentimentMentionInput } from "../../../src/lib/geo/sentiment.js";

// STORY-061 — A6 sentiment drivers (pure). Scenario numbers are the story's
// table; #12 is deliberately NOT "flagged as a contradiction": the plan
// overrides it (no verified structured data exists, so factual_error is
// false-with-a-reason and a contradiction is never guessed).

const TEXT = "HubSpot is clunky and the pricing is steep [thread](https://reddit.com/r/crm/1). Other tools exist, see https://g2.com/p.";
const SPAN_START = 0;
const SPAN_END = 44; // "HubSpot is clunky and the pricing is steep ["

const m = (over: Partial<SentimentMentionInput> = {}): SentimentMentionInput => ({
  resultId: "r1",
  engine: "gemini",
  capturedAt: "2026-09-20T10:00:00.000Z",
  label: "negative",
  evidenceStart: SPAN_START,
  evidenceEnd: SPAN_END,
  text: TEXT,
  reasons: ["complaint_thread_cited"],
  citations: [{ slotIndex: 1, url: "https://reddit.com/r/crm/1", domain: "reddit.com" }],
  ...over,
});
const input = (over: Partial<SentimentInput> = {}): SentimentInput => ({
  windowStart: "2026-09-08",
  windowDays: 30,
  rootDomain: "acme.com",
  brandMentions: 40,
  dataSource: "live",
  mentions: [m()],
  // 10 of 100 parsed answers carry a negative brand mention: past the 0.05 alert with the sample floor met.
  cells: 100,
  negativeCells: 10,
  priorCells: 100,
  priorNegativeCells: 2,
  priorReasonCounts: {},
  ...over,
});

describe("STORY-061 · A6 sentiment drivers (pure)", () => {
  it("AC1 · every non-positive mention carries its span, the sentence, cues, reason and nearest citation slot", () => {
    const { detail } = buildSentiment(input());
    const [x] = detail!.mentions;
    expect(x).toMatchObject({
      evidence_start: SPAN_START,
      evidence_end: SPAN_END,
      evidence_text: TEXT.slice(SPAN_START, SPAN_END),
      cues: ["complaint_thread_cited"],
      reason: "complaint_thread_cited",
      citation: { slot_index: 1, url: "https://reddit.com/r/crm/1", domain: "reddit.com" },
    });
    expect(geoSentimentDetailSchema.safeParse(detail).success).toBe(true);
  });

  it("AC1 · the citation is the NEAREST slot to the span, located in the answer text", () => {
    const { detail } = buildSentiment(
      input({
        mentions: [
          m({
            citations: [
              { slotIndex: 1, url: "https://g2.com/p", domain: "g2.com" },
              { slotIndex: 2, url: "https://reddit.com/r/crm/1", domain: "reddit.com" },
            ],
          }),
        ],
      }),
    );
    expect(detail!.mentions[0]!.citation!.slot_index).toBe(2);
  });

  it("AC1 · a citation that cannot be located is NOT guessed: null, counted as unattributed, in no cluster", () => {
    const { detail } = buildSentiment(
      input({ mentions: [m({ citations: [{ slotIndex: 1, url: "https://never-in-text.com/x", domain: "never-in-text.com" }] }), m({ resultId: "r2" })] }),
    );
    expect(detail!.mentions.find((x) => x.result_id === "r1")!.citation).toBeNull();
    expect(detail!.unattributed_mentions).toBe(1);
    expect(detail!.clusters).toEqual([expect.objectContaining({ domain: "reddit.com", mention_count: 1 })]);
  });

  it("#10 · several negative mentions citing one source are clustered by that source", () => {
    const { detail } = buildSentiment(input({ mentions: [m({ resultId: "a" }), m({ resultId: "b" }), m({ resultId: "c", engine: "claude" })] }));
    expect(detail!.clusters).toHaveLength(1);
    expect(detail!.clusters[0]).toMatchObject({ domain: "reddit.com", mention_count: 3, engine_count: 2, engines: ["claude", "gemini"] });
  });

  it("AC1 · a cluster spanning engines is ranked above a bigger single-engine cluster", () => {
    const g2Text = "Acme is slow [g](https://g2.com/p) overall";
    const g2 = (id: string) =>
      m({ resultId: id, text: g2Text, evidenceStart: 0, evidenceEnd: 13, citations: [{ slotIndex: 1, url: "https://g2.com/p", domain: "g2.com" }] });
    const { detail } = buildSentiment(input({ mentions: [g2("g1"), g2("g2"), g2("g3"), m({ resultId: "r1" }), m({ resultId: "r2", engine: "claude" })] }));
    expect(detail!.clusters.map((c) => c.domain)).toEqual(["reddit.com", "g2.com"]);
  });

  it("AC1 · clusters with equal reach and size order by domain, never by input order", () => {
    const other = m({ resultId: "z", text: "Acme is slow [g](https://a.com/p) x", evidenceStart: 0, evidenceEnd: 13, citations: [{ slotIndex: 1, url: "https://a.com/p", domain: "a.com" }] });
    const a = buildSentiment(input({ mentions: [m(), other] })).detail!;
    const b = buildSentiment(input({ mentions: [other, m()] })).detail!;
    expect(a.clusters.map((c) => c.domain)).toEqual(["a.com", "reddit.com"]);
    expect(b.clusters.map((c) => c.domain)).toEqual(["a.com", "reddit.com"]);
  });

  it("AC2 / #12 · factual_error is false with a reason on every mention, even one about pricing; never guessed", () => {
    const { detail } = buildSentiment(input({ mentions: [m({ reasons: ["outdated_pricing", "factual_error"] })] }));
    const x = detail!.mentions[0]!;
    expect(x.factual_error).toBe(false);
    expect(x.factual_error_reason).toMatch(/no verified structured data/i);
    expect(detail!.factual_error_reason).toMatch(/no verified structured data/i);
    expect(x.cues).toEqual(["outdated_pricing", "factual_error"]);
  });

  it("#11 · one task rule per distinct reason class, verdict action, titles only (no task id)", () => {
    const { write, detail } = buildSentiment(
      input({ mentions: [m({ reasons: ["pricing_objection"] }), m({ resultId: "b", reasons: ["pricing_objection"] }), m({ resultId: "c", reasons: ["missing_feature"] })] }),
    );
    const tasks = write.findings.filter((f) => f.task_rule_code !== undefined);
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map((f) => f.id)).size).toBe(2);
    expect(tasks.every((f) => f.task_rule_code === "TG-SENTIMENT-REASON")).toBe(true);
    expect(detail!.reason_classes.map((r) => [r.reason, r.mention_count])).toEqual([
      ["pricing_objection", 2],
      ["missing_feature", 1],
    ]);
    expect(detail!.reason_classes.every((r) => r.task_title.length > 0)).toBe(true);
    expect(geoAnalysisWriteSchema.safeParse(write).success).toBe(true);
  });

  it("AC1 · the detail rides on exactly one finding, so a read returns the stored object", () => {
    const { write, detail } = buildSentiment(input({ mentions: [m({ reasons: ["pricing_objection"] }), m({ resultId: "c", reasons: ["missing_feature"] })] }));
    const carriers = write.findings.filter((f) => f.sentiment !== undefined);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]!.sentiment).toEqual(detail);
  });

  it("AC3 · no discernible reason: reason is null (not invented), no task, an explicit no_action verdict with its evidence", () => {
    const { write, detail } = buildSentiment(input({ mentions: [m({ reasons: [] })] }));
    expect(detail!.mentions[0]).toMatchObject({ reason: null, cues: [] });
    expect(detail!.reason_classes).toEqual([]);
    expect(write.findings).toHaveLength(1);
    expect(write.findings[0]).toMatchObject({ no_action: true });
    expect(write.findings[0]!.task_rule_code).toBeUndefined();
    expect(geoAnalysisWriteSchema.safeParse(write).success).toBe(true);
  });

  it("AC3 · no non-positive mention at all: sufficient, no_action, empty lists (absent is not a cluster)", () => {
    const { write, detail } = buildSentiment(input({ mentions: [] }));
    expect(write.sufficient).toBe(true);
    expect(detail).toMatchObject({ mentions: [], clusters: [], reason_classes: [], non_positive_mentions: 0 });
    expect(write.findings[0]).toMatchObject({ no_action: true });
  });

  it("#13 · below 30 brand mentions the analysis suppresses itself with its reason and no detail; 30 is enough", () => {
    expect(SENTIMENT_MIN_MENTIONS).toBe(30);
    const below = buildSentiment(input({ brandMentions: 29 }));
    expect(below.detail).toBeNull();
    expect(below.write).toMatchObject({ sufficient: false, score: null, findings: [], lever_rank: null, evidence_cells: 29 });
    expect(below.write.suppression_reason).toMatch(/30/);
    expect(geoAnalysisWriteSchema.safeParse(below.write).success).toBe(true);
    expect(buildSentiment(input({ brandMentions: 30 })).write.sufficient).toBe(true);
    expect(buildSentiment(input({ brandMentions: 0 })).write.suppression_reason).toMatch(/0/);
  });

  it("AC4 · publishes no score and promotes no lever", () => {
    const { write } = buildSentiment(input());
    expect(write).toMatchObject({ analysis: "sentiment", score: null, lever_rank: null, evidence_cells: 40 });
  });

  it("AC4 · data_source passes through, and null stays null (nothing measured is not demo)", () => {
    expect(buildSentiment(input({ dataSource: "mixed" })).detail!.data_source).toBe("mixed");
    expect(buildSentiment(input({ dataSource: null })).detail!.data_source).toBeNull();
  });

  it("AC1 · the listed mentions are capped and most recent first while the count stays whole", () => {
    const many = Array.from({ length: 60 }, (_, i) => m({ resultId: `r${String(i)}`, capturedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() }));
    const { detail } = buildSentiment(input({ mentions: many }));
    expect(detail!.non_positive_mentions).toBe(60);
    expect(detail!.mentions).toHaveLength(50);
    expect(detail!.mentions[0]!.result_id).toBe("r59");
    expect(detail!.clusters[0]!.mention_count).toBe(60);
  });

  it("AC1 · a mention whose stored text is gone still lists its span, with evidence_text null", () => {
    const { detail, write } = buildSentiment(input({ mentions: [m({ text: null, citations: [] })] }));
    expect(detail!.mentions[0]).toMatchObject({ evidence_text: null, evidence_start: SPAN_START, citation: null });
    expect(geoAnalysisWriteSchema.safeParse(write).success).toBe(true);
  });

  // ---- FR-GEO-A6c: themes are trended; crossing the threshold with enough sample raises the alert and one task per reason class.
  const two = [m({ reasons: ["pricing_objection"] }), m({ resultId: "b", reasons: ["pricing_objection"] }), m({ resultId: "c", reasons: ["missing_feature"] })];

  it("[#11 / A6c] crossing the negative cell rate with the sample floor met: the threshold is crossed and each reason class asks for exactly one task", () => {
    const { write, detail } = buildSentiment(input({ mentions: two, cells: 100, negativeCells: 6 }));
    expect(detail!.threshold).toMatchObject({ cells: 100, negative_cells: 6, negative_cell_rate: 0.06, rate_threshold: 0.05, min_cells: 30, crossed: true });
    const tasks = write.findings.filter((f) => f.task_rule_code === "TG-SENTIMENT-REASON");
    expect(tasks.map((f) => f.id).sort()).toEqual(["sentiment-reason-missing_feature", "sentiment-reason-pricing_objection"]);
  });

  it("[#11 / A6c] under the threshold the themes are still reported and trended, but no task is asked for", () => {
    const { write, detail } = buildSentiment(input({ mentions: two, cells: 100, negativeCells: 4 }));
    expect(detail!.threshold).toMatchObject({ negative_cell_rate: 0.04, crossed: false });
    expect(detail!.reason_classes).toHaveLength(2);
    expect(write.findings.every((f) => f.task_rule_code === undefined && f.no_action === true)).toBe(true);
  });

  it("[#11 / A6c] the sample floor holds: 29 answers, all negative, is not a crossing", () => {
    const { write, detail } = buildSentiment(input({ mentions: two, cells: 29, negativeCells: 29 }));
    expect(detail!.threshold).toMatchObject({ negative_cell_rate: 1, crossed: false });
    expect(write.findings.some((f) => f.task_rule_code !== undefined)).toBe(false);
    // 30 answers meets the floor.
    expect(buildSentiment(input({ mentions: two, cells: 30, negativeCells: 30 })).detail!.threshold!.crossed).toBe(true);
  });

  // ---- Owner decision 22: a crossing is BOTH the section 6 level (>= 0.05, n >= 30) AND the section 15 rise (>= 0.03 over a prior window that meets its own floor).
  const crossedWith = (over: Partial<SentimentInput>): boolean => buildSentiment(input({ mentions: two, ...over })).detail!.threshold!.crossed;
  const tasksWith = (over: Partial<SentimentInput>): number => buildSentiment(input({ mentions: two, ...over })).write.findings.filter((f) => f.task_rule_code !== undefined).length;

  it("[D22 / level] a rate of EXACTLY 0.05 meets the level (>=, not >), given the rise", () => {
    // 5/100 = 0.05; prior 2/100 = 0.02, so the rise is 0.03.
    expect(buildSentiment(input({ mentions: two, cells: 100, negativeCells: 5, priorCells: 100, priorNegativeCells: 2 })).detail!.threshold).toMatchObject({ negative_cell_rate: 0.05, crossed: true });
    // just under the level, whatever the rise: 4/100 against a prior of 0.
    expect(crossedWith({ cells: 100, negativeCells: 4, priorCells: 100, priorNegativeCells: 0 })).toBe(false);
  });

  it("[D22 / rise] a rise of EXACTLY 0.03 meets the rise (>=), and one just under it does not, with the level met either way", () => {
    expect(crossedWith({ cells: 100, negativeCells: 8, priorCells: 100, priorNegativeCells: 5 })).toBe(true); // 0.08 - 0.05 = 0.03
    expect(crossedWith({ cells: 100, negativeCells: 7, priorCells: 100, priorNegativeCells: 5 })).toBe(false); // 0.02: level met, no rise
    expect(crossedWith({ cells: 1000, negativeCells: 79, priorCells: 1000, priorNegativeCells: 50 })).toBe(false); // 0.029
    const exact = buildSentiment(input({ mentions: two, cells: 100, negativeCells: 8, priorCells: 100, priorNegativeCells: 5 })).detail!.threshold!;
    expect(exact).toMatchObject({ rise_threshold: 0.03, prior_cells: 100, rose: true });
  });

  it("[D22 / level without rise] a high rate that did not rise (a chronic problem) is not a spike and asks for no task", () => {
    const { detail } = buildSentiment(input({ mentions: two, cells: 100, negativeCells: 20, priorCells: 100, priorNegativeCells: 20 }));
    expect(detail!.threshold).toMatchObject({ negative_cell_rate: 0.2, rose: false, crossed: false });
    expect(tasksWith({ cells: 100, negativeCells: 20, priorCells: 100, priorNegativeCells: 20 })).toBe(0);
  });

  it("[D22 / prior floor] a prior window below its own floor of 30 cannot show a rise: 29 is not enough, 30 is", () => {
    expect(crossedWith({ cells: 100, negativeCells: 10, priorCells: 29, priorNegativeCells: 0 })).toBe(false);
    expect(buildSentiment(input({ mentions: two, cells: 100, negativeCells: 10, priorCells: 29, priorNegativeCells: 0 })).detail!.threshold).toMatchObject({ prior_cells: 29, rose: false });
    expect(crossedWith({ cells: 100, negativeCells: 10, priorCells: 30, priorNegativeCells: 0 })).toBe(true);
    // no prior window at all: nothing to compare with, so no crossing (null, not "rose from zero").
    expect(crossedWith({ cells: 100, negativeCells: 10, priorCells: 0, priorNegativeCells: 0 })).toBe(false);
  });

  it("[A6c] with no parsed answers the rate is null (not measured), not 0, and nothing crosses", () => {
    const { detail } = buildSentiment(input({ mentions: two, cells: 0, negativeCells: 0 }));
    expect(detail!.threshold).toMatchObject({ negative_cell_rate: null, crossed: false });
  });

  it("[A6c] a theme is trended against the prior window; no prior answers means null, a prior window without the theme means 0", () => {
    const withPrior = buildSentiment(input({ mentions: two, priorCells: 80, priorReasonCounts: { pricing_objection: 1 } })).detail!;
    expect(withPrior.reason_classes.map((r) => [r.reason, r.mention_count, r.prior_mention_count])).toEqual([
      ["pricing_objection", 2, 1],
      ["missing_feature", 1, 0],
    ]);
    expect(withPrior.threshold!.prior_negative_cell_rate).toBe(0.025);
    const none = buildSentiment(input({ mentions: two, priorCells: 0, priorNegativeCells: 0, priorReasonCounts: {} })).detail!;
    expect(none.reason_classes.every((r) => r.prior_mention_count === null)).toBe(true);
    expect(none.threshold!.prior_negative_cell_rate).toBeNull();
  });

  // ---- Owner decision 23: demo data is shown, labelled, and never raises a task.
  it("[D23] demo or mixed data past the threshold is analysed and labelled but asks for no task; live data does", () => {
    for (const dataSource of ["demo", "mixed"] as const) {
      const { write, detail } = buildSentiment(input({ mentions: two, dataSource, cells: 100, negativeCells: 10 }));
      expect(detail!.data_source).toBe(dataSource);
      expect(detail!.threshold!.crossed).toBe(true);
      expect(detail!.reason_classes).toHaveLength(2);
      expect(write.findings.every((f) => f.task_rule_code === undefined && f.no_action === true), dataSource).toBe(true);
    }
    expect(tasksWith({ dataSource: "live", cells: 100, negativeCells: 10 })).toBe(2);
  });
});
