import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CLUSTER_SIMILARITY_FLOOR, FUNNEL_WEIGHT_SQL, FUNNEL_WEIGHTS, MATERIAL_CHANGE_FRACTION, MIN_CLUSTER_SIZE, WEEKLY_RECOMPUTE_DAYS } from "./constants.js";
import { TemplateTopicLabeller, isReadableLabel, labelOrFallback, uniqueLabel, type TopicLabeller } from "./labeller.js";
import { matchGroupsToClusters } from "./matching.js";
import { decideTrigger } from "./sweep.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("STORY-047 · constants come from the reference exactly", () => {
  it("AC1 - the similarity floor is 0.82 (aux-and-geo-analysis.md section on prompt clusters)", () => {
    expect(CLUSTER_SIMILARITY_FLOOR).toBe(0.82);
  });
  it("AC4 - a material change is >= 10% and the periodic recompute is weekly (projects-and-prompts.md topic_clusters)", () => {
    expect(MATERIAL_CHANGE_FRACTION).toBe(0.1);
    expect(WEEKLY_RECOMPUTE_DAYS).toBe(7);
  });
  it("AC6 - funnel weights are decision 1.0, consideration 0.7, awareness 0.4 (scoring-models.md)", () => {
    expect(FUNNEL_WEIGHTS).toEqual({ decision: 1.0, consideration: 0.7, awareness: 0.4 });
  });
  it("AC6 - the SQL weights are the same numbers as FUNNEL_WEIGHTS", () => {
    expect(FUNNEL_WEIGHT_SQL).toContain(`'decision' THEN ${FUNNEL_WEIGHTS.decision.toFixed(1)}`);
    expect(FUNNEL_WEIGHT_SQL).toContain(`'consideration' THEN ${FUNNEL_WEIGHTS.consideration.toFixed(1)}`);
    expect(FUNNEL_WEIGHT_SQL).toContain(`ELSE ${FUNNEL_WEIGHTS.awareness.toFixed(1)}`);
  });
  it("AC8 - a cluster needs at least two members, so a lone prompt is an outlier", () => {
    expect(MIN_CLUSTER_SIZE).toBe(2);
  });
});

describe("STORY-047 AC2 - labels are human-readable", () => {
  it("scenario 1 - the template labeller turns the representative prompt into a short phrase, not a token list or an id", async () => {
    const label = await new TemplateTopicLabeller().label({ prompts: ["What is the best CRM software for enterprise teams?", "Which CRM scales for a large enterprise"] });
    expect(label).toBe("Best CRM software for enterprise teams");
    expect(isReadableLabel(label)).toBe(true);
  });
  it("the template label is bounded and cut at a word boundary", async () => {
    const label = await new TemplateTopicLabeller().label({ prompts: [`how do I choose ${"scalable ".repeat(30)}tooling`] });
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label.endsWith(" ")).toBe(false);
    expect(isReadableLabel(label)).toBe(true);
  });
  it("rejects an identifier, a number, a token list and a blank as a label", () => {
    for (const bad of ["", "   ", "0198f3a1-7c11-7000-8000-000000000001", "42", "cluster_17", "crm, saas, b2b, enterprise, scale", "a\nb", "x".repeat(81)]) {
      expect(isReadableLabel(bad), bad).toBe(false);
    }
    expect(isReadableLabel("Enterprise scale & reliability")).toBe(true);
  });
  it("a model label that is not readable falls back to the template, and a throwing model falls back too", async () => {
    const prompts = ["How does pricing compare across vendors?"];
    const junk: TopicLabeller = { label: () => Promise.resolve("0198f3a1-7c11-7000-8000-000000000001") };
    const boom: TopicLabeller = { label: () => Promise.reject(new Error("model down")) };
    expect(await labelOrFallback(junk, { prompts })).toEqual({ label: "How does pricing compare across vendors", source: "template" });
    expect((await labelOrFallback(boom, { prompts })).source).toBe("template");
    expect(await labelOrFallback({ label: () => Promise.resolve("Pricing comparison") }, { prompts })).toEqual({ label: "Pricing comparison", source: "model" });
  });
  it("a model that never answers falls back to the template once the bound passes, and the timer is cleared", async () => {
    vi.useFakeTimers();
    try {
      const hang: TopicLabeller = { label: () => new Promise<string>(() => undefined) };
      const pending = labelOrFallback(hang, { prompts: ["How does pricing compare across vendors?"] }, 25);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(25);
      expect(await pending).toEqual({ label: "How does pricing compare across vendors", source: "template" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("a model that answers promptly leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      await labelOrFallback({ label: () => Promise.resolve("Pricing comparison") }, { prompts: ["x"] }, 15_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("a model that answers inside the bound is used", async () => {
    const slow: TopicLabeller = { label: () => new Promise<string>((resolve) => setTimeout(() => resolve("Pricing comparison"), 5)) };
    expect((await labelOrFallback(slow, { prompts: ["x"] }, 500)).source).toBe("model");
  });
  it("uniqueLabel keeps labels distinct case-insensitively (ux_topic_clusters)", () => {
    const taken = new Set(["pricing"]);
    expect(uniqueLabel("Pricing", taken)).toBe("Pricing (2)");
    expect(uniqueLabel("Pricing", taken)).toBe("Pricing (3)");
    expect(uniqueLabel("Security", taken)).toBe("Security");
  });
});

describe("STORY-047 AC3 - matching keeps a cluster's identity (and so its user label) across recomputation", () => {
  const old = (id: string, memberCount: number, labelSource: "auto" | "user" = "auto") => ({ id, memberCount, labelSource });
  it("pairs each group with the old cluster most of its members came from", () => {
    const m = matchGroupsToClusters(
      [{ index: 0, memberCount: 4, overlaps: new Map([["a", 4]]) }, { index: 1, memberCount: 3, overlaps: new Map([["b", 3]]) }],
      [old("a", 4), old("b", 3, "user")],
    );
    expect([...m.entries()]).toEqual([[0, "a"], [1, "b"]]);
  });
  it("one old cluster is matched at most once (a split keeps the label on the larger half)", () => {
    const m = matchGroupsToClusters(
      [{ index: 0, memberCount: 2, overlaps: new Map([["a", 2]]) }, { index: 1, memberCount: 5, overlaps: new Map([["a", 5]]) }],
      [old("a", 7, "user")],
    );
    expect(m.get(1)).toBe("a");
    expect(m.has(0)).toBe(false);
  });
  it("a group that shares less than half of the smaller side with any old cluster is new", () => {
    const m = matchGroupsToClusters([{ index: 0, memberCount: 10, overlaps: new Map([["a", 1]]) }], [old("a", 10)]);
    expect(m.size).toBe(0);
  });
  it("a USER-labelled cluster that dissolves (no group overlaps half of the smaller side) is not carried: its label goes with it", () => {
    const m = matchGroupsToClusters([{ index: 0, memberCount: 3, overlaps: new Map([["u", 1]]) }], [old("u", 4, "user")]);
    expect(m.size).toBe(0);
  });
  it("an exact half overlap matches (boundary), one member fewer does not", () => {
    expect(matchGroupsToClusters([{ index: 0, memberCount: 4, overlaps: new Map([["a", 2]]) }], [old("a", 4)]).get(0)).toBe("a");
    expect(matchGroupsToClusters([{ index: 0, memberCount: 5, overlaps: new Map([["a", 2]]) }], [old("a", 5)]).has(0)).toBe(false);
  });
  it("with no old clusters and no groups it is empty", () => {
    expect(matchGroupsToClusters([], []).size).toBe(0);
    expect(matchGroupsToClusters([{ index: 0, memberCount: 2, overlaps: new Map() }], []).size).toBe(0);
  });
  it("on equal overlap a user-labelled cluster is preferred, then the lower id (deterministic)", () => {
    const m = matchGroupsToClusters([{ index: 0, memberCount: 4, overlaps: new Map([["a", 2], ["b", 2]]) }], [old("a", 4), old("b", 4, "user")]);
    expect(m.get(0)).toBe("b");
  });
});

describe("STORY-047 AC10 / scenario 9 - all vector work happens in the database", () => {
  const files = readdirSync(HERE).filter((name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"));
  const sources = files.map((name) => [name, readFileSync(path.join(HERE, name), "utf8")] as const);
  const handler = readFileSync(path.join(HERE, "../queue/handlers/topic-cluster.handler.ts"), "utf8");

  it("scenario 9 - no source in src/lib/topics or the handler does arithmetic on a vector", () => {
    for (const [name, text] of [...sources, ["topic-cluster.handler.ts", handler] as const]) {
      const code = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, name).not.toMatch(/Math\.(sqrt|hypot|acos|pow)|\bcosine\w*\(|\bdot\w*\(|\.reduce\(/);
    }
  });
  it("scenario 9 - no statement returns the embedding or the centroid to the application", () => {
    for (const [name, text] of [...sources, ["topic-cluster.handler.ts", handler] as const]) {
      const code = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      // an embedding column may appear only as an operand of <=>, avg(), or an IS [NOT] NULL test, never in a select list.
      const bare = code.replace(/<=>/g, " ").replace(/avg\([^)]*\)/gi, " ").replace(/embedding\s+IS\s+(NOT\s+)?NULL/gi, " ").replace(/embedding_model/g, " ");
      expect(bare, name).not.toMatch(/SELECT[^;`"]*\b(embedding|centroid)\b[^;`"]*FROM/i);
    }
  });
});

describe("STORY-047 AC4 - the trigger rules at their boundaries", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const base = { clusterable: 20, clusters: 3, arrived: 0, departed: 0, recent: 0, lastClusteredAt: new Date("2026-10-27T12:00:00Z") };
  it("exactly 10% is a material change; one prompt less is not", () => {
    expect(decideTrigger({ ...base, arrived: 2 }, now)).toBe("prompt_set_change");
    expect(decideTrigger({ ...base, clusterable: 21, arrived: 2 }, now)).toBeNull();
  });
  it("departures count toward the same fraction, over the set including the departed", () => {
    expect(decideTrigger({ ...base, clusterable: 18, departed: 2 }, now)).toBe("prompt_set_change");
    expect(decideTrigger({ ...base, clusterable: 19, departed: 2 }, now)).toBeNull();
  });
  it("seven days to the millisecond is weekly; one millisecond short is not", () => {
    expect(decideTrigger({ ...base, lastClusteredAt: new Date(now.getTime() - 7 * 86_400_000) }, now)).toBe("weekly");
    expect(decideTrigger({ ...base, lastClusteredAt: new Date(now.getTime() - 7 * 86_400_000 + 1) }, now)).toBeNull();
  });
  it("no clusters: due only with >= 2 clusterable prompts and a recent change", () => {
    const none = { ...base, clusters: 0, lastClusteredAt: null, recent: 1 };
    expect(decideTrigger(none, now)).toBe("initial");
    expect(decideTrigger({ ...none, clusterable: 1 }, now)).toBeNull();
    expect(decideTrigger({ ...none, recent: 0 }, now)).toBeNull();
    expect(decideTrigger({ ...none, clusterable: 0 }, now)).toBeNull();
  });
  it("an empty set is never a division by zero", () => {
    expect(decideTrigger({ ...base, clusterable: 0, departed: 0, arrived: 0 }, now)).toBeNull();
  });
});
