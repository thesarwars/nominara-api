import type { ClientBase } from "pg";
import type { BlendDisclosure, DataSource } from "../../../contracts/analytics/index.js";
import { DEMO_SEED_MARKER } from "../../db/seed/demo/constants.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { measurementStatusSql } from "../rollup/aggregate-day.js";

// NEW-A-5 — whether the measured captures behind a figure are real or
// demo-seeded.
//
// THE MARKER IS `answer_captures.normalizer_version = DEMO_SEED_MARKER`
// (STORY-169), the one provenance field the seed stamps on every capture it
// writes. A capture is "demo" iff it carries that marker; everything else is
// "live". Only captures that count as a MEASUREMENT (`measurementStatusSql`,
// the aggregation's own rule) contribute: a failed or blocked capture is not
// data, so it can make an engine neither live nor demo.
//
// NULL IS "NOTHING WAS MEASURED" and is never folded into "demo".

/** live/demo counts -> a marker. Null when there is nothing to describe. */
export function dataSourceOf(live: number, demo: number): DataSource | null {
  if (live > 0 && demo > 0) return "mixed";
  if (demo > 0) return "demo";
  if (live > 0) return "live";
  return null;
}

/** Combine per-engine markers into one. Nulls are absent, not demo. */
export function combineDataSources(sources: readonly (DataSource | null)[]): DataSource | null {
  const present = sources.filter((source): source is DataSource => source !== null);
  if (present.length === 0) return null;
  if (present.every((source) => source === "live")) return "live";
  if (present.every((source) => source === "demo")) return "demo";
  return "mixed";
}

/**
 * The disclosure that travels with a blended figure. The policy is STATED:
 * every measured engine is in the blend, demo ones included, and the counts
 * say how many. Engines with nothing measured are in no bucket.
 */
export function blendDisclosure(sources: readonly (DataSource | null)[]): BlendDisclosure {
  const count = (wanted: DataSource): number => sources.filter((source) => source === wanted).length;
  return {
    policy: "all_measured_engines",
    live_engines: count("live"),
    demo_engines: count("demo"),
    mixed_engines: count("mixed"),
  };
}

interface CountRow {
  engine_key: string;
  live: string;
  demo: string;
}

function toMap(rows: readonly CountRow[]): Map<string, DataSource> {
  const result = new Map<string, DataSource>();
  for (const row of rows) {
    const source = dataSourceOf(Number(row.live), Number(row.demo));
    if (source !== null) result.set(row.engine_key, source);
  }
  return result;
}

/**
 * Per-engine provenance over a workspace-local DATE range — the same
 * `(captured_at AT TIME ZONE tz)::date BETWEEN from AND to` boundary
 * `aggregateRange` uses, so the marker describes exactly the captures the
 * figure was computed from. Runs on the caller's tenant transaction.
 */
export async function engineDataSourcesForDates(
  tx: ClientBase,
  projectId: string,
  from: string,
  to: string,
  timezone: string,
): Promise<Map<string, DataSource>> {
  const result = await tx.query<CountRow>(
    `SELECT c.engine_key,
            count(*) FILTER (WHERE c.normalizer_version <> $5)::text AS live,
            count(*) FILTER (WHERE c.normalizer_version = $5)::text  AS demo
       FROM answer_captures c
      WHERE c.project_id = $1
        AND ${measurementStatusSql()}
        AND (c.captured_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
      GROUP BY c.engine_key`,
    [projectId, from, to, timezone, DEMO_SEED_MARKER],
  );
  return toMap(result.rows);
}

/** Per-engine provenance over a trailing window of whole days — the matrix's window. */
export async function engineDataSourcesForDays(
  tx: ClientBase,
  projectId: string,
  days: number,
): Promise<Map<string, DataSource>> {
  const result = await tx.query<CountRow>(
    `SELECT c.engine_key,
            count(*) FILTER (WHERE c.normalizer_version <> $3)::text AS live,
            count(*) FILTER (WHERE c.normalizer_version = $3)::text  AS demo
       FROM answer_captures c
      WHERE c.project_id = $1
        AND ${measurementStatusSql()}
        AND c.captured_at >= now() - make_interval(days => $2::int)
      GROUP BY c.engine_key`,
    [projectId, days, DEMO_SEED_MARKER],
  );
  return toMap(result.rows);
}

/**
 * Observability: counts every read that serves figures backed (wholly or in
 * part) by demo data, per surface. The log line carries the workspace ID only
 * — no name, no engine text. Silent when nothing demo was served, so the
 * counter is a rate of demo exposure rather than of traffic.
 */
export function recordDemoDataServed(
  surface: "matrix" | "scorecards" | "growth_map" | "rendering_quality",
  workspaceId: string,
  sources: readonly (DataSource | null)[],
): void {
  if (!sources.some((source) => source === "demo" || source === "mixed")) return;
  incrementCounter("nominara_analytics_demo_data_served_total", { surface, workspace_id: workspaceId });
}
