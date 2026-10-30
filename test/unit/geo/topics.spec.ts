import { describe, expect, it } from "vitest";
import { geoAnalysisWriteSchema, geoTopicsDetailSchema } from "../../../contracts/analytics/index.js";
import {
  achievability,
  buildTopics,
  TOPIC_MIN_ACHIEVABILITY,
  TOPIC_MIN_ANSWERS,
  type TopicCellInput,
  type TopicsGeoInput,
  type TopicInput,
} from "../../../src/lib/geo/topics.js";

// STORY-061 - A5 topical authority (pure). Scenario numbers are the story's table. Authority is SoV x presence_rate over the
// topic's answers, with the SoV of scoring-models.md section 2 (an absent entity contributes 0 to the numerator and its weight to the
// denominator); achievability comes from the alignment distance and a topic below the minimum is never recommended.

const ENTITIES = [
  { key: "brand", type: "brand" as const, label: "Acme" },
  { key: "c1", type: "competitor" as const, label: "Rival" },
];

/** One answer: the listed entities with their prominence. */
const cell = (prominence: Record<string, number>, engineWeight = 1): TopicCellInput => ({
  engineWeight,
  entities: Object.entries(prominence).map(([key, p]) => ({ key, prominence: p })),
});
const cells = (n: number, prominence: Record<string, number>): TopicCellInput[] => Array.from({ length: n }, () => cell(prominence));

const topic = (id: string, over: Partial<TopicInput> = {}): TopicInput => ({
  clusterId: id,
  label: `Topic ${id}`,
  commercialIntent: 0.8,
  cells: cells(15, { c1: 0.8, brand: 0.2 }),
  currentAlignment: 0.62,
  targetAlignment: 0.7,
  requiredConcepts: [
    { phrase: "usage based pricing", nodeType: "pricing_term", corpusDocRatio: 0.6, evidenceUrl: "https://rival.com/pricing", evidenceSnippet: "Usage based pricing" },
    { phrase: "soc 2", nodeType: "compliance", corpusDocRatio: 0.4, evidenceUrl: "https://rival.com/trust", evidenceSnippet: "SOC 2 Type II" },
  ],
  structure: "comparison_table",
  ...over,
});

const input = (topics: TopicInput[], over: Partial<TopicsGeoInput> = {}): TopicsGeoInput => ({
  windowStart: "2026-09-02",
  windowDays: 30,
  rootDomain: "acme.com",
  dataSource: "live",
  entities: ENTITIES,
  topics,
  ...over,
});

describe("STORY-061 / A5 topical authority (pure)", () => {
  it("[#7] a topic where a competitor dominates is owned by the competitor (argmax authority)", () => {
    const { detail } = buildTopics(input([topic("a"), topic("b")]));
    const row = detail!.topics.find((t) => t.cluster_id === "a")!;
    expect(row.owner).toMatchObject({ entity_type: "competitor", entity_label: "Rival" });
    expect(row.authorities.map((x) => x.entity_label).sort()).toEqual(["Acme", "Rival"]);
  });

  it("[#7] authority(e, t) = SoV x presence_rate, with absent cells in the SoV denominator", () => {
    // 20 answers: Rival in 10 (prominence 0.8 against the brand's 0.2 in those), the brand alone in 10 (0.9).
    const mixed = [...cells(10, { c1: 0.8, brand: 0.2 }), ...cells(10, { brand: 0.9 })];
    const { detail } = buildTopics(input([topic("a", { cells: mixed }), topic("b")]));
    const row = detail!.topics.find((t) => t.cluster_id === "a")!;
    const rival = row.authorities.find((x) => x.entity_label === "Rival")!;
    const brand = row.authorities.find((x) => x.entity_label === "Acme")!;
    expect(rival.sov).toBeCloseTo(0.4, 10); // (10 * 0.8 + 10 * 0) / 20
    expect(rival.presence_rate).toBe(0.5);
    expect(rival.authority).toBeCloseTo(0.2, 10);
    expect(brand.sov).toBeCloseTo((10 * 0.2 + 10 * 1) / 20, 10);
    expect(brand.presence_rate).toBe(1);
    expect(brand.authority).toBeCloseTo(0.6, 10);
    expect(row.owner.entity_label).toBe("Acme");
  });

  it("[#7] a tied authority is owned by the brand, then by label, so input order never decides", () => {
    const tie = cells(15, { brand: 0.5, c1: 0.5 });
    const { detail } = buildTopics(input([topic("a", { cells: tie }), topic("b")]));
    expect(detail!.topics.find((t) => t.cluster_id === "a")!.owner.entity_label).toBe("Acme");
  });

  it("[AC7] a tracked entity never seen in a topic is listed with authority 0, not omitted", () => {
    const { detail } = buildTopics(input([topic("a", { cells: cells(15, { brand: 0.6 }) }), topic("b")]));
    const row = detail!.topics.find((t) => t.cluster_id === "a")!;
    expect(row.authorities.find((x) => x.entity_label === "Rival")).toMatchObject({ sov: 0, presence_rate: 0, authority: 0 });
  });

  it("[AC8] achievability = 1 - clamp01((target - current) / 0.30)", () => {
    expect(achievability(0.7, 0.7)).toBe(1);
    expect(achievability(0.75, 0.7)).toBe(1); // above the target: clamped, not above 1
    expect(achievability(0.55, 0.7)).toBeCloseTo(0.5, 10);
    expect(achievability(0.4, 0.7)).toBeCloseTo(0, 10);
    expect(achievability(0.1, 0.7)).toBe(0);
    expect(achievability(null, 0.7)).toBeNull();
    expect(achievability(0.5, null)).toBeNull();
  });

  it("[AC9] gap_priority = commercial_intent x (authority(leader) - authority(brand)) x achievability", () => {
    const { detail } = buildTopics(input([topic("a", { currentAlignment: 0.625, targetAlignment: 0.7 }), topic("b")]));
    const row = detail!.topics.find((t) => t.cluster_id === "a")!;
    const leader = row.owner.authority;
    expect(row.achievability).toBeCloseTo(0.75, 10);
    expect(row.gap_priority).toBeCloseTo(0.8 * (leader - row.brand_authority) * 0.75, 10);
  });

  it("[#8] a high-intent topic with low achievability is not recommended, and no task is asked for", () => {
    const unwinnable = topic("a", { commercialIntent: 1, currentAlignment: 0.3, targetAlignment: 0.7 });
    const { write, detail } = buildTopics(input([unwinnable, topic("b", { currentAlignment: null, targetAlignment: null })]));
    const row = detail!.topics.find((t) => t.cluster_id === "a")!;
    expect(row.achievability).toBe(0);
    expect(row.recommended).toBe(false);
    expect(row.not_recommended_reason).toMatch(/achievab/i);
    expect(detail!.gaps).toEqual([]);
    expect(write.findings.every((f) => f.task_rule_code === undefined)).toBe(true);
  });

  it("[#8] the minimum itself is recommendable and just under it is not (0.5)", () => {
    expect(TOPIC_MIN_ACHIEVABILITY).toBe(0.5);
    const at = buildTopics(input([topic("a", { currentAlignment: 0.55, targetAlignment: 0.7 }), topic("b", { currentAlignment: null, targetAlignment: null })]));
    expect(at.detail!.topics.find((t) => t.cluster_id === "a")!.recommended).toBe(true);
    const under = buildTopics(input([topic("a", { currentAlignment: 0.5501, targetAlignment: 0.7 + 0.0002 }), topic("b", { currentAlignment: null, targetAlignment: null })]));
    expect(under.detail!.topics.find((t) => t.cluster_id === "a")!.recommended).toBe(false);
  });

  it("[#8] an unmeasured alignment is null (not 0), has no gap priority, and is never recommended", () => {
    const { detail } = buildTopics(input([topic("a", { currentAlignment: null, targetAlignment: null }), topic("b", { currentAlignment: null, targetAlignment: null })]));
    for (const row of detail!.topics) {
      expect(row.achievability).toBeNull();
      expect(row.gap_priority).toBeNull();
      expect(row.recommended).toBe(false);
      expect(row.not_recommended_reason).toMatch(/alignment/i);
    }
  });

  it("[#9] a high-intent topic with adequate achievability yields a content task carrying the concepts and the structure", () => {
    const { write, detail } = buildTopics(input([topic("a"), topic("b", { currentAlignment: null, targetAlignment: null })]));
    expect(detail!.topics.find((t) => t.cluster_id === "a")!.recommended).toBe(true);
    const f = write.findings.find((x) => x.id === "topic-gap-a")!;
    expect(f.task_rule_code).toBe("TG-TOPIC-CONTENT");
    expect(f.headline).toContain("usage based pricing");
    expect(f.headline).toContain("soc 2");
    expect(f.headline).toContain("Structure it as a comparison table.");
    expect(f.headline).not.toContain("comparison_table");
    expect(f.evidence[0]!.url).toBe("https://rival.com/pricing");
    expect(detail!.gaps).toEqual([
      expect.objectContaining({ cluster_id: "a", structure: "comparison_table", required_concepts: [expect.objectContaining({ phrase: "usage based pricing" }), expect.objectContaining({ phrase: "soc 2" })] }),
    ]);
    expect(geoAnalysisWriteSchema.safeParse(write).success).toBe(true);
    expect(geoTopicsDetailSchema.safeParse(detail).success).toBe(true);
  });

  it("[#9] only the top decile of gap_priority qualifies: of 12 topics, 2 get a task", () => {
    const many = Array.from({ length: 12 }, (_, i) => topic(`t${String(i).padStart(2, "0")}`, { commercialIntent: 0.5 + i * 0.04 }));
    const { write } = buildTopics(input(many));
    expect(write.findings.filter((f) => f.task_rule_code === "TG-TOPIC-CONTENT")).toHaveLength(2);
    expect(write.findings[0]!.id).toBe("topic-gap-t11");
  });

  it("when the brand owns every topic there is no gap and the single finding needs no action", () => {
    const own = cells(15, { brand: 0.9, c1: 0.1 });
    const { write, detail } = buildTopics(input([topic("a", { cells: own }), topic("b", { cells: own })]));
    expect(detail!.topics.every((t) => t.gap_priority === 0 && !t.recommended)).toBe(true);
    expect(write.findings).toHaveLength(1);
    expect(write.findings[0]).toMatchObject({ no_action: true });
  });

  it("[#13] below 30 answers, or under two topics, the analysis is suppressed with its reason", () => {
    expect(TOPIC_MIN_ANSWERS).toBe(30);
    const few = buildTopics(input([topic("a", { cells: cells(10, { c1: 1 }) }), topic("b", { cells: cells(10, { c1: 1 }) })]));
    expect(few.write).toMatchObject({ sufficient: false, score: null, findings: [], evidence_cells: 20 });
    expect(few.write.suppression_reason).toMatch(/30 parsed answers.*2 topics/);
    expect(few.detail).toBeNull();
    const one = buildTopics(input([topic("a", { cells: cells(40, { c1: 1 }) })]));
    expect(one.write.sufficient).toBe(false);
    expect(one.write.suppression_reason).toMatch(/1 topic/);
    expect(buildTopics(input([])).write.sufficient).toBe(false);
  });

  it("exactly 30 answers across 2 topics is sufficient", () => {
    expect(buildTopics(input([topic("a"), topic("b")])).write.sufficient).toBe(true);
  });
});
