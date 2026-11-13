import { describe, expect, it } from "vitest";
import { MEASURED_FLOOR_COPY, type AttributionRow, type AttributionTotals } from "../../../contracts/attribution/index.js";
import type { MethodologyFooter } from "../../../contracts/reports/index.js";
import { renderCsv } from "../../../src/lib/reports/export-csv.js";
import { ABSENT_SUMMARY, buildExportDocument, type ExportDocumentInput } from "../../../src/lib/reports/export-document.js";
import { renderPdf } from "../../../src/lib/reports/export-pdf.js";
import { METHODOLOGY_NOTE } from "../../../src/lib/reports/methodology-footer.js";
import { pdfText } from "../../support/pdf-text.js";

// STORY-116 AC13 / AC19 (PROVISIONAL, batch 13): the attribution section as an export section. The measured-floor caveat travels in
// EVERY rendering of it, set by the builder from the shared constant (never from the caller), beside the methodology footer.

const footer: MethodologyFooter = {
  data_through: "2026-10-05", engines: ["gemini"], engine_data_sources: [{ engine_key: "gemini", data_source: "live" }], timeframe: "30d",
  sample_size: 40, live_capture_ratio: 1, scoring_version: "v1", weight_overrides: null, note: METHODOLOGY_NOTE,
};
const fig = (current: number | null, prior: number | null = null) => ({ current, prior, delta: current !== null && prior !== null ? current - prior : null, delta_pct: null });
const totals: AttributionTotals = {
  measured_from: "2026-09-01", measured_to: "2026-10-05",
  ai_sessions: fig(120, 100), conversions: fig(6, 5), conversion_rate: 0.05, conversion_rate_prior: 0.05,
  by_engine: [{ referrer_class: "chatgpt", sessions: fig(100, 80), conversions: fig(5, 4) }, { referrer_class: "gemini", sessions: fig(0, 0), conversions: fig(0, 0) }],
  unattributed: { sessions: fig(900, 700), conversions: fig(20, 10) },
};
const row = (over: Partial<AttributionRow> = {}): AttributionRow => ({
  url: "https://acme.test/pricing", citations: 4, citations_prior: 2, ai_sessions: 0, ai_sessions_prior: 3, conversions: 0, conversion_rate: null,
  gsc_ai_impressions: null, organic_clicks: null, pattern: "ai_substitution_candidate", flagged: true, note: "Citations rose while sessions fell.", ...over,
});
const palette = { primary: "#4f46e5", accent: "#0ea5e9", background: "#ffffff", foreground: "#0f172a", showBrandLine: true };

function input(over: Partial<ExportDocumentInput> = {}): ExportDocumentInput {
  return {
    projectName: "Acme", generatedAt: "2026-10-07T10:00:00.000Z", timeframe: "30d", window: { from: "2026-09-06", to: "2026-10-05" }, palette, footer,
    sections: ["attribution"], hideCompetitors: false, hideCosts: false,
    overview: { blended: ABSENT_SUMMARY, engines: [] }, growthMap: { engineKeys: [], days: [] }, competitors: [],
    attribution: { windowDays: 30, windowStart: "2026-09-06", totals, rows: [row()] },
    ...over,
  };
}
const both = async (doc: ReturnType<typeof buildExportDocument>) => ({ csv: renderCsv(doc), text: pdfText(await renderPdf(doc, { compress: false })) });

describe("STORY-116 AC19 · the attribution export section", () => {
  it("scenario 20 - the section is composable (not listed as unavailable) and ordered after the others", () => {
    const doc = buildExportDocument(input({ sections: ["attribution", "overview"] }));
    expect(doc.unavailableSections).toEqual([]);
    expect(doc.sections.map((s) => s.kind)).toEqual(["overview", "attribution"]);
  });

  it("AC13 - the caveat is in the CSV and the PDF, beside the methodology footer", async () => {
    const { csv, text } = await both(buildExportDocument(input()));
    expect(csv).toContain("attribution,,,,measured_floor_note,");
    expect(csv).toContain(MEASURED_FLOOR_COPY);
    expect(text).toContain("measured counts and a floor");
    expect(csv).toContain("methodology,,,,note,");
    expect(text).toContain(METHODOLOGY_NOTE);
  });

  it("AC13 - the caveat is set by the builder: a caller cannot supply a different one, and none is omitted for an empty section", async () => {
    const doc = buildExportDocument(input({ attribution: { windowDays: 30, windowStart: null, totals: null, rows: [], measuredFloorNote: "all good" } as never }));
    const section = doc.sections.find((s) => s.kind === "attribution");
    expect(section).toMatchObject({ measuredFloorNote: MEASURED_FLOOR_COPY });
    const { csv } = await both(doc);
    expect(csv).toContain(MEASURED_FLOOR_COPY);
    expect(csv).not.toContain("all good");
  });

  it("the caveat survives brand removal and a missing attribution input", async () => {
    const doc = buildExportDocument(input({ attribution: undefined, palette: { ...palette, showBrandLine: false } }));
    const { csv, text } = await both(doc);
    expect(csv).toContain(MEASURED_FLOOR_COPY);
    expect(text).toContain("measured counts and a floor");
  });

  it("scenario 6 - the unattributed class is a separate line, never added into the AI total", () => {
    const csv = renderCsv(buildExportDocument(input()));
    expect(csv).toContain("attribution,,project,all,ai_sessions,120,");
    expect(csv).toContain("attribution,,project,unattributed,sessions,900,");
    expect(csv).not.toContain(",1020,");
  });

  it("scenario 13 - zero sessions never renders as a zero rate: an absent rate is an empty cell; a measured zero stays 0", () => {
    const csv = renderCsv(buildExportDocument(input()));
    expect(csv).toContain("attribution,,https://acme.test/pricing,all,conversion_rate,,");
    expect(csv).toContain("attribution,,project,gemini,ai_sessions,0,");
  });

  it("a null total (no beacon data) is an empty cell, not 0", () => {
    const empty = { ...totals, ai_sessions: fig(null), conversions: fig(null), conversion_rate: null, conversion_rate_prior: null };
    const csv = renderCsv(buildExportDocument(input({ attribution: { windowDays: 30, windowStart: "2026-09-06", totals: empty, rows: [] } })));
    expect(csv).toContain("attribution,,project,all,ai_sessions,,");
  });

  it("scenario 10 - a substitution candidate is flagged in the export with its co-movement note", async () => {
    const { csv, text } = await both(buildExportDocument(input()));
    expect(csv).toContain("attribution,,https://acme.test/pricing,all,pattern,ai_substitution_candidate,");
    expect(text).toContain("ai_substitution_candidate");
  });

  it("a hostile URL is defanged in the CSV (formula injection)", () => {
    const csv = renderCsv(buildExportDocument(input({ attribution: { windowDays: 30, windowStart: "2026-09-06", totals, rows: [row({ url: "=HYPERLINK(\"x\")" })] } })));
    expect(csv).not.toMatch(/^attribution,,=/m);
  });

  it("the PDF names the window and says it is a floor, with no extrapolated total", async () => {
    const { text } = await both(buildExportDocument(input()));
    expect(text).toMatch(/30 days/);
    expect(text).not.toMatch(/estimated total|projected/i);
  });
});
