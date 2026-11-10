import { describe, expect, it } from "vitest";
import { renderingQualityResponseSchema } from "../../../contracts/analytics/index.js";
import { ATTR_WEIGHT } from "../parser/rendering.js";
import {
  buildRenderingQuality,
  RENDERING_ATTRIBUTES,
  RENDERING_CAUSE_RULES,
  type EngineCounts,
  type LiveFinding,
} from "./rendering-quality.js";

// NEW-C-11 (scoring-models.md §8; STORY-039 read side). Pure: the score is the
// existing formula's, handed in; this builds attribute coverage, exclusion,
// the per-engine/blended split and the cause link. Scoring is a dangerous area.

const ID = "0195e5b7-0000-7000-8000-0000000000b1";
const finding = (over: Partial<LiveFinding> = {}): LiveFinding => ({
  id: ID, ruleCode: "AUX-R-012", severity: "high", title: "Offer data absent", ...over,
});
const counts = (engineKey: string, mentions: number, withAttr: EngineCounts["withAttr"] = {}): EngineCounts => ({ engineKey, mentions, withAttr });
const eng = (engineKey: string, score: number | null, dataSource: "live" | "demo" | "mixed" | null = "demo") => ({
  engineKey, displayName: engineKey, score, dataSource,
});
const build = (over: Partial<Parameters<typeof buildRenderingQuality>[0]> = {}) =>
  buildRenderingQuality({
    engines: [eng("google_ai_mode", 40), eng("google_aio", 30), eng("gemini", null, "live")],
    counts: [counts("google_ai_mode", 10, { price: 4, rating: 10, image: 5 }), counts("google_aio", 10, { image: 2 })],
    findings: [],
    blendedScore: 35,
    blendedDataSource: "mixed",
    ...over,
  });
const attr = (entry: { attributes: { attribute: string }[] }, name: string) =>
  entry.attributes.find((a) => a.attribute === name) as ReturnType<typeof build>["engines"][number]["attributes"][number];

describe("NEW-C-11 · buildRenderingQuality", () => {
  it("[NEW-C-11 AC1] reports all seven weighted attributes per engine, with their section 8 weights, and satisfies the contract", () => {
    const out = build();
    expect(RENDERING_ATTRIBUTES).toEqual(["price", "rating", "image", "spec", "description", "link", "availability"]);
    for (const entry of out.engines) {
      expect(entry.attributes.map((a) => a.attribute)).toEqual([...RENDERING_ATTRIBUTES]);
      for (const a of entry.attributes) expect(a.weight).toBe(ATTR_WEIGHT[a.attribute]);
    }
    expect(out.blended.attributes).toHaveLength(7);
    expect(renderingQualityResponseSchema.safeParse({
      project_id: ID, timeframe: "30d", window: { from: "a", to: "b", timezone: "UTC" }, ...out,
    }).success).toBe(true);
  });

  it("[NEW-C-11 AC2] an engine that cannot render attributes is excluded: score null, nothing counted, listed as not rich", () => {
    const out = build({ engines: [eng("gemini", 77, "live"), eng("google_ai_mode", 40)], counts: [counts("gemini", 9, { link: 9 }), counts("google_ai_mode", 10, { price: 5 })] });
    const gemini = out.engines.find((e) => e.engine_key === "gemini")!;
    expect(gemini).toMatchObject({ renders_attributes: false, score: null, mentions_counted: 0 });
    expect(gemini.attributes.every((a) => a.coverage === null && a.surface_unavailable)).toBe(true);
    expect(out.rich_rendering_engines).toEqual(["google_ai_mode"]);
    expect(out.blended.mentions_counted).toBe(10);
  });

  it("[NEW-C-11 AC2] no mentions: score null, coverage null on every attribute, never 0", () => {
    const out = build({ engines: [eng("google_ai_mode", null, null)], counts: [], blendedScore: null, blendedDataSource: null });
    const e = out.engines[0]!;
    expect(e.score).toBeNull();
    expect(e.mentions_counted).toBe(0);
    expect(e.attributes.every((a) => a.coverage === null)).toBe(true);
    expect(out.blended.score).toBeNull();
    expect(out.blended.attributes.every((a) => a.coverage === null)).toBe(true);
    expect(e.data_source).toBeNull();
  });

  it("[NEW-C-11 AC2] a real zero is kept distinct from null: counted mentions with no price give coverage 0 and score 0", () => {
    const out = build({ engines: [eng("google_ai_mode", 0)], counts: [counts("google_ai_mode", 4, {})], blendedScore: 0 });
    expect(out.engines[0]!.score).toBe(0);
    expect(attr(out.engines[0]!, "price").coverage).toBe(0);
    expect(out.blended.score).toBe(0);
  });

  it("[NEW-C-11 AC1] coverage is the share of counted mentions carrying the attribute (boundary: all, none)", () => {
    const out = build({ counts: [counts("google_ai_mode", 10, { price: 10, rating: 0, image: 5 }), counts("google_aio", 4, { image: 4 })] });
    const mode = out.engines.find((e) => e.engine_key === "google_ai_mode")!;
    expect(attr(mode, "price").coverage).toBe(1);
    expect(attr(mode, "rating").coverage).toBe(0);
    expect(attr(mode, "image").coverage).toBe(0.5);
    expect(attr(out.engines.find((e) => e.engine_key === "google_aio")!, "image").coverage).toBe(1);
  });

  it("[NEW-C-11 AC1] priced attributes are surface-unavailable on AI Overviews, and do not dilute the blend", () => {
    const out = build();
    const aio = out.engines.find((e) => e.engine_key === "google_aio")!;
    for (const name of ["price", "rating", "availability"]) {
      expect(attr(aio, name)).toMatchObject({ surface_unavailable: true, coverage: null, cause: null });
    }
    expect(attr(aio, "image").surface_unavailable).toBe(false);
    expect(aio.has_priced_elements).toBe(false);
    expect(out.engines.find((e) => e.engine_key === "google_ai_mode")!.has_priced_elements).toBe(true);
    // price pooled over AI Mode only: 4 of 10, not 4 of 20.
    expect(attr(out.blended, "price").coverage).toBe(0.4);
    // image pooled over both: 7 of 20.
    expect(attr(out.blended, "image").coverage).toBeCloseTo(0.35, 12);
  });

  it("[NEW-C-11 AC3] a missing price links to an open finding of the mapped rule", () => {
    const out = build({ findings: [finding()] });
    const price = attr(out.engines.find((e) => e.engine_key === "google_ai_mode")!, "price");
    expect(price.cause).toEqual({ finding_id: ID, rule_code: "AUX-R-012", severity: "high", title: "Offer data absent" });
    expect(attr(out.blended, "price").cause?.finding_id).toBe(ID);
  });

  it("[NEW-C-11 AC3] the mapping is price -> AUX-R-012/013 and rating -> AUX-R-013/015, and a rule off the map links nothing", () => {
    expect(RENDERING_CAUSE_RULES).toEqual({ price: ["AUX-R-012", "AUX-R-013"], rating: ["AUX-R-013", "AUX-R-015"] });
    const rating = build({ findings: [finding({ ruleCode: "AUX-R-015" })] });
    const mode = rating.engines.find((e) => e.engine_key === "google_ai_mode")!;
    expect(attr(mode, "rating").coverage).toBe(1);
    // rating is fully present here, so nothing is missing and there is no cause
    expect(attr(mode, "rating").cause).toBeNull();
    const off = build({ findings: [finding({ ruleCode: "AUX-R-008" })] });
    expect(attr(off.engines.find((e) => e.engine_key === "google_ai_mode")!, "price").cause).toBeNull();
    const r15 = build({ counts: [counts("google_ai_mode", 10, { price: 4, rating: 3 })], findings: [finding({ ruleCode: "AUX-R-015", severity: "medium" })] });
    expect(attr(r15.engines.find((e) => e.engine_key === "google_ai_mode")!, "rating").cause?.rule_code).toBe("AUX-R-015");
    expect(attr(r15.engines.find((e) => e.engine_key === "google_ai_mode")!, "price").cause).toBeNull();
  });

  it("[NEW-C-11 AC3] no cause where the attribute is not missing, where coverage is null, or on a low-weight attribute", () => {
    const full = build({ counts: [counts("google_ai_mode", 10, { price: 10 }), counts("google_aio", 10)], findings: [finding()] });
    expect(attr(full.engines.find((e) => e.engine_key === "google_ai_mode")!, "price").cause).toBeNull();
    const none = build({ engines: [eng("google_ai_mode", null, null)], counts: [], findings: [finding()], blendedScore: null, blendedDataSource: null });
    expect(attr(none.engines[0]!, "price").cause).toBeNull();
    const out = build({ findings: [finding({ ruleCode: "AUX-R-013" })] });
    expect(attr(out.engines[0]!, "image").cause).toBeNull();
  });

  it("[NEW-C-11 AC3] with several open findings the most severe is the cause; ties keep the input (newest-first) order", () => {
    const out = build({ findings: [finding({ id: "a", severity: "medium" }), finding({ id: "b", ruleCode: "AUX-R-013", severity: "critical" }), finding({ id: "c", severity: "critical" })] });
    expect(attr(out.engines.find((e) => e.engine_key === "google_ai_mode")!, "price").cause?.finding_id).toBe("b");
  });

  it("[NEW-C-11 AC4] carries each engine's data_source (live / demo / mixed / null) and the blend's", () => {
    const out = build({ engines: [eng("google_ai_mode", 40, "demo"), eng("gemini", null, "live"), eng("google_aio", 30, "mixed"), eng("chatgpt", null, null)] });
    expect(out.engines.map((e) => e.data_source)).toEqual(["demo", "live", "mixed", null]);
    expect(out.blended.data_source).toBe("mixed");
  });

  it("[NEW-C-11 AC2] the blended score and every per-engine score are handed through unchanged (no second formula)", () => {
    const out = build({ engines: [eng("google_ai_mode", 41.25), eng("google_aio", 12.5)], blendedScore: 26.875 });
    expect(out.engines.map((e) => e.score)).toEqual([41.25, 12.5]);
    expect(out.blended.score).toBe(26.875);
  });
});
