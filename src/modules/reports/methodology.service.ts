import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import type { MethodologyFooter, MethodologyQuery, ReportTimeframe } from "../../../contracts/reports/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { engineDataSourcesForDates } from "../../lib/analytics/data-source.js";
import { CROSS_ENGINE_KEY } from "../../lib/rollup/roll-up-day.js";
import { buildMethodologyFooter } from "../../lib/reports/methodology-footer.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// NEW-E-100a — `GET /v1/projects/{id}/reports/methodology?timeframe=`.
//
// The figures (sample size, ratio, engines, data-through) come from
// `metric_daily` only. The one other read is the per-engine live/demo marker,
// which no rollup column carries: it is the same provenance helper the matrix
// and scorecards use, so the footer cannot disagree with the numbers it sits
// under.

const TIMEFRAME_DAYS: Readonly<Record<ReportTimeframe, number>> = Object.freeze({ "24h": 1, "7d": 7, "30d": 30, "90d": 90 });

const weightOverridesSchema = z.record(z.string(), z.number());
const logger = new Logger("MethodologyService");

interface EngineRow {
  engine_key: string;
  sample_size: string;
  live_capture_ratio: number | null;
}

@Injectable()
export class MethodologyService {
  async footer(projectId: string, query: MethodologyQuery): Promise<MethodologyFooter> {
    const started = Date.now();
    const store = currentTenantStore();
    if (store === undefined) throw new Error("MethodologyService requires an active tenant context");
    const tx = store.client;

    // RLS hides another workspace's project (the workspace filter is for the
    // planner, not for correctness): it is indistinguishable from one that does
    // not exist, and both are a 404.
    const project = await tx.query<{ timezone: string; scoring_version: string; entitlement_overrides: unknown }>(
      `SELECT w.timezone, w.scoring_version, w.entitlement_overrides
         FROM projects p JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.id = $1 AND p.workspace_id = $2 AND p.deleted_at IS NULL`,
      [projectId, store.context.workspaceId],
    );
    const settings = project.rows[0];
    if (settings === undefined) throw new NotFoundError({ message: "no such project" });

    const window = await tx.query<{ from: string; to: string }>(
      `SELECT to_char(today - make_interval(days => $1::int - 1), 'YYYY-MM-DD') AS from,
              to_char(today, 'YYYY-MM-DD')                                      AS to
         FROM (SELECT (now() AT TIME ZONE $2)::date AS today) t`,
      [TIMEFRAME_DAYS[query.timeframe], settings.timezone],
    );
    const { from, to } = window.rows[0]!;

    const through = await tx.query<{ data_through: string | null }>(
      `SELECT to_char(max(metric_date), 'YYYY-MM-DD') AS data_through
         FROM metric_daily WHERE project_id = $1 AND scoring_version = $2`,
      [projectId, settings.scoring_version],
    );

    // Per-engine brand rows only: the 'all' row is the blend (counting it would
    // double the sample) and competitor rows are not the project's own cells.
    const engines = await tx.query<EngineRow>(
      `SELECT engine_key,
              sum(cells_total)::text AS sample_size,
              CASE WHEN sum(cells_total) > 0 THEN (sum(cells_total * live_capture_ratio) / sum(cells_total))::float8 END AS live_capture_ratio
         FROM metric_daily
        WHERE project_id = $1 AND scoring_version = $2 AND entity_type = 'brand'
          AND engine_key <> $3 AND metric_date BETWEEN $4::date AND $5::date
        GROUP BY engine_key`,
      [projectId, settings.scoring_version, CROSS_ENGINE_KEY, from, to],
    );
    const sources = await engineDataSourcesForDates(tx, projectId, from, to, settings.timezone);

    const overrides = z
      .object({ scoring_weights: weightOverridesSchema })
      .safeParse(settings.entitlement_overrides ?? {});

    const footer = buildMethodologyFooter({
      dataThrough: through.rows[0]?.data_through ?? null,
      timeframe: query.timeframe,
      scoringVersion: settings.scoring_version,
      weightOverrides: overrides.success ? overrides.data.scoring_weights : null,
      engines: engines.rows.map((row) => ({
        engineKey: row.engine_key,
        dataSource: sources.get(row.engine_key) ?? null,
        sampleSize: Number(row.sample_size),
        liveCaptureRatio: row.live_capture_ratio,
      })),
    });

    incrementCounter("nominara_reports_methodology_requests_total", { timeframe: query.timeframe });
    // Workspace ID, never its name; no engine text.
    logger.log({
      span: "reports.methodology",
      workspace_id: store.context.workspaceId,
      project_id: projectId,
      timeframe: query.timeframe,
      engines: footer.engines.length,
      duration_ms: Date.now() - started,
    });
    return footer;
  }
}
