import { describe, expect, it } from "vitest";
import { rawCaptureSchema } from "../../../src/lib/engines/contract.js";

// STORY-027 T18 — empty vs absent. `[]` and "the key was never provided"
// are different observations (an engine that returned zero citations vs an
// engine whose response never carries citations at all) and must not
// collapse into each other through validation.
describe("STORY-027 · T18 · empty vs absent round-trip distinguishably", () => {
  const base = {
    text: "Answer",
    format: "markdown" as const,
    truncated: false,
    responseTokensEst: 10,
    latencyMs: 100,
    costUsd: 0,
  };

  it("structuredCitations: [] is present as an empty array, distinct from omitting the key", () => {
    const withEmpty = rawCaptureSchema.parse({ ...base, structuredCitations: [] });
    const withoutKey = rawCaptureSchema.parse(base);
    expect("structuredCitations" in withEmpty).toBe(true);
    expect(withEmpty.structuredCitations).toEqual([]);
    expect("structuredCitations" in withoutKey).toBe(false);
  });

  it("structuredElements: [] is present as an empty array, distinct from omitting the key", () => {
    const withEmpty = rawCaptureSchema.parse({ ...base, structuredElements: [] });
    const withoutKey = rawCaptureSchema.parse(base);
    expect("structuredElements" in withEmpty).toBe(true);
    expect(withEmpty.structuredElements).toEqual([]);
    expect("structuredElements" in withoutKey).toBe(false);
  });

  it("flags: [] is present as an empty array, distinct from omitting the key", () => {
    const withEmpty = rawCaptureSchema.parse({ ...base, flags: [] });
    const withoutKey = rawCaptureSchema.parse(base);
    expect("flags" in withEmpty).toBe(true);
    expect(withEmpty.flags).toEqual([]);
    expect("flags" in withoutKey).toBe(false);
  });

  it("parse() never coerces an omitted key into an empty array, or vice versa", () => {
    const parsed = rawCaptureSchema.parse(base);
    expect(parsed.structuredCitations).not.toEqual([]);
    expect(parsed.structuredCitations).toBeUndefined();
  });
});
