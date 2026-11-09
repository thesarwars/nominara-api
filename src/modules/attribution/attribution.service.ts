import { Injectable, Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  MEASURED_FLOOR_COPY,
  type AttributionPattern,
  type AttributionQuery,
  type AttributionReport,
  type AttributionWindowDays,
} from "../../../contracts/attribution/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { substitutionNote } from "../../lib/attribution/pattern-classifier.js";
import { incrementCounter, observeValue } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-114 - `GET /projects/{id}/attribution`, owning READS of `attribution_url_rollup` (the job writes it).
//
// PERSISTED ROWS ONLY: nothing here joins, classifies or computes; the rollup job did. No network call, no credit meter.
// The newest computed window of the requested length is returned. THE SUBSTITUTION CANDIDATES COME FIRST (surfaced, not buried),
// each carrying the shared co-movement copy; the rest follow by AI sessions, then citations.

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("attribution-report");

const WINDOW_DAYS: Readonly<Record<AttributionQuery["timeframe"], AttributionWindowDays>> = Object.freeze({ "7d": 7, "30d": 30, "90d": 90 });

interface RollupRow {
  landing_url: string;
  citations: number;
  citations_prior: number;
  ai_sessions: number;
  ai_sessions_prior: number;
  conversions: number;
  cvr: number | null;
  gsc_ai_impressions: number | null;
  organic_clicks: number | null;
  pattern: AttributionPattern;
}

@Injectable()
export class AttributionService {
  async report(projectId: string, query: AttributionQuery): Promise<AttributionReport> {
    return tracer.startActiveSpan("attribution.report", async (span) => {
      const started = Date.now();
      try {
        const tx = this.tx();
        const windowDays = WINDOW_DAYS[query.timeframe];
        const project = await tx.query("SELECT 1 FROM projects WHERE id = $1 AND workspace_id = app.current_workspace() AND deleted_at IS NULL", [projectId]);
        if (project.rowCount === 0) throw new NotFoundError({ message: "no such project" });

        const connected = await tx.query<{ connected: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM gsc_connections WHERE workspace_id = app.current_workspace() AND project_id = $1 AND revoked_at IS NULL) AS connected",
          [projectId],
        );
        const latest = await tx.query<{ window_start: string | null; computed_at: Date | null }>(
          `SELECT max(window_start)::text AS window_start, max(computed_at) AS computed_at
             FROM attribution_url_rollup
            WHERE workspace_id = app.current_workspace() AND project_id = $1 AND window_days = $2
              AND window_start = (SELECT max(window_start) FROM attribution_url_rollup WHERE workspace_id = app.current_workspace() AND project_id = $1 AND window_days = $2)`,
          [projectId, windowDays],
        );
        const windowStart = latest.rows[0]?.window_start ?? null;
        let rows: RollupRow[] = [];
        if (windowStart !== null) {
          const found = await tx.query<RollupRow>(
            `SELECT landing_url, citations, citations_prior, ai_sessions, ai_sessions_prior, conversions,
                    round(cvr::numeric, 6)::float8 AS cvr, gsc_ai_impressions, organic_clicks, pattern
               FROM attribution_url_rollup
              WHERE workspace_id = app.current_workspace() AND project_id = $1 AND window_days = $2 AND window_start = $3::date
                AND ($4::text IS NULL OR pattern = $4::text)
              ORDER BY (pattern = 'ai_substitution_candidate') DESC, ai_sessions DESC, citations DESC, landing_url`,
            [projectId, windowDays, windowStart, query.pattern ?? null],
          );
          rows = found.rows;
        }
        const report: AttributionReport = {
          window_days: windowDays,
          window_start: windowStart,
          computed_at: latest.rows[0]?.computed_at?.toISOString() ?? null,
          gsc_connected: connected.rows[0]?.connected === true,
          substitution_candidates: rows.filter((r) => r.pattern === "ai_substitution_candidate").length,
          measured_floor_note: MEASURED_FLOOR_COPY,
          rows: rows.map((r) => ({
            url: r.landing_url,
            citations: r.citations,
            citations_prior: r.citations_prior,
            ai_sessions: r.ai_sessions,
            ai_sessions_prior: r.ai_sessions_prior,
            conversions: r.conversions,
            conversion_rate: r.cvr,
            gsc_ai_impressions: r.gsc_ai_impressions,
            organic_clicks: r.organic_clicks,
            pattern: r.pattern,
            flagged: r.pattern === "ai_substitution_candidate",
            note: substitutionNote(r.pattern),
          })),
        };
        span.setAttribute("attribution.rows", report.rows.length);
        incrementCounter("nominara_attribution_report_reads_total", { window_days: String(windowDays) });
        // Counts only: never a URL, a figure or a workspace name.
        logger.log({ event: "attribution.report_read", window_days: windowDays, rows: report.rows.length, substitution_candidates: report.substitution_candidates });
        return report;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
        observeValue("nominara_attribution_report_duration_ms", Date.now() - started);
      }
    });
  }

  private tx() {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("AttributionService requires an active tenant context");
    return store.client;
  }
}
