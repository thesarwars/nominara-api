import { describe, expect, it } from "vitest";
import { buildExportDocument, type ExportDocumentInput, type MetricSummary } from "../../../src/lib/reports/export-document.js";
import { renderCsv } from "../../../src/lib/reports/export-csv.js";
import { METHODOLOGY_NOTE } from "../../../src/lib/reports/methodology-footer.js";

// STORY-110 / owner decision 68(e) — the quote prefix on a leading `-` applies
// only when the cell is not a valid number. Numeric negatives stay numeric.

const summary = (over: Partial<MetricSummary> = {}): MetricSummary => ({
  visibilityScore: 50, presenceRate: 0.5, shareOfVoice: 0.25, sentimentScore: 70, citationShare: 0.1,
  measuredCells: 10, confidence: "high", dataSource: "live", ...over,
});

function csvFor(name: string, over: Partial<MetricSummary> = {}): string {
  const input: ExportDocumentInput = {
    projectName: "P",
    generatedAt: "2026-10-07T10:00:00.000Z",
    timeframe: "30d",
    window: { from: "2026-09-08", to: "2026-10-07" },
    palette: { primary: "#4f46e5", accent: "#0ea5e9", background: "#ffffff", foreground: "#0f172a", showBrandLine: true },
    footer: {
      data_through: null, engines: [], engine_data_sources: [], timeframe: "30d", sample_size: 0,
      live_capture_ratio: null, scoring_version: "v1", weight_overrides: null, note: METHODOLOGY_NOTE,
    },
    sections: ["competitors"],
    hideCompetitors: false,
    hideCosts: false,
    overview: { blended: summary(), engines: [] },
    growthMap: { engineKeys: [], days: [] },
    competitors: [{ name, blended: summary(over), engines: [{ engineKey: "gemini", ...summary(over) }] }],
  };
  return renderCsv(buildExportDocument(input));
}

describe("STORY-110 68(e) — CSV leading minus", () => {
  it("a negative numeric metric stays numeric (no quote prefix)", () => {
    expect(csvFor("Rival", { sentimentScore: -0.3 })).toContain("competitors,,Rival,all,sentiment_score,-0.3,");
  });

  it.each(["-5", "-0.5", "-1e3", "-12.75"])("a numeric cell %s is not prefixed", (value) => {
    expect(csvFor(value)).toContain(`competitors,,${value},all,`);
  });

  it.each(["-cmd|' /C calc'!A0", "-1+2", "-", "--5", "-5 ", "-1,2", "-Infinity", "-NaN", "-0x10"])("a non-numeric cell %j keeps the quote prefix", (value) => {
    const csv = csvFor(value);
    expect(csv).not.toMatch(new RegExp(`,${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`));
    expect(csv).toContain(`'${value}`);
  });

  it("= + @ still get the prefix", () => {
    for (const v of ["=1+1", "+5", "@SUM(A1)"]) expect(csvFor(v)).toContain(`'${v}`);
  });
});
