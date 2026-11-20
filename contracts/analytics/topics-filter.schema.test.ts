import { describe, expect, it } from "vitest";
import { competitorPanelQuerySchema } from "./competitor-panel-response.schema.js";
import { growthMapQuerySchema } from "./growth-map-response.schema.js";
import { scorecardsQuerySchema } from "./scorecards-response.schema.js";
import { parseTopicFilter, TOPIC_FILTER_MAX } from "./topics-filter.schema.js";

const A = "0199aaaa-0000-7000-8000-000000000001";
const B = "0199aaaa-0000-7000-8000-000000000002";

describe.each([
  ["scorecards", scorecardsQuerySchema, { timeframe: "custom", from: "2026-10-01", to: "2026-10-31", engines: "gemini" }],
  ["growth map", growthMapQuerySchema, { timeframe: "custom", from: "2026-10-01", to: "2026-10-31", engines: "gemini" }],
  // The panel has presets only (no custom range).
  ["competitor panel", competitorPanelQuerySchema, { timeframe: "90d", engines: "gemini" }],
] as const)("STORY-090 AC8 · topics on the %s query", (_name, schema, beside) => {
  it("accepts one id, several ids, and no topics at all, beside a custom range and engines", () => {
    expect(schema.safeParse({ topics: A }).success).toBe(true);
    expect(schema.safeParse({ topics: `${A},${B}` }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ ...beside, topics: A }).success).toBe(true);
  });

  it("refuses an empty value, a malformed id and an over-long list, naming the field", () => {
    for (const topics of ["", "not-a-uuid", `${A},nope`, `${A},x`]) {
      const result = schema.safeParse({ topics });
      expect(result.success, topics).toBe(false);
      if (!result.success) expect(result.error.issues[0]!.path).toEqual(["topics"]);
    }
    const tooMany = Array.from({ length: TOPIC_FILTER_MAX + 1 }, (_, i) => `0199aaaa-0000-7000-8000-${String(i).padStart(12, "0")}`).join(",");
    expect(schema.safeParse({ topics: tooMany }).success).toBe(false);
  });
});

describe("STORY-090 AC8 · parseTopicFilter", () => {
  it("is null when absent (no narrowing), and de-duplicates in request order", () => {
    expect(parseTopicFilter(undefined)).toBeNull();
    expect(parseTopicFilter(`${B}, ${A},${B}`)).toEqual([B, A]);
  });
});
