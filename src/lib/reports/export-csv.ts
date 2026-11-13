import { confidenceFor } from "../scoring/index.js";
import type { ExportDocument, MetricSummary } from "./export-document.js";

// NEW-E-100b — the CSV rendering of an ExportDocument.
//
// LONG FORM, one figure per row:
//   section,period,entity,engine_key,metric,value,confidence,measured_cells,data_source
// The methodology footer is the FIRST block of rows (section = `methodology`),
// so a file truncated from the bottom still carries it, and it is rows rather
// than a comment so a spreadsheet import cannot strip it as noise.
//
// A null figure is an EMPTY value cell; 0 is "0". `engine_key` = `all` is the
// blend, and it is only ever written beside the per-engine rows (the document
// model guarantees that).

const HEADER = ["section", "period", "entity", "engine_key", "metric", "value", "confidence", "measured_cells", "data_source"] as const;

/** Formula characters a spreadsheet would execute at the start of a cell (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** A plain decimal number with a leading minus; anything else starting `-` can still be read as a formula. */
const NEGATIVE_NUMBER = /^-(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** One CSV field, quoted when it needs it and defanged when a spreadsheet would run it as a formula. Shared by the full-data export (STORY-185). */
export function csvCell(value: string): string {
  const needsQuote = FORMULA_START.test(value) && !NEGATIVE_NUMBER.test(value);
  const safe = needsQuote ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function num(value: number | null): string {
  return value === null ? "" : String(Number(value.toFixed(4)));
}

function row(fields: readonly string[]): string {
  return fields.map(csvCell).join(",");
}

const METRICS: ReadonlyArray<readonly [string, (summary: MetricSummary) => number | null]> = [
  ["visibility_score", (s) => s.visibilityScore],
  ["presence_rate", (s) => s.presenceRate],
  ["share_of_voice", (s) => s.shareOfVoice],
  ["sentiment_score", (s) => s.sentimentScore],
  ["citation_share", (s) => s.citationShare],
];

function summaryRows(section: string, entity: string, engineKey: string, summary: MetricSummary): string[] {
  return METRICS.map(([metric, read]) =>
    row([section, "", entity, engineKey, metric, num(read(summary)), summary.confidence ?? "", String(summary.measuredCells), summary.dataSource ?? ""]),
  );
}

type AttributionSection = Extract<ExportDocument["sections"][number], { kind: "attribution" }>;

/** STORY-116: the caveat is the section's first row; a null figure is an empty cell (never 0), and the unattributed class is its own line, never summed in. */
function attributionRows(section: AttributionSection): string[] {
  const line = (entity: string, engineKey: string, metric: string, value: string): string => row(["attribution", "", entity, engineKey, metric, value, "", "", ""]);
  const out = [line("", "", "measured_floor_note", section.measuredFloorNote), line("", "", "window_days", section.windowDays === null ? "" : String(section.windowDays))];
  const totals = section.totals;
  if (totals !== null) {
    out.push(line("", "", "measured_from", totals.measured_from ?? ""), line("", "", "measured_to", totals.measured_to ?? ""));
    out.push(
      line("project", "all", "ai_sessions", num(totals.ai_sessions.current)),
      line("project", "all", "ai_sessions_prior", num(totals.ai_sessions.prior)),
      line("project", "all", "conversions", num(totals.conversions.current)),
      line("project", "all", "conversions_prior", num(totals.conversions.prior)),
      line("project", "all", "conversion_rate", num(totals.conversion_rate)),
      line("project", "all", "conversion_rate_prior", num(totals.conversion_rate_prior)),
    );
    for (const engine of totals.by_engine) {
      out.push(line("project", engine.referrer_class, "ai_sessions", num(engine.sessions.current)), line("project", engine.referrer_class, "conversions", num(engine.conversions.current)));
    }
    out.push(line("project", "unattributed", "sessions", num(totals.unattributed.sessions.current)), line("project", "unattributed", "conversions", num(totals.unattributed.conversions.current)));
  }
  for (const r of section.rows) {
    out.push(
      line(r.url, "all", "citations", String(r.citations)),
      line(r.url, "all", "ai_sessions", String(r.ai_sessions)),
      line(r.url, "all", "conversions", String(r.conversions)),
      line(r.url, "all", "conversion_rate", num(r.conversion_rate)),
      line(r.url, "all", "gsc_ai_impressions", r.gsc_ai_impressions === null ? "" : String(r.gsc_ai_impressions)),
      line(r.url, "all", "pattern", r.pattern),
    );
  }
  return out;
}

export function renderCsv(doc: ExportDocument): string {
  const footer = doc.footer;
  const meta = (metric: string, value: string): string => row(["methodology", "", "", "", metric, value, "", "", ""]);
  const lines: string[] = [HEADER.join(",")];

  lines.push(
    meta("data_through", footer.data_through ?? ""),
    meta("engines", footer.engines.join(" ")),
    meta("timeframe", footer.timeframe),
    meta("sample_size", String(footer.sample_size)),
    meta("live_capture_ratio", footer.live_capture_ratio === null ? "" : num(footer.live_capture_ratio)),
    meta("scoring_version", footer.scoring_version),
    meta("weight_overrides", footer.weight_overrides === null ? "" : JSON.stringify(footer.weight_overrides)),
    meta("note", footer.note),
    // STORY-100 (PROVISIONAL): a partial export says so. Drawn here, never stored, so the footer contract is unchanged.
    meta("export_status", doc.unavailableSections.length === 0 ? "complete" : "partial"),
    ...(doc.unavailableSections.length === 0 ? [] : [meta("unavailable_sections", doc.unavailableSections.join(" "))]),
  );
  for (const source of footer.engine_data_sources) {
    lines.push(row(["methodology", "", "", source.engine_key, "engine_data_source", source.data_source ?? "", "", "", ""]));
  }
  lines.push(meta("project", doc.projectName), meta("window", `${doc.window.from}..${doc.window.to}`), meta("generated_at", doc.generatedAt));

  for (const section of doc.sections) {
    if (section.kind === "overview") {
      lines.push(...summaryRows("overview", "brand", "all", section.blended));
      for (const engine of section.engines) lines.push(...summaryRows("overview", "brand", engine.engineKey, engine));
    } else if (section.kind === "growth_map") {
      for (const day of section.days) {
        const figure = (engineKey: string, value: number | null, cells: number | undefined): string =>
          row(["growth_map", day.date, "brand", engineKey, "visibility_score", num(value), value === null || cells === undefined ? "" : confidenceFor(cells), value === null || cells === undefined ? "" : String(cells), ""]);
        lines.push(figure("all", day.blended, day.cells?.blended));
        for (const key of section.engineKeys) lines.push(figure(key, day.byEngine[key] ?? null, day.cells?.byEngine[key]));
      }
    } else if (section.kind === "attribution") {
      lines.push(...attributionRows(section));
    } else {
      for (const competitor of section.competitors) {
        lines.push(...summaryRows("competitors", competitor.name, "all", competitor.blended));
        for (const engine of competitor.engines) lines.push(...summaryRows("competitors", competitor.name, engine.engineKey, engine));
      }
    }
  }
  for (const name of doc.unavailableSections) {
    lines.push(row(["unavailable", "", "", "", name, "not available in this export", "", "", ""]));
  }
  return `${lines.join("\n")}\n`;
}
