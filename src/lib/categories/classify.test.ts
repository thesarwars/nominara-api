import { describe, expect, it, vi } from "vitest";
import { LOW_CONFIDENCE_THRESHOLD } from "../../../contracts/projects/index.js";
import {
  CATEGORY_CLASSIFICATION_SOURCE,
  CATEGORY_SOFTMAX_TEMPERATURE,
  buildClassificationText,
  categoryConfidence,
  classifyCategory,
  cosineSimilarity,
  type CategoryDescriptor,
  type TextEmbedder,
} from "./classify.js";

// STORY-189 AC3/AC4 and decision 88(b): nearest-match by embedding, with a confidence, through the embedding port.
// The vectors here are hand-made, so each case states exactly which category is nearest and by how much.

const CATEGORIES: CategoryDescriptor[] = [
  { slug: "crm", name: "CRM", description: "contacts and deals" },
  { slug: "banks", name: "Banks", description: "checking and savings" },
  { slug: "airlines", name: "Airlines", description: "flights" },
];

/** An embedder whose answer for each text is fixed, so the nearest category is known in advance. */
function embedderFor(vectors: Record<string, number[]>, model = "test-model"): TextEmbedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model,
    calls,
    embed: vi.fn(async (texts: readonly string[]) => {
      calls.push([...texts]);
      return { vectors: texts.map((t) => vectors[t] ?? [0, 0, 1]), totalTokens: texts.length };
    }),
  };
}

const VECTORS = {
  "CRM. contacts and deals": [1, 0, 0],
  "Banks. checking and savings": [0, 1, 0],
  "Airlines. flights": [0, 0, 1],
  "a customer platform": [0.98, 0.1, 0.05],
  "somewhere in the middle": [0.58, 0.58, 0.57],
};

describe("STORY-189 · cosineSimilarity", () => {
  it("is 1 for the same direction, 0 for orthogonal, -1 for opposite", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 3])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });
  it("is 0, not NaN, for a zero vector", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  it("refuses vectors of different length rather than comparing a prefix", () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/length/i);
  });
});

describe("STORY-189 · categoryConfidence", () => {
  it("stays in [0, 1] and uses the named temperature", () => {
    expect(CATEGORY_SOFTMAX_TEMPERATURE).toBeGreaterThan(0);
    const c = categoryConfidence([0.9, 0.1, 0.1]);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThanOrEqual(1);
  });
  it("is high for a clear winner and low when every category is equally near", () => {
    expect(categoryConfidence([0.9, 0.1, 0.1])).toBeGreaterThanOrEqual(LOW_CONFIDENCE_THRESHOLD);
    expect(categoryConfidence([0.5, 0.5, 0.5])).toBeLessThan(LOW_CONFIDENCE_THRESHOLD);
  });
  it("a runner-up close behind the winner lowers it", () => {
    expect(categoryConfidence([0.9, 0.88, 0.1])!).toBeLessThan(categoryConfidence([0.9, 0.5, 0.1])!);
  });
  it("is null for no categories at all (nothing to be confident about), never 0 or 1", () => {
    expect(categoryConfidence([])).toBeNull();
  });
});

describe("STORY-189 · buildClassificationText", () => {
  it("joins the title, description, hero copy, nav and Product schema names, in that order, skipping absent parts", () => {
    expect(
      buildClassificationText({ title: "Acme", description: "Makes things", hero: "Build faster", nav: ["Widgets"], products: ["Widget Pro"] }),
    ).toBe("Acme. Makes things. Build faster. Widgets. Widget Pro");
    expect(buildClassificationText({ description: "Only this" })).toBe("Only this");
  });
  it("is empty when the page gave nothing to classify", () => {
    expect(buildClassificationText({})).toBe("");
  });
  it("is capped so one huge page cannot send an unbounded text to the provider", () => {
    expect(buildClassificationText({ description: "x".repeat(50_000) }).length).toBeLessThanOrEqual(4000);
  });
});

describe("STORY-189 · classifyCategory", () => {
  it("returns the nearest category with a confidence and the source label (AC3)", async () => {
    const embedder = embedderFor(VECTORS);
    const result = await classifyCategory("a customer platform", CATEGORIES, embedder);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("crm");
    expect(result!.confidence).toBeGreaterThanOrEqual(LOW_CONFIDENCE_THRESHOLD);
    expect(result!.source).toBe(CATEGORY_CLASSIFICATION_SOURCE);
  });

  it("a site that sits between categories gets a confidence BELOW the threshold (AC4)", async () => {
    const result = await classifyCategory("somewhere in the middle", CATEGORIES, embedderFor(VECTORS));
    expect(result!.confidence).toBeLessThan(LOW_CONFIDENCE_THRESHOLD);
  });

  it("embeds the category descriptions as the text, and only once per model across calls", async () => {
    const embedder = embedderFor(VECTORS, "once-model");
    await classifyCategory("a customer platform", CATEGORIES, embedder);
    await classifyCategory("somewhere in the middle", CATEGORIES, embedder);
    const categoryCalls = embedder.calls.filter((texts) => texts.includes("CRM. contacts and deals"));
    expect(categoryCalls).toHaveLength(1);
    expect(embedder.calls.flat()).toContain("a customer platform");
  });

  it("a different model re-embeds the categories: vectors from two models are never compared (EC-23)", async () => {
    const a = embedderFor(VECTORS, "model-a");
    const b = embedderFor(VECTORS, "model-b");
    await classifyCategory("a customer platform", CATEGORIES, a);
    await classifyCategory("a customer platform", CATEGORIES, b);
    expect(b.calls.some((texts) => texts.includes("CRM. contacts and deals"))).toBe(true);
  });

  it("sends at most 96 texts per provider call", async () => {
    const many: CategoryDescriptor[] = Array.from({ length: 200 }, (_, i) => ({ slug: `c${String(i)}`, name: `N${String(i)}`, description: "d" }));
    const embedder = embedderFor({}, "big-model");
    await classifyCategory("anything", many, embedder);
    expect(Math.max(...embedder.calls.map((c) => c.length))).toBeLessThanOrEqual(96);
  });

  it("an empty page text is not classified at all: null, and no provider call is spent", async () => {
    const embedder = embedderFor(VECTORS, "empty-model");
    expect(await classifyCategory("   ", CATEGORIES, embedder)).toBeNull();
    expect(embedder.calls).toEqual([]);
  });

  it("an empty taxonomy classifies nothing: null", async () => {
    expect(await classifyCategory("a customer platform", [], embedderFor(VECTORS))).toBeNull();
  });

  it("a provider failure propagates so the caller can decide, and a failed category embedding is not cached", async () => {
    let fail = true;
    const embedder: TextEmbedder = {
      model: "flaky-model",
      embed: async (texts) => {
        if (fail) throw new Error("provider down");
        return { vectors: texts.map(() => [1, 0, 0]), totalTokens: 1 };
      },
    };
    await expect(classifyCategory("a customer platform", CATEGORIES, embedder)).rejects.toThrow("provider down");
    fail = false;
    await expect(classifyCategory("a customer platform", CATEGORIES, embedder)).resolves.not.toBeNull();
  });

  it("a provider that returns fewer vectors than texts is an error, never a partial classification", async () => {
    const embedder: TextEmbedder = { model: "short-model", embed: async () => ({ vectors: [[1, 0, 0]], totalTokens: 1 }) };
    await expect(classifyCategory("a customer platform", CATEGORIES, embedder)).rejects.toThrow(/vector/i);
  });
});
