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

function cell(value: string): string {
  const needsQuote = FORMULA_START.test(value) && !NEGATIVE_NUMBER.test(value);
  const safe = needsQuote ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function num(value: number | null): string {
  return value === null ? "" : String(Number(value.toFixed(4)));
}

function row(fields: readonly string[]): string {
  return fields.map(cell).join(",");
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
        lines.push(row(["growth_map", day.date, "brand", "all", "visibility_score", num(day.blended), "", "", ""]));
        for (const key of section.engineKeys) {
          lines.push(row(["growth_map", day.date, "brand", key, "visibility_score", num(day.byEngine[key] ?? null), "", "", ""]));
        }
      }
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
