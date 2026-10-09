import { describe, expect, it } from "vitest";
import { blendDisclosure, combineDataSources, dataSourceOf } from "../../../src/lib/analytics/data-source.js";

// NEW-A-5 — the provenance rules. null is "nothing measured", never "demo".

describe("NEW-A-5 · dataSourceOf", () => {
  it("NEW-A-5 AC2 — no measured captures is null, not demo and not live", () => {
    expect(dataSourceOf(0, 0)).toBeNull();
  });
  it("NEW-A-5 AC2 — only demo captures is demo", () => {
    expect(dataSourceOf(0, 3)).toBe("demo");
  });
  it("NEW-A-5 AC2 — only real captures is live", () => {
    expect(dataSourceOf(1, 0)).toBe("live");
  });
  it("NEW-A-5 AC2 — both kinds is mixed, at the one-each boundary", () => {
    expect(dataSourceOf(1, 1)).toBe("mixed");
  });
});

describe("NEW-A-5 · combineDataSources", () => {
  it("NEW-A-5 AC2 — an empty or all-null set is null", () => {
    expect(combineDataSources([])).toBeNull();
    expect(combineDataSources([null, null])).toBeNull();
  });
  it("NEW-A-5 AC3 — null entries are ignored rather than counted as demo", () => {
    expect(combineDataSources([null, "live"])).toBe("live");
    expect(combineDataSources([null, "demo"])).toBe("demo");
  });
  it("NEW-A-5 AC3 — live plus demo is mixed; mixed absorbs everything", () => {
    expect(combineDataSources(["live", "demo"])).toBe("mixed");
    expect(combineDataSources(["mixed", "live"])).toBe("mixed");
    expect(combineDataSources(["demo", "demo"])).toBe("demo");
  });
});

describe("NEW-A-5 · blendDisclosure", () => {
  it("NEW-A-5 AC3 — counts engines by provenance and states the inclusion policy", () => {
    expect(blendDisclosure(["live", "demo", "demo", "mixed", null])).toEqual({
      policy: "all_measured_engines",
      live_engines: 1,
      demo_engines: 2,
      mixed_engines: 1,
    });
  });
  it("NEW-A-5 AC3 — an empty blend is zeros, not absent", () => {
    expect(blendDisclosure([])).toEqual({
      policy: "all_measured_engines",
      live_engines: 0,
      demo_engines: 0,
      mixed_engines: 0,
    });
  });
});
