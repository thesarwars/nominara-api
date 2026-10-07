import { afterEach, describe, expect, it, vi } from "vitest";
import type { MethodologyFooter } from "../../../contracts/reports/index.js";
import { METHODOLOGY_NOTE } from "../../../src/lib/reports/methodology-footer.js";
import {
  ABSENT_SUMMARY,
  buildExportDocument,
  type ExportDocumentInput,
  type MetricSummary,
} from "../../../src/lib/reports/export-document.js";
import { renderCsv } from "../../../src/lib/reports/export-csv.js";
import { renderPdf } from "../../../src/lib/reports/export-pdf.js";
import { pdfRaw, pdfText } from "../../support/pdf-text.js";

// NEW-E-100b — STORY-100 scenarios 1-6 against the pure document model and
// the two renderers. Scenarios 8, 9 and 18 (metering, refusals, scope) need the
// guard chain and live in test/integration/report-export-http.spec.ts.

const footer: MethodologyFooter = {
  data_through: "2026-10-05",
  engines: ["chatgpt", "gemini"],
  engine_data_sources: [
    { engine_key: "chatgpt", data_source: "demo" },
    { engine_key: "gemini", data_source: "live" },
  ],
  timeframe: "30d",
  sample_size: 140,
  live_capture_ratio: 0.75,
  scoring_version: "v1",
  weight_overrides: { presence: 0.5 },
  note: METHODOLOGY_NOTE,
};

const summary = (over: Partial<MetricSummary> = {}): MetricSummary => ({
  visibilityScore: 61.5,
  presenceRate: 0.5,
  shareOfVoice: 0.25,
  sentimentScore: 70,
  citationShare: 0.1,
  measuredCells: 130,
  confidence: "high",
  dataSource: "live",
  ...over,
});

const theme = { colorPrimary: "#4f46e5", colorAccent: "#0ea5e9", colorBg: "#ffffff", colorFg: "#0f172a", fontFamily: "Inter", hideNominaraBrand: false };

function input(over: Partial<ExportDocumentInput> = {}): ExportDocumentInput {
  return {
    projectName: "Acme Roofing",
    generatedAt: "2026-10-07T10:00:00.000Z",
    timeframe: "30d",
    window: { from: "2026-09-08", to: "2026-10-07" },
    theme,
    footer,
    sections: ["overview", "growth_map", "competitors"],
    hideCompetitors: false,
    hideCosts: false,
    overview: { blended: summary(), engines: [{ engineKey: "gemini", ...summary({ visibilityScore: 70 }) }, { engineKey: "chatgpt", ...summary({ visibilityScore: 50, dataSource: "demo" }) }] },
    growthMap: {
      engineKeys: ["chatgpt", "gemini"],
      days: [{ date: "2026-10-06", blended: 60, byEngine: { chatgpt: 50, gemini: 70 } }],
    },
    competitors: [
      { name: "Rival Co", blended: summary({ visibilityScore: 40 }), engines: [{ engineKey: "gemini", ...summary({ visibilityScore: 42 }) }] },
    ],
    ...over,
  };
}

const FOOTER_CSV_FIELDS = ["data_through", "engines", "timeframe", "sample_size", "live_capture_ratio", "scoring_version", "weight_overrides", "note"];

async function everyFormat(doc: ReturnType<typeof buildExportDocument>) {
  const csv = renderCsv(doc);
  const pdf = await renderPdf(doc, { compress: false });
  return { csv, pdf, pdfText: pdfText(pdf) };
}

afterEach(() => vi.restoreAllMocks());

describe("NEW-E-100b · STORY-100 s1 — every format carries the footer", () => {
  it("STORY-100 s1 — CSV carries every documented footer field and the note", () => {
    const csv = renderCsv(buildExportDocument(input()));
    for (const field of FOOTER_CSV_FIELDS) expect(csv).toContain(`methodology,,,,${field},`);
    expect(csv).toContain(METHODOLOGY_NOTE);
    expect(csv).toContain("2026-10-05");
    expect(csv).toContain("v1");
  });

  it("STORY-100 s1 — PDF shows the data-through date, engines, timeframe, sample size, live-capture ratio, scoring version, overrides and the note", async () => {
    const { pdf, pdfText: text } = await everyFormat(buildExportDocument(input()));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(text).toContain(METHODOLOGY_NOTE);
    for (const needle of ["2026-10-05", "chatgpt", "gemini", "30d", "140", "75%", "v1", "presence"]) expect(text).toContain(needle);
  });

  it("STORY-100 s1 — the PDF information dictionary also carries the note (the artifact describes itself)", async () => {
    const pdf = await renderPdf(buildExportDocument(input()), { compress: false });
    expect(pdfRaw(pdf)).toContain(METHODOLOGY_NOTE);
  });

  it("STORY-100 s1 — a null footer figure is rendered absent, never as 0", async () => {
    const empty: MethodologyFooter = { ...footer, data_through: null, live_capture_ratio: null, sample_size: 0, engines: [], engine_data_sources: [], weight_overrides: null };
    const doc = buildExportDocument(input({ footer: empty }));
    const csv = renderCsv(doc);
    expect(csv).toContain("methodology,,,,live_capture_ratio,,");
    expect(csv).toContain("methodology,,,,data_through,,");
    expect(pdfText(await renderPdf(doc, { compress: false }))).toMatch(/live capture ratio:? —/i);
  });
});

describe("NEW-E-100b · STORY-100 s2 — brand removal does not remove the footer", () => {
  it("STORY-100 s2 — hide_nominara_brand drops the brand line and keeps the footer in both formats", async () => {
    const shown = await everyFormat(buildExportDocument(input()));
    const hidden = await everyFormat(buildExportDocument(input({ theme: { ...theme, hideNominaraBrand: true } })));
    expect(shown.pdfText).toContain("Powered by Nominara");
    expect(hidden.pdfText).not.toContain("Powered by Nominara");
    expect(hidden.pdfText).toContain(METHODOLOGY_NOTE);
    expect(hidden.csv).toContain(METHODOLOGY_NOTE);
  });
});

describe("NEW-E-100b · STORY-100 s3 — the footer cannot be suppressed", () => {
  it("STORY-100 s3 — no section selection removes it, including selecting nothing renderable", async () => {
    for (const sections of [["overview"], ["growth_map"], ["competitors"], ["tasks"], ["aux", "sources"], ["matrix"]] as const) {
      const doc = buildExportDocument(input({ sections: [...sections] }));
      expect(doc.footer).toEqual(footer);
      const { csv, pdfText: text } = await everyFormat(doc);
      expect(csv).toContain(METHODOLOGY_NOTE);
      expect(text).toContain(METHODOLOGY_NOTE);
    }
  });

  it("STORY-100 s3 — no theme key, style override or stray flag removes it", async () => {
    const hostile = {
      ...theme,
      hideNominaraBrand: true,
      hideFooter: true,
      footer: false,
      customCss: ".footer { display: none }",
      styleOverride: { footer: "none" },
    } as unknown as ExportDocumentInput["theme"];
    const doc = buildExportDocument({ ...input({ theme: hostile }), hideFooter: true, footerOverride: null } as unknown as ExportDocumentInput);
    expect(doc.footer).toEqual(footer);
    const { csv, pdfText: text } = await everyFormat(doc);
    expect(csv).toContain(METHODOLOGY_NOTE);
    expect(text).toContain(METHODOLOGY_NOTE);
  });

  it("STORY-100 s3 — the document's footer is a copy: mutating the input after the build cannot change it", () => {
    const source = input();
    const doc = buildExportDocument(source);
    source.footer.note = "";
    expect(doc.footer.note).toBe(METHODOLOGY_NOTE);
  });
});

describe("NEW-E-100b · STORY-100 s5 — per-engine scores wherever the blend appears", () => {
  it("STORY-100 s5 — overview carries every engine row beside the blended row, in CSV and PDF", async () => {
    const { csv, pdfText: text } = await everyFormat(buildExportDocument(input({ sections: ["overview"] })));
    const rows = csv.split("\n").filter((line) => line.startsWith("overview,"));
    expect(rows.some((r) => r.includes(",all,visibility_score,61.5"))).toBe(true);
    expect(rows.some((r) => r.includes(",gemini,visibility_score,70"))).toBe(true);
    expect(rows.some((r) => r.includes(",chatgpt,visibility_score,50"))).toBe(true);
    expect(text).toContain("gemini");
    expect(text).toContain("chatgpt");
  });

  it("STORY-100 s5 — a blend with no engine beside it is not exported: it is replaced by the absent summary", () => {
    const doc = buildExportDocument(input({ sections: ["overview", "competitors"], overview: { blended: summary(), engines: [] }, competitors: [{ name: "Rival", blended: summary(), engines: [] }] }));
    const overview = doc.sections.find((s) => s.kind === "overview");
    expect(overview).toMatchObject({ blended: ABSENT_SUMMARY, engines: [] });
    const competitors = doc.sections.find((s) => s.kind === "competitors");
    expect(competitors).toMatchObject({ competitors: [{ name: "Rival", blended: ABSENT_SUMMARY }] });
    expect(renderCsv(doc)).not.toContain("61.5");
  });

  it("STORY-100 s5 — the growth-map series carries a column per engine beside the blended value", async () => {
    const { csv } = await everyFormat(buildExportDocument(input({ sections: ["growth_map"] })));
    const day = csv.split("\n").filter((line) => line.startsWith("growth_map,2026-10-06"));
    expect(day.map((r) => r.split(",")[3]).sort()).toEqual(["all", "chatgpt", "gemini"]);
  });

  it("STORY-100 s5 — a growth-map day whose blend exists with no engine value is not exported as a lone blend", () => {
    const doc = buildExportDocument(input({ sections: ["growth_map"], growthMap: { engineKeys: [], days: [{ date: "2026-10-06", blended: 60, byEngine: {} }] } }));
    expect(doc.sections.find((s) => s.kind === "growth_map")).toMatchObject({ days: [{ date: "2026-10-06", blended: null }] });
  });
});

describe("NEW-E-100b · STORY-100 s6 — absence and confidence are preserved", () => {
  const sparse = summary({ visibilityScore: null, presenceRate: null, shareOfVoice: null, sentimentScore: null, citationShare: null, measuredCells: 0, confidence: null, dataSource: null });

  it("STORY-100 s6 — a null metric is an empty CSV cell and an em dash in the PDF, never 0", async () => {
    const doc = buildExportDocument(input({ sections: ["overview"], overview: { blended: sparse, engines: [{ engineKey: "gemini", ...sparse }] } }));
    const { csv, pdfText: text } = await everyFormat(doc);
    for (const line of csv.split("\n").filter((l) => l.startsWith("overview,"))) {
      expect(line).toMatch(/,(visibility_score|presence_rate|share_of_voice|sentiment_score|citation_share),,/);
    }
    expect(text).toContain("—");
  });

  it("STORY-100 s6 — a measured zero stays 0, distinct from absent", () => {
    const zero = summary({ presenceRate: 0, citationShare: 0, measuredCells: 40, confidence: "medium" });
    const csv = renderCsv(buildExportDocument(input({ sections: ["overview"], overview: { blended: zero, engines: [{ engineKey: "gemini", ...zero }] } })));
    expect(csv).toContain("overview,,brand,gemini,presence_rate,0,");
    expect(csv).toContain("overview,,brand,gemini,citation_share,0,");
  });

  it("STORY-100 s6 — a low-confidence figure is labelled low in both formats", async () => {
    const low = summary({ measuredCells: 12, confidence: "low" });
    const doc = buildExportDocument(input({ sections: ["overview"], overview: { blended: low, engines: [{ engineKey: "gemini", ...low }] } }));
    const { csv, pdfText: text } = await everyFormat(doc);
    expect(csv).toMatch(/overview,,brand,gemini,visibility_score,61\.5,low,12,live/);
    expect(text).toContain("low confidence");
  });

  it("STORY-100 s6 — a high-confidence figure carries no low-confidence label", async () => {
    const { pdfText: text } = await everyFormat(buildExportDocument(input({ sections: ["overview"] })));
    expect(text).not.toContain("low confidence");
  });

  it("STORY-100 s6 — the data-source marker travels with each figure (demo is marked demo)", () => {
    const csv = renderCsv(buildExportDocument(input({ sections: ["overview"] })));
    expect(csv).toMatch(/overview,,brand,chatgpt,visibility_score,50,high,130,demo/);
  });
});

describe("NEW-E-100b · selection, privacy and rendering hygiene", () => {
  it("NEW-E-100b — sections come out in the canonical order and once, whatever the request order", () => {
    const doc = buildExportDocument(input({ sections: ["competitors", "overview", "overview", "growth_map"] }));
    expect(doc.sections.map((s) => s.kind)).toEqual(["overview", "growth_map", "competitors"]);
  });

  it("NEW-E-100b — hide_competitors leaves the competitors section out entirely", async () => {
    const doc = buildExportDocument(input({ hideCompetitors: true }));
    expect(doc.sections.some((s) => s.kind === "competitors")).toBe(false);
    expect(renderCsv(doc)).not.toContain("Rival Co");
    expect((await everyFormat(doc)).pdfText).not.toContain("Rival Co");
  });

  it("NEW-E-100b — a section this export cannot compose is named as unavailable, not silently dropped", async () => {
    const doc = buildExportDocument(input({ sections: ["overview", "tasks", "aux"] }));
    expect(doc.unavailableSections).toEqual(["tasks", "aux"]);
    expect(renderCsv(doc)).toMatch(/unavailable,,,,tasks,/);
    expect((await everyFormat(doc)).pdfText).toMatch(/tasks.*not available/i);
  });

  it("NEW-E-100b — CSV cells starting with a formula character are neutralised, and commas, quotes and newlines are quoted", () => {
    const evil = '=HYPERLINK("http://x","y")';
    const csv = renderCsv(buildExportDocument(input({ sections: ["competitors"], competitors: [{ name: evil, blended: summary(), engines: [{ engineKey: "gemini", ...summary() }] }, { name: 'A, "B"\nC', blended: summary(), engines: [{ engineKey: "gemini", ...summary() }] }] })));
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csv).toContain(`"A, ""B""\nC"`);
  });

  it("NEW-E-100b — the PDF uses the stored theme's colours", async () => {
    const pdf = await renderPdf(buildExportDocument(input({ theme: { ...theme, colorPrimary: "#00ff00" } })), { compress: false });
    expect(pdfRaw(pdf)).toMatch(/\b0 1 0 (rg|RG)\b/);
  });

  it("NEW-E-100b — rendering performs no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network call during render"));
    const pdf = await renderPdf(buildExportDocument(input()));
    expect(pdf.length).toBeGreaterThan(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("NEW-E-100b — rendering uses only a built-in font (no font file is fetched or embedded)", async () => {
    const pdf = await renderPdf(buildExportDocument(input()), { compress: false });
    expect(pdfRaw(pdf)).not.toMatch(/FontFile/);
    expect(pdfRaw(pdf)).toMatch(/\/BaseFont \/Helvetica/);
  });

  it("NEW-E-100b — a many-day growth map paginates without losing the footer on any page", async () => {
    const days = Array.from({ length: 90 }, (_, i) => ({ date: `2026-07-${String((i % 28) + 1).padStart(2, "0")}`, blended: 50, byEngine: { chatgpt: 50, gemini: 50 } }));
    const pdf = await renderPdf(buildExportDocument(input({ sections: ["growth_map"], growthMap: { engineKeys: ["chatgpt", "gemini"], days } })), { compress: false });
    const pages = pdfRaw(pdf).match(/\/Type \/Page\n/g)?.length ?? 0;
    expect(pages).toBeGreaterThan(1);
    expect((pdfText(pdf).match(/Methodology/g) ?? []).length).toBeGreaterThanOrEqual(pages);
  });
});
