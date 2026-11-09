import { Injectable, Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  ATTRIBUTION_AI_REFERRER_CLASSES,
  MEASURED_FLOOR_COPY,
  type AttributionFigure,
  type AttributionTotals,
  type AttributionPattern,
  type AttributionQuery,
  type AttributionReport,
  type AttributionWindowDays,
} from "../../../contracts/attribution/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { addDays } from "../../lib/attribution/attribution-rollup.js";
import { substitutionNote } from "../../lib/attribution/pattern-classifier.js";
import { incrementCounter, observeValue } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-114 - `GET /projects/{id}/attribution`, owning READS of `attribution_url_rollup` (the job writes it).
//
// PERSISTED ROWS ONLY: nothing here joins or classifies; the rollup job did. The project-wide `totals` (STORY-116 F1/F2) are sums of the beacon's
// daily MEASURED counts over the rollup's own window and prior window: no scaling, no estimate. The stripped class (`unattributed_direct`)
// is its own figure beside the AI ones and is never added into them. No network call, no credit meter.
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

const ratio = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : Math.round((numerator / denominator) * 1e6) / 1e6);

/** What the beacon was collecting, from `attribution_configs`: dates are UTC `YYYY-MM-DD`. `null` first = nothing measured at all. */
interface Coverage {
  readonly first: string | null;
  readonly last: string | null;
  /** True only when the beacon's first event is on or before the prior window's first day. */
  readonly priorCovered: boolean;
}

function figure(current: number, prior: number, cov: Coverage): AttributionFigure {
  if (cov.first === null) return { current: null, prior: null, delta: null, delta_pct: null };
  if (!cov.priorCovered) return { current, prior: null, delta: null, delta_pct: null };
  return { current, prior, delta: current - prior, delta_pct: ratio(current - prior, prior) };
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
        const totals = windowStart === null ? null : await this.totals(tx, projectId, windowStart, windowDays);
        const report: AttributionReport = {
          window_days: windowDays,
          window_start: windowStart,
          computed_at: latest.rows[0]?.computed_at?.toISOString() ?? null,
          gsc_connected: connected.rows[0]?.connected === true,
          substitution_candidates: rows.filter((r) => r.pattern === "ai_substitution_candidate").length,
          measured_floor_note: MEASURED_FLOOR_COPY,
          totals,
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

  /** The window is `windowDays` days from `windowStart` and the prior is the same length before it: exactly the rollup job's definition. */
  private async totals(tx: ReturnType<AttributionService["tx"]>, projectId: string, windowStart: string, windowDays: AttributionWindowDays): Promise<AttributionTotals> {
    const priorStart = addDays(windowStart, -windowDays);
    const endExclusive = addDays(windowStart, windowDays);
    const found = await tx.query<{ referrer_class: string; sessions: number; sessions_prior: number; conversions: number; conversions_prior: number }>(
      `SELECT d.referrer_class,
              coalesce(sum(d.sessions)    FILTER (WHERE d.metric_date >= $2::date), 0)::int AS sessions,
              coalesce(sum(d.sessions)    FILTER (WHERE d.metric_date <  $2::date), 0)::int AS sessions_prior,
              coalesce(sum(d.conversions) FILTER (WHERE d.metric_date >= $2::date), 0)::int AS conversions,
              coalesce(sum(d.conversions) FILTER (WHERE d.metric_date <  $2::date), 0)::int AS conversions_prior
         FROM attribution_daily d
        WHERE d.workspace_id = app.current_workspace() AND d.project_id = $1 AND d.metric_date >= $3::date AND d.metric_date < $4::date
        GROUP BY d.referrer_class`,
      [projectId, windowStart, priorStart, endExclusive],
    );
    const cfg = await tx.query<{ first: string | null; last: string | null }>(
      `SELECT (first_event_at AT TIME ZONE 'UTC')::date::text AS first, (last_event_at AT TIME ZONE 'UTC')::date::text AS last
         FROM attribution_configs
        WHERE workspace_id = app.current_workspace() AND project_id = $1
        ORDER BY (status <> 'disabled') DESC, created_at DESC
        LIMIT 1`,
      [projectId],
    );
    const first = cfg.rows[0]?.first ?? null;
    const cov: Coverage = { first, last: cfg.rows[0]?.last ?? null, priorCovered: first !== null && first <= priorStart };
    const byClass = new Map(found.rows.map((r) => [r.referrer_class, r]));
    const get = (cls: string) => byClass.get(cls) ?? { sessions: 0, sessions_prior: 0, conversions: 0, conversions_prior: 0 };
    const engines = ATTRIBUTION_AI_REFERRER_CLASSES.map((cls) => {
      const r = get(cls);
      return { referrer_class: cls, sessions: figure(r.sessions, r.sessions_prior, cov), conversions: figure(r.conversions, r.conversions_prior, cov) };
    });
    const sum = (pick: (r: ReturnType<typeof get>) => number): number => ATTRIBUTION_AI_REFERRER_CLASSES.reduce((n, cls) => n + pick(get(cls)), 0);
    const aiSessionsCur = sum((r) => r.sessions);
    const aiSessionsPri = sum((r) => r.sessions_prior);
    const aiConvCur = sum((r) => r.conversions);
    const aiConvPri = sum((r) => r.conversions_prior);
    const aiSessions = figure(aiSessionsCur, aiSessionsPri, cov);
    const aiConversions = figure(aiConvCur, aiConvPri, cov);
    const stripped = get("unattributed_direct");
    return {
      measured_from: cov.first,
      measured_to: cov.last,
      ai_sessions: aiSessions,
      conversions: aiConversions,
      conversion_rate: cov.first === null ? null : ratio(aiConvCur, aiSessionsCur),
      conversion_rate_prior: cov.priorCovered ? ratio(aiConvPri, aiSessionsPri) : null,
      by_engine: engines,
      unattributed: { sessions: figure(stripped.sessions, stripped.sessions_prior, cov), conversions: figure(stripped.conversions, stripped.conversions_prior, cov) },
    };
  }

  private tx() {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("AttributionService requires an active tenant context");
    return store.client;
  }
}
