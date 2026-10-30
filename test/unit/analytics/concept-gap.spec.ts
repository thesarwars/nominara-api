import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { conceptGapEntrySchema } from "../../../contracts/analytics/index.js";
import { CONCEPT_PREVALENCE_THRESHOLD, deriveConceptGap, type ConceptCandidate } from "../../../src/lib/analytics/concept-gap.js";
import { conceptTaskFingerprint, contentTargets, recoveryTaskCount } from "../../../src/lib/analytics/displacement-recovery.js";

// STORY-057 AC4/AC5 (scenarios 6, 7, 8) and AC6/AC9 (scenario 12), the pure half.
const candidate = (over: Partial<ConceptCandidate> = {}): ConceptCandidate => ({
  phrase: "role based access",
  prevalence: 0.5,
  evidenceUrl: "https://doc.example/guide",
  ...over,
});

const CITED = ["https://doc.example/guide"];
const derive = (candidates: readonly ConceptCandidate[], cited: readonly string[] = CITED) => deriveConceptGap(candidates, cited);

describe("STORY-057 · deriveConceptGap", () => {
  it("STORY-057 #6 · a concept above the threshold carries its prevalence and an evidence URL", () => {
    const { entries } = derive([candidate()]);
    expect(entries).toEqual([{ concept: "role based access", prevalence: 0.5, evidence_url: "https://doc.example/guide" }]);
    expect(conceptGapEntrySchema.safeParse(entries[0]).success).toBe(true);
  });

  it("the threshold is the documented 0.30 (>= 30% of cited passages), inclusive, and a real-typed 0.3 passes", () => {
    expect(CONCEPT_PREVALENCE_THRESHOLD).toBe(0.3);
    expect(derive([candidate({ prevalence: 0.3 })]).entries).toHaveLength(1);
    expect(derive([candidate({ prevalence: Math.fround(0.3) })]).entries).toHaveLength(1);
  });

  it("STORY-057 #7 · a concept below the threshold is NOT included", () => {
    const result = derive([candidate({ prevalence: 0.2999 }), candidate({ phrase: "zero", prevalence: 0 })]);
    expect(result.entries).toEqual([]);
    expect(result.droppedBelowThreshold).toBe(2);
  });

  it("STORY-057 #8 · a concept with no evidence URL is DROPPED, not caveated", () => {
    const result = derive([
      candidate({ phrase: "a b", evidenceUrl: "" }),
      candidate({ phrase: "c d", evidenceUrl: "   " }),
      candidate({ phrase: "e f", evidenceUrl: "not a url" }),
      candidate({ phrase: "g h", evidenceUrl: "javascript:alert(1)" }),
      candidate({ phrase: "i j", evidenceUrl: null }),
      candidate({ phrase: "k l" }),
    ]);
    expect(result.entries.map((e) => e.concept)).toEqual(["k l"]);
    expect(result.droppedNoEvidence).toBe(5);
  });

  it("a non-finite or out-of-range prevalence is dropped, never clamped into a claim", () => {
    const result = derive([candidate({ prevalence: Number.NaN }), candidate({ phrase: "x y", prevalence: 1.4 }), candidate({ phrase: "z w", prevalence: 1 })]);
    expect(result.entries.map((e) => [e.concept, e.prevalence])).toEqual([["z w", 1]]);
  });

  it("the same concept written two ways is one entry (the first, i.e. the best ranked)", () => {
    const result = derive([candidate({ phrase: "SOC 2 report" }), candidate({ phrase: "soc  2 report", prevalence: 0.9 })]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.concept).toBe("SOC 2 report");
  });

  it("an empty candidate list is an empty gap, not an error", () => {
    expect(derive([])).toEqual({ entries: [], droppedBelowThreshold: 0, droppedNoEvidence: 0, droppedNotCited: 0 });
  });

  it("STORY-057 FR-CO-03(d) · a concept whose evidence is not a source the displacers cited is dropped; no cited sources, no concepts", () => {
    const result = derive([candidate({ phrase: "cited one" }), candidate({ phrase: "other source", evidenceUrl: "https://elsewhere.example/x" })]);
    expect(result.entries.map((e) => e.concept)).toEqual(["cited one"]);
    expect(result.droppedNotCited).toBe(1);
    expect(derive([candidate()], []).entries).toEqual([]);
  });

  it("STORY-057 FR-CO-03(d) · the evidence URL matches a cited source after normalisation (tracking parameter, trailing slash)", () => {
    expect(derive([candidate({ evidenceUrl: "https://doc.example/guide/?utm_source=x" })]).entries).toHaveLength(1);
  });

  it("prevalence is rounded for display only after the threshold test", () => {
    const { entries } = derive([candidate({ prevalence: Math.fround(0.55) })]);
    expect(entries[0]!.prevalence).toBe(0.55);
  });
});

describe("STORY-057 · content tasks and their count", () => {
  const entries = [
    { concept: "SOC 2 report", prevalence: 0.6, evidence_url: "https://a.example/x" },
    { concept: "soc 2  report", prevalence: 0.5, evidence_url: "https://b.example/y" },
    { concept: "pricing tiers", prevalence: 0.4, evidence_url: "https://c.example/z" },
  ];

  it("STORY-057 #9 · one content task per distinct concept", () => {
    expect(contentTargets(entries).map((e) => e.concept)).toEqual(["SOC 2 report", "pricing tiers"]);
  });

  it("STORY-057 #11 · the count shown before the click is exactly the plan's size: concepts plus seedable domains", () => {
    const gap = [{ domain: "seed.com" }, { domain: "closed.com" }, { domain: "seed.com" }];
    expect(recoveryTaskCount(gap, entries, new Set(["seed.com"]))).toBe(1 + 2);
    expect(recoveryTaskCount([], [], new Set())).toBe(0);
  });

  it("STORY-057 #12 · the fingerprint is per project and normalised concept, so a repeat displacement reuses the task", () => {
    const a = conceptTaskFingerprint("p1", "SOC 2  Report");
    expect(a.equals(createHash("sha256").update("content:p1:soc 2 report").digest())).toBe(true);
    expect(a.equals(conceptTaskFingerprint("p1", "soc 2 report"))).toBe(true);
    expect(a.equals(conceptTaskFingerprint("p2", "soc 2 report"))).toBe(false);
    expect(a.equals(createHash("sha256").update("authority:p1:soc 2 report").digest())).toBe(false);
  });
});
