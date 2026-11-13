import { MEASURED_FLOOR_COPY, type AttributionRow, type AttributionTotals } from "../../../contracts/attribution/index.js";
import type { DataSource } from "../../../contracts/analytics/index.js";
import type { ExportPalette } from "../theme/export-palette.js";
import type { MethodologyFooter, ReportSection, ReportTimeframe } from "../../../contracts/reports/index.js";

// NEW-E-100b — STORY-100: the ONE document model an export is rendered from.
// PDF and CSV are both renderings of this; neither reads the database or the
// request, so neither can behave differently on the rules below.
//
// THE FOOTER IS NOT A SECTION AND NOT A THEME FIELD (NFR-AGY-05). It is a
// required input copied into the document unconditionally. There is no
// parameter, flag or theme key through which a caller can omit it: the
// builder does not read one. Sections select content; the footer is not
// content, it is the artifact's provenance.
//
// HONESTY RULES (STORY-100 s5, s6), enforced here once so no renderer can break
// them:
//   - the blend never appears without the per-engine figures beside it;
//   - null stays null all the way to the renderer (an em dash / an empty cell),
//     and a measured 0 stays 0;
//   - `confidence` and `dataSource` travel with every figure.

export type Confidence = "low" | "medium" | "high";

/** One row of figures. Every metric is independently nullable: null = not measured, 0 = measured zero. */
export interface MetricSummary {
  visibilityScore: number | null;
  presenceRate: number | null;
  shareOfVoice: number | null;
  sentimentScore: number | null;
  citationShare: number | null;
  measuredCells: number;
  /** Null when nothing was measured. */
  confidence: Confidence | null;
  dataSource: DataSource | null;
}

export interface EngineSummary extends MetricSummary {
  engineKey: string;
}

/** Nothing measured. The only blend an export may print when no engine row sits beside it. */
export const ABSENT_SUMMARY: MetricSummary = Object.freeze({
  visibilityScore: null,
  presenceRate: null,
  shareOfVoice: null,
  sentimentScore: null,
  citationShare: null,
  measuredCells: 0,
  confidence: null,
  dataSource: null,
});

export interface GrowthMapDay {
  date: string;
  blended: number | null;
  byEngine: Record<string, number | null>;
  /**
   * STORY-100 (PROVISIONAL): the cells behind each figure, so a thin day carries the low-confidence treatment like the interface
   * does. Absent for a caller that does not know; an absent count yields NO confidence, never an invented one.
   */
  cells?: { blended: number; byEngine: Record<string, number> };
}

export interface CompetitorSummary {
  name: string;
  blended: MetricSummary;
  engines: EngineSummary[];
}

/**
 * STORY-116 (PROVISIONAL, batch 13): the attribution report's figures for the section. Only what the section draws; the caveat is NOT an
 * input - the builder sets it from the shared constant, so no caller can omit or reword it.
 */
export interface AttributionInput {
  windowDays: 7 | 30 | 90;
  windowStart: string | null;
  /** Null until a rollup window has been computed: the section then shows the caveat and no figures, never zeros. */
  totals: AttributionTotals | null;
  rows: readonly AttributionRow[];
}

export interface ExportDocumentInput {
  projectName: string;
  generatedAt: string;
  timeframe: ReportTimeframe;
  window: { from: string; to: string };
  palette: ExportPalette;
  footer: MethodologyFooter;
  sections: readonly ReportSection[];
  hideCompetitors: boolean;
  hideCosts: boolean;
  overview: { blended: MetricSummary; engines: EngineSummary[] };
  growthMap: { engineKeys: string[]; days: GrowthMapDay[] };
  competitors: CompetitorSummary[];
  /** Absent when the section was not requested (or the caller has none): the section, if requested, renders with no figures. */
  attribution?: AttributionInput | undefined;
}

export type DocumentSection =
  | { kind: "overview"; blended: MetricSummary; engines: EngineSummary[] }
  | { kind: "growth_map"; engineKeys: string[]; days: GrowthMapDay[] }
  | { kind: "competitors"; competitors: CompetitorSummary[] }
  | {
      kind: "attribution";
      windowDays: 7 | 30 | 90 | null;
      windowStart: string | null;
      totals: AttributionTotals | null;
      rows: AttributionRow[];
      /** STORY-116 AC13: always the shared constant, in every format, whatever the figures. */
      measuredFloorNote: string;
    };

export interface ExportDocument {
  projectName: string;
  generatedAt: string;
  timeframe: ReportTimeframe;
  window: { from: string; to: string };
  palette: ExportPalette;
  sections: DocumentSection[];
  /** Requested sections this export cannot compose yet. Named in the file, never silently dropped. */
  unavailableSections: ReportSection[];
  footer: MethodologyFooter;
}

const CANONICAL_ORDER: readonly ReportSection[] = ["overview", "growth_map", "matrix", "competitors", "sources", "tasks", "aux", "attribution"];
const COMPOSABLE: ReadonlySet<ReportSection> = new Set(["overview", "growth_map", "competitors", "attribution"]);

/** The blend beside no engine is not exported: it becomes the absent summary. */
function withEngines<T extends { blended: MetricSummary; engines: EngineSummary[] }>(entry: T): T {
  return entry.engines.length === 0 ? { ...entry, blended: ABSENT_SUMMARY } : entry;
}

export function buildExportDocument(input: ExportDocumentInput): ExportDocument {
  const requested = new Set(input.sections);
  const ordered = CANONICAL_ORDER.filter((section) => requested.has(section));
  const sections: DocumentSection[] = [];

  for (const section of ordered) {
    if (section === "overview") {
      sections.push({ kind: "overview", ...withEngines(input.overview) });
    } else if (section === "growth_map") {
      const hasEngines = input.growthMap.engineKeys.length > 0;
      sections.push({
        kind: "growth_map",
        engineKeys: [...input.growthMap.engineKeys],
        days: input.growthMap.days.map((day) => ({ ...day, blended: hasEngines ? day.blended : null, byEngine: { ...day.byEngine } })),
      });
    } else if (section === "competitors" && !input.hideCompetitors) {
      sections.push({ kind: "competitors", competitors: input.competitors.map(withEngines) });
    } else if (section === "attribution") {
      sections.push({
        kind: "attribution",
        windowDays: input.attribution?.windowDays ?? null,
        windowStart: input.attribution?.windowStart ?? null,
        totals: input.attribution?.totals ?? null,
        rows: [...(input.attribution?.rows ?? [])],
        measuredFloorNote: MEASURED_FLOOR_COPY,
      });
    }
  }

  return {
    projectName: input.projectName,
    generatedAt: input.generatedAt,
    timeframe: input.timeframe,
    window: { ...input.window },
    palette: { ...input.palette },
    sections,
    unavailableSections: ordered.filter((section) => !COMPOSABLE.has(section)),
    // A copy: a later mutation of the caller's object cannot alter the artifact.
    footer: structuredClone(input.footer),
  };
}
