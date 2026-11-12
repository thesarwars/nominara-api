import { describe, expect, it } from "vitest";
import { buildTopics, topicPerformanceColumns, type TopicCellInput, type TopicInput, type TopicsGeoInput } from "../../../src/lib/geo/topics.js";

// STORY-188 - the stored per-cluster columns (authority_rank, leader_entity_id, gap_priority, achievability) come from the SAME A5 code as
// the persisted `topics` analysis: one formula (scoring-models.md section 10), two readers. A column that cannot be measured is null,
// never a placeholder.

const ENTITIES = [
  { key: "brand", type: "brand" as const, label: "Acme" },
  { key: "c1", type: "competitor" as const, label: "Rival" },
  { key: "c2", type: "competitor" as const, label: "Third" },
];
const cell = (prominence: Record<string, number>): TopicCellInput => ({ engineWeight: 1, entities: Object.entries(prominence).map(([key, p]) => ({ key, prominence: p })) });
const cells = (n: number, prominence: Record<string, number>): TopicCellInput[] => Array.from({ length: n }, () => cell(prominence));
const topic = (id: string, over: Partial<TopicInput> = {}): TopicInput => ({
  clusterId: id,
  label: `Topic ${id}`,
  commercialIntent: 0.8,
  cells: cells(15, { c1: 0.8, brand: 0.2 }),
  currentAlignment: 0.625,
  targetAlignment: 0.7,
  requiredConcepts: [],
  structure: null,
  ...over,
});
const input = (topics: TopicInput[]): TopicsGeoInput => ({ windowStart: "2026-09-02", windowDays: 30, rootDomain: "acme.com", dataSource: "live", entities: ENTITIES, topics });
const of = (cols: ReturnType<typeof topicPerformanceColumns>, id: string) => cols.find((c) => c.clusterId === id)!;

describe("STORY-188 / topicPerformanceColumns (pure)", () => {
  it("[AC2] a competitor leads: the brand ranks behind it, the leader is the competitor, gap and achievability follow section 10", () => {
    const cols = topicPerformanceColumns(input([topic("a"), topic("b")]));
    expect(of(cols, "a")).toMatchObject({ authorityRank: 2, leaderKey: "c1" });
    expect(of(cols, "a").achievability).toBeCloseTo(0.75, 10);
    const { detail } = buildTopics(input([topic("a"), topic("b")]));
    const row = detail!.topics.find((t) => t.cluster_id === "a")!;
    expect(of(cols, "a").gapPriority).toBeCloseTo(row.gap_priority!, 12); // one formula, two readers
    expect(of(cols, "a").gapPriority!).toBeGreaterThan(0);
  });

  it("[AC2] the brand leads: rank 1 and the leader is the brand", () => {
    const cols = topicPerformanceColumns(input([topic("a", { cells: cells(15, { brand: 0.9, c1: 0.1 }) }), topic("b")]));
    expect(of(cols, "a")).toMatchObject({ authorityRank: 1, leaderKey: "brand", gapPriority: 0 });
  });

  it("[AC2] a tie is ranked with the brand first, so input order never decides", () => {
    const cols = topicPerformanceColumns(input([topic("a", { cells: cells(15, { brand: 0.5, c1: 0.5 }) }), topic("b")]));
    expect(of(cols, "a")).toMatchObject({ authorityRank: 1, leaderKey: "brand" });
  });

  it("[AC2] rank counts every tracked entity: third place is 3", () => {
    const cs = [...cells(8, { c1: 0.9 }), ...cells(5, { c2: 0.9 }), ...cells(2, { brand: 0.9 })];
    const cols = topicPerformanceColumns(input([topic("a", { cells: cs }), topic("b")]));
    expect(of(cols, "a")).toMatchObject({ authorityRank: 3, leaderKey: "c1" });
  });

  it("[AC2] nobody has any authority in the topic: rank and leader are null, not the brand by default", () => {
    const cols = topicPerformanceColumns(input([topic("a", { cells: cells(15, {}) }), topic("b")]));
    expect(of(cols, "a")).toMatchObject({ authorityRank: null, leaderKey: null });
  });

  it("[AC2] no alignment measured: achievability and gap are null (not 0); rank and leader are still reported", () => {
    const cols = topicPerformanceColumns(input([topic("a", { currentAlignment: null, targetAlignment: null }), topic("b")]));
    expect(of(cols, "a")).toMatchObject({ authorityRank: 2, leaderKey: "c1", achievability: null, gapPriority: null });
  });

  it("[AC2] under 30 parsed answers across 2 topics the A5 analysis is withheld: authority columns are null, achievability (alignment only) is not", () => {
    const cols = topicPerformanceColumns(input([topic("a", { cells: cells(5, { c1: 0.8 }) }), topic("b", { cells: cells(5, { c1: 0.8 }) })]));
    expect(of(cols, "a")).toMatchObject({ authorityRank: null, leaderKey: null, gapPriority: null });
    expect(of(cols, "a").achievability).toBeCloseTo(0.75, 10);
  });

  it("[AC2] a topic with no answers in the window has no authority, but keeps its alignment-derived achievability", () => {
    const cols = topicPerformanceColumns(input([topic("a"), topic("b"), topic("empty", { cells: [] })]));
    expect(of(cols, "empty")).toMatchObject({ authorityRank: null, leaderKey: null, gapPriority: null });
    expect(of(cols, "empty").achievability).toBeCloseTo(0.75, 10);
  });

  it("[AC2] one entry per input topic, in input order", () => {
    expect(topicPerformanceColumns(input([topic("z"), topic("a")])).map((c) => c.clusterId)).toEqual(["z", "a"]);
    expect(topicPerformanceColumns(input([]))).toEqual([]);
  });
});
