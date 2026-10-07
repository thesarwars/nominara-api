import { describe, expect, it } from "vitest";
import { methodologyFooterSchema } from "../../../contracts/reports/index.js";
import { buildMethodologyFooter, METHODOLOGY_NOTE } from "../../../src/lib/reports/methodology-footer.js";

// NEW-E-100a — the one footer implementation (NFR-AGY-05), reused by the
// export and the portal overview. Pure: no clock, no database.

const base = {
  dataThrough: "2026-10-05",
  timeframe: "30d" as const,
  scoringVersion: "v1",
  weightOverrides: null,
  engines: [
    { engineKey: "gemini", dataSource: "live" as const, sampleSize: 30, liveCaptureRatio: 1 },
    { engineKey: "chatgpt", dataSource: "demo" as const, sampleSize: 10, liveCaptureRatio: 0.5 },
  ],
};

describe("NEW-E-100a · buildMethodologyFooter", () => {
  it("NEW-E-100a AC1 — carries every NFR-AGY-05 field and validates against the contract", () => {
    const footer = buildMethodologyFooter(base);
    expect(methodologyFooterSchema.safeParse(footer).success).toBe(true);
    expect(footer.data_through).toBe("2026-10-05");
    expect(footer.timeframe).toBe("30d");
    expect(footer.scoring_version).toBe("v1");
    expect(footer.weight_overrides).toBeNull();
    expect(footer.note).toBe(METHODOLOGY_NOTE);
    expect(footer.note.length).toBeGreaterThan(0);
  });

  it("NEW-E-100a AC1 — engines are sorted, each with its own data_source marker", () => {
    const footer = buildMethodologyFooter(base);
    expect(footer.engines).toEqual(["chatgpt", "gemini"]);
    expect(footer.engine_data_sources).toEqual([
      { engine_key: "chatgpt", data_source: "demo" },
      { engine_key: "gemini", data_source: "live" },
    ]);
  });

  it("NEW-E-100a AC1 — sample_size sums and live_capture_ratio is the sample-weighted mean", () => {
    const footer = buildMethodologyFooter(base);
    expect(footer.sample_size).toBe(40);
    expect(footer.live_capture_ratio).toBeCloseTo((30 * 1 + 10 * 0.5) / 40, 10);
  });

  it("NEW-E-100a AC1 — an unknown ratio is null, never 0", () => {
    const footer = buildMethodologyFooter({ ...base, engines: [] });
    expect(footer.live_capture_ratio).toBeNull();
    expect(footer.sample_size).toBe(0);
    expect(footer.engines).toEqual([]);
    const zeroSample = buildMethodologyFooter({
      ...base,
      engines: [{ engineKey: "gemini", dataSource: null, sampleSize: 0, liveCaptureRatio: 1 }],
    });
    expect(zeroSample.live_capture_ratio).toBeNull();
    const unknown = buildMethodologyFooter({
      ...base,
      engines: [{ engineKey: "gemini", dataSource: "live", sampleSize: 5, liveCaptureRatio: null }],
    });
    expect(unknown.live_capture_ratio).toBeNull();
  });

  it("NEW-E-100a AC1 — a measured ratio of 0 stays 0 (distinct from null)", () => {
    const footer = buildMethodologyFooter({
      ...base,
      engines: [{ engineKey: "gemini", dataSource: "demo", sampleSize: 4, liveCaptureRatio: 0 }],
    });
    expect(footer.live_capture_ratio).toBe(0);
  });

  it("NEW-E-100a AC1 — data_through null and a null engine data_source pass through as absent", () => {
    const footer = buildMethodologyFooter({
      ...base,
      dataThrough: null,
      engines: [{ engineKey: "gemini", dataSource: null, sampleSize: 0, liveCaptureRatio: null }],
    });
    expect(footer.data_through).toBeNull();
    expect(footer.engine_data_sources).toEqual([{ engine_key: "gemini", data_source: null }]);
    expect(methodologyFooterSchema.safeParse(footer).success).toBe(true);
  });

  it("NEW-E-100a AC1 — weight overrides are reported when present; an empty map is null", () => {
    expect(buildMethodologyFooter({ ...base, weightOverrides: { presence: 0.5 } }).weight_overrides).toEqual({ presence: 0.5 });
    expect(buildMethodologyFooter({ ...base, weightOverrides: {} }).weight_overrides).toBeNull();
  });

  it("NEW-E-100a AC1 — the note uses no banned vocabulary and cannot be suppressed by input", () => {
    expect(METHODOLOGY_NOTE).not.toMatch(/\b(AVI|fan-out|simulation|rank(ing)?)\b/i);
    // there is no input that omits it
    expect(buildMethodologyFooter({ ...base, engines: [] }).note).toBe(METHODOLOGY_NOTE);
  });
});
