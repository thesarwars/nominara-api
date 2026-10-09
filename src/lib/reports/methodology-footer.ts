import type { DataSource } from "../../../contracts/analytics/index.js";
import type { MethodologyFooter, ReportTimeframe } from "../../../contracts/reports/index.js";

// NEW-E-100a — NFR-AGY-05: the methodology footer has ONE implementation.
// The on-demand export and the portal overview import this; neither builds
// its own. Pure: no clock, no database. The service gathers the facts, this
// shapes them, and there is no input that omits a field or the note.

/** The methodology note — fixed copy about the method, not a measurement. */
export const METHODOLOGY_NOTE =
  "Visibility Scores are computed from captured engine answers using the scoring version shown. " +
  "Engines marked demo carry demonstration data, not live measurements. " +
  "Figures with a low sample size are indicative only.";

export interface FooterEngineInput {
  engineKey: string;
  /** null = nothing measured for this engine in the window. */
  dataSource: DataSource | null;
  sampleSize: number;
  /** null = unknown. 0 is a measured zero and stays 0. */
  liveCaptureRatio: number | null;
}

export interface MethodologyFooterInput {
  dataThrough: string | null;
  timeframe: ReportTimeframe;
  scoringVersion: string;
  weightOverrides: Readonly<Record<string, number>> | null;
  engines: readonly FooterEngineInput[];
}

/**
 * The live-capture ratio across engines is the sample-weighted mean. It is
 * NULL when no cell was sampled, or when any sampled engine's ratio is
 * unknown: a partial mean would present an unknown as a known figure.
 */
function blendedLiveCaptureRatio(engines: readonly FooterEngineInput[]): number | null {
  const sampled = engines.filter((engine) => engine.sampleSize > 0);
  if (sampled.length === 0) return null;
  let weighted = 0;
  let total = 0;
  for (const engine of sampled) {
    if (engine.liveCaptureRatio === null) return null;
    weighted += engine.sampleSize * engine.liveCaptureRatio;
    total += engine.sampleSize;
  }
  return Math.min(1, Math.max(0, weighted / total));
}

export function buildMethodologyFooter(input: MethodologyFooterInput): MethodologyFooter {
  const engines = [...input.engines].sort((a, b) => (a.engineKey < b.engineKey ? -1 : a.engineKey > b.engineKey ? 1 : 0));
  const overrides = input.weightOverrides;
  return {
    data_through: input.dataThrough,
    engines: engines.map((engine) => engine.engineKey),
    engine_data_sources: engines.map((engine) => ({ engine_key: engine.engineKey, data_source: engine.dataSource })),
    timeframe: input.timeframe,
    sample_size: engines.reduce((sum, engine) => sum + engine.sampleSize, 0),
    live_capture_ratio: blendedLiveCaptureRatio(engines),
    scoring_version: input.scoringVersion,
    weight_overrides: overrides !== null && Object.keys(overrides).length > 0 ? { ...overrides } : null,
    note: METHODOLOGY_NOTE,
  };
}
