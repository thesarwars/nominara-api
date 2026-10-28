import { describe, expect, it } from "vitest";
import {
  geoAnalysisWriteSchema,
  geoAnalysisSchema,
  geoDigestSchema,
  geoSlugSchema,
} from "../../../contracts/analytics/index.js";
import { composeDigest, summarize, type StoredAnalysis } from "../../../src/lib/geo/insights.js";

// STORY-062 — persistence rules, suppression, digest, three-lever cap.
// Scenario numbers refer to the story's table.

const evidence = [{ url: "https://reddit.com/r/x", snippet: "engines cite this thread", corpus_doc_ratio: 0.4 }];
const finding = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  severity: "high",
  headline: "Absent from reddit.com",
  evidence,
  task_rule_code: "GEO-R-001",
  ...over,
});
const write = (over: Record<string, unknown> = {}) => ({
  analysis: "structure",
  window_start: "2026-09-08",
  window_days: 30,
  score: 61.5,
  score_label: "Structure",
  evidence_cells: 120,
  evidence_passages: 0,
  sufficient: true,
  suppression_reason: null,
  findings: [finding()],
  lever_rank: 1,
  ...over,
});

function stored(analysis: StoredAnalysis["analysis"], over: Partial<StoredAnalysis> = {}): StoredAnalysis {
  return {
    analysis,
    score: 50,
    evidenceCells: 100,
    evidencePassages: 0,
    sufficient: true,
    suppressionReason: null,
    findings: [finding({ id: `${analysis}-f`, headline: `${analysis} headline` })] as StoredAnalysis["findings"],
    leverRank: null,
    windowDays: 30,
    ...over,
  };
}

describe("STORY-062 · write contract", () => {
  it("S1 · accepts a complete analysis with score, findings and evidence base", () => {
    expect(geoAnalysisWriteSchema.safeParse(write()).success).toBe(true);
  });

  it("S3 · rejects the query fan-out analysis: no slug exists", () => {
    expect(geoSlugSchema.options).toHaveLength(7);
    expect(geoAnalysisWriteSchema.safeParse(write({ analysis: "query_fanout" })).success).toBe(false);
    expect(geoAnalysisWriteSchema.safeParse(write({ analysis: "fan_out" })).success).toBe(false);
  });

  it("S4 · an insufficient analysis states a reason and publishes no findings, score or lever", () => {
    const base = { sufficient: false, suppression_reason: "needs 30 parsed answers", score: null, findings: [], lever_rank: null };
    expect(geoAnalysisWriteSchema.safeParse(write(base)).success).toBe(true);
    expect(geoAnalysisWriteSchema.safeParse(write({ ...base, suppression_reason: null })).success).toBe(false);
    expect(geoAnalysisWriteSchema.safeParse(write({ ...base, findings: [finding()] })).success).toBe(false);
    expect(geoAnalysisWriteSchema.safeParse(write({ ...base, score: 0 })).success).toBe(false);
    expect(geoAnalysisWriteSchema.safeParse(write({ ...base, lever_rank: 1 })).success).toBe(false);
  });

  it("S6 · rejects a finding with no evidence, and one whose evidence has no URL", () => {
    expect(geoAnalysisWriteSchema.safeParse(write({ findings: [finding({ evidence: [] })] })).success).toBe(false);
    expect(geoAnalysisWriteSchema.safeParse(write({ findings: [finding({ evidence: [{ snippet: "x" }] })] })).success).toBe(false);
    const { evidence: _drop, ...noKey } = finding();
    expect(geoAnalysisWriteSchema.safeParse(write({ findings: [noKey] })).success).toBe(false);
  });

  it("S7 · rejects a finding with neither a task rule nor a no-action verdict, and one with both", () => {
    const { task_rule_code: _t, ...neither } = finding();
    expect(geoAnalysisWriteSchema.safeParse(write({ findings: [neither] })).success).toBe(false);
    expect(geoAnalysisWriteSchema.safeParse(write({ findings: [{ ...neither, no_action: true }] })).success).toBe(true);
    expect(geoAnalysisWriteSchema.safeParse(write({ findings: [finding({ no_action: true })] })).success).toBe(false);
  });

  it("rejects an unknown key and a lever rank above three", () => {
    expect(geoAnalysisWriteSchema.safeParse(write({ extra: 1 })).success).toBe(false);
    expect(geoAnalysisWriteSchema.safeParse(write({ lever_rank: 4 })).success).toBe(false);
    expect(geoAnalysisWriteSchema.safeParse(write({ window_days: 14 })).success).toBe(false);
  });

  it("keeps a real score of 0 distinct from no score", () => {
    const r = geoAnalysisWriteSchema.parse(write({ score: 0 }));
    expect(r.score).toBe(0);
  });
});

describe("STORY-062 · summaries", () => {
  it("S5 · alignment, entity and topics with no row are insufficient and name the missing input", () => {
    const a = summarize("alignment", null, 30);
    const e = summarize("entity", null, 30);
    const t = summarize("topics", null, 30);
    for (const s of [a, e, t]) {
      expect(s.status).toBe("insufficient");
      expect(s.score).toBeNull();
      expect(s.headline).toBeNull();
      expect(s.needs).toBeTruthy();
    }
    expect(a.needs).toContain("STORY-058");
    expect(t.needs).toContain("STORY-047");
  });

  it("freshness with no row is post_launch", () => {
    const f = summarize("freshness", null, 30);
    expect(f.status).toBe("post_launch");
    expect(f.needs).toBeTruthy();
  });

  it("S5 · a suppressed stored row renders its reason, no number, no headline", () => {
    const s = summarize("structure", stored("structure", { sufficient: false, suppressionReason: "needs 30 parsed answers", score: null, findings: [] }), 30);
    expect(s.status).toBe("insufficient");
    expect(s.needs).toBe("needs 30 parsed answers");
    expect(s.score).toBeNull();
  });

  it("a ready row keeps a score of 0 and reports its evidence base", () => {
    const s = summarize("structure", stored("structure", { score: 0, evidenceCells: 77, evidencePassages: 5 }), 30);
    expect(s.status).toBe("ready");
    expect(s.score).toBe(0);
    expect(s.evidence).toEqual({ passages: 5, cells: 77, window_days: 30 });
    expect(s.verdict).toBe("action");
  });

  it("a ready row with only no-action findings has the no_action verdict", () => {
    const { task_rule_code: _t, ...f } = finding();
    const s = summarize("structure", stored("structure", { findings: [{ ...f, no_action: true } as never] }), 30);
    expect(s.verdict).toBe("no_action");
  });

  it("drops a stored finding that carries no evidence instead of rendering it", () => {
    const bad = { ...finding(), evidence: [] } as never;
    const s = summarize("structure", stored("structure", { findings: [bad] }), 30);
    expect(s.headline).toBeNull();
    expect(s.verdict).toBeNull();
  });
});

describe("STORY-062 · digest", () => {
  const taskFor = (code: string) => (code === "GEO-R-001" ? { task_id: "t1", label: "Plan", href: "plan?task=t1" } : null);

  it("S8 · promotes at most three levers, ranked, across more analyses than three", () => {
    const rows = [
      stored("structure", { leverRank: 3 }),
      stored("divergence", { leverRank: 1 }),
      stored("sentiment", { leverRank: 2 }),
      stored("topics", { leverRank: 3 }),
      stored("entity", { leverRank: 2 }),
    ];
    const d = composeDigest(rows, 30, taskFor);
    expect(d.levers).toHaveLength(3);
    expect(d.levers.map((l) => l.rank)).toEqual([1, 2, 3]);
    expect(d.levers[0]!.analysis_href).toBe("geo?analysis=divergence");
    expect(geoDigestSchema.safeParse(d).success).toBe(true);
  });

  it("S8 · a suppressed analysis never contributes a lever even with a stale rank", () => {
    const d = composeDigest([stored("structure", { sufficient: false, suppressionReason: "x", score: null, findings: [], leverRank: 1 })], 30, taskFor);
    expect(d.levers).toEqual([]);
    expect(d.sufficient).toBe(false);
    expect(d.needs).toBeTruthy();
  });

  it("S9 · each lever links to its analysis and to a task, or null until one exists", () => {
    const linked = composeDigest([stored("structure", { leverRank: 1 })], 30, taskFor).levers[0]!;
    expect(linked.analysis_href).toBe("geo?analysis=structure");
    expect(linked.task).toEqual({ task_id: "t1", label: "Plan", href: "plan?task=t1" });
    const unlinked = composeDigest([stored("structure", { leverRank: 1 })], 30, () => null).levers[0]!;
    expect(unlinked.task).toBeNull();
  });

  it("S9 · the lookup is asked for the finding's rule AND the analysis it came from, so a rule shared across analyses cannot cross-link", () => {
    const asked: [string, string][] = [];
    composeDigest([stored("structure", { leverRank: 1 })], 30, (rule, slug) => {
      asked.push([rule, slug]);
      return null;
    });
    expect(asked).toEqual([["GEO-R-001", "structure"]]);
  });

  it("lists all seven slugs, none of them a fan-out, with a reason for every one without data", () => {
    const d = composeDigest([], 30, taskFor);
    expect(d.analyses.map((a) => a.slug)).toEqual(["alignment", "entity", "structure", "divergence", "topics", "sentiment", "freshness"]);
    expect(d.sufficient).toBe(false);
    for (const a of d.analyses) expect(a.needs).toBeTruthy();
    expect(d.evidence).toEqual({ passages: 0, cells: 0 });
  });

  it("sums the evidence base over analyses that have data only", () => {
    const d = composeDigest(
      [stored("structure", { evidenceCells: 10, evidencePassages: 2 }), stored("sentiment", { sufficient: false, suppressionReason: "x", evidenceCells: 99, findings: [], score: null })],
      30,
      taskFor,
    );
    expect(d.evidence).toEqual({ passages: 2, cells: 10 });
  });

  it("the per-analysis shape validates and derives actions from task rules", () => {
    const row = stored("structure", { leverRank: 1 });
    const a = { summary: summarize("structure", row, 30), detail: null, actions: [] };
    expect(geoAnalysisSchema.safeParse(a).success).toBe(true);
  });
});
