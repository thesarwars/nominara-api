import { Injectable, Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  GSC_AI_IMPRESSIONS_LIMIT_COPY,
  GSC_CITATIONS_LIMIT_COPY,
  GSC_CORRELATION_ONLY_COPY,
  GSC_FRONTIER_COPY,
  GSC_INDEPENDENCE_COPY,
  GSC_SEARCH_QUERY_LABEL,
  GSC_SESSIONS_LIMIT_COPY,
  type GscCorrelation,
  type GscCorrelationPage,
  type GscCorrelationQuery,
  type GscHealthStatus,
  type GscSignal,
} from "../../../contracts/integrations/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { joinUrlKey } from "../../lib/attribution/url-normalisation.js";
import { matchQueryToPrompt } from "../../lib/gsc/query-match.js";
import { addDays } from "../../lib/gsc/sync-plan.js";
import { incrementCounter, observeValue } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-115 - `GET /projects/{id}/gsc/correlation`: our citations beside Google's AI-surface impressions (and the beacon's sessions),
// joined by canonical URL, plus the project's real search queries.
//
// WHAT THIS ROUTE REFUSES TO DO
//   * MIX THE REPORTS. Impressions are read from `report = 'ai_surface'` only; queries from `report = 'classic'`, `dimension = 'query'`
//     only. No statement sums across the two, so no query-level AI figure can exist here.
//   * IMPLY TODAY. The window ENDS at the stored frontier (`last_sync_date`), never at the clock, and our own citations and the
//     beacon's sessions are cut to the same last day so the three are compared over the same days. Nothing here reads the process clock.
//   * MERGE THE THREE SIGNALS. Each page row carries three separate fields and the response says, in words, that they are independent
//     measurements and that nothing here claims one caused another.
//   * INVENT A ZERO. A page Google reported nothing for has `gsc_ai_impressions: null`; a project with no beacon has `ai_sessions: null`.
//   * JOIN A WEAK QUERY. A query below the similarity floor carries `match: null` (query-match.ts).
//
// THE PAGE JOIN IS EXACT, on the shared normalised-URL key (`joinUrlKey`, the one `citation_facts.url_hash` carries) applied to each
// source's stored URL string, as the attribution rollup does. Reads only: no network call, no credit meter.

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("gsc-correlation");

const WINDOW_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;
const MAX_PAGES = 200;
const MAX_QUERIES = 100;

interface UrlFigure {
  url: string;
  n: number;
}

function foldByKey(rows: readonly UrlFigure[]): Map<string, { url: string; n: number }> {
  const out = new Map<string, { url: string; n: number }>();
  for (const row of rows) {
    const key = joinUrlKey(row.url);
    if (key === null) continue;
    const id = key.hash.toString("hex");
    const existing = out.get(id);
    if (existing === undefined) out.set(id, { url: key.url, n: row.n });
    else existing.n += row.n;
  }
  return out;
}

function signals(frontier: string | null): GscSignal[] {
  return [
    { key: "citations", label: "Citations of your pages in AI answers", source: "Nominara captures on the engines it tracks", frontier, limits: GSC_CITATIONS_LIMIT_COPY },
    { key: "ai_surface_impressions", label: "Links shown in Google AI Overviews and AI Mode", source: "Google Search Console, generative AI performance report", frontier, limits: GSC_AI_IMPRESSIONS_LIMIT_COPY },
    { key: "ai_sessions", label: "Sessions arriving from AI answers", source: "Nominara's first-party referral beacon on your site", frontier, limits: GSC_SESSIONS_LIMIT_COPY },
  ];
}

@Injectable()
export class GscCorrelationService {
  async read(projectId: string, query: GscCorrelationQuery): Promise<GscCorrelation> {
    return tracer.startActiveSpan("gsc.correlation.read", async (span) => {
      const started = Date.now();
      try {
        const store = currentTenantStore();
        if (store === undefined) throw new Error("GscCorrelationService requires an active tenant context");
        const tx = store.client;
        const windowDays = WINDOW_DAYS[query.timeframe];
        const project = await tx.query("SELECT 1 FROM projects WHERE id = $1 AND workspace_id = app.current_workspace() AND deleted_at IS NULL", [projectId]);
        if (project.rowCount === 0) throw new NotFoundError({ message: "no such project" });

        const connection = await tx.query<{ health_status: GscHealthStatus; last_sync_date: string | null }>(
          "SELECT health_status, last_sync_date::text AS last_sync_date FROM gsc_connections WHERE project_id = $1 AND workspace_id = app.current_workspace() AND revoked_at IS NULL",
          [projectId],
        );
        const base = { window_days: windowDays, frontier_note: GSC_FRONTIER_COPY, independence_note: GSC_INDEPENDENCE_COPY, correlation_note: GSC_CORRELATION_ONLY_COPY };
        const conn = connection.rows[0];
        const frontier = conn?.last_sync_date ?? null;
        if (conn === undefined || frontier === null) {
          return { ...base, connected: conn !== undefined, health_status: conn?.health_status ?? null, window_start: null, window_end: null, frontier: null, signals: signals(null), pages: [], search_queries: [] };
        }
        const end = frontier;
        const start = addDays(end, -(windowDays - 1));

        const citations = await tx.query<UrlFigure>(
          `SELECT normalized_url AS url, count(*)::int AS n
             FROM citation_facts
            WHERE workspace_id = app.current_workspace() AND project_id = $1 AND is_owned
              AND captured_at >= ($2::date::timestamp AT TIME ZONE 'UTC') AND captured_at < (($3::date + 1)::timestamp AT TIME ZONE 'UTC')
            GROUP BY normalized_url`,
          [projectId, start, end],
        );
        // The AI-surface report only. A classic row is never read here.
        const impressions = await tx.query<UrlFigure>(
          `SELECT page_url AS url, sum(impressions)::int AS n
             FROM gsc_daily
            WHERE workspace_id = app.current_workspace() AND project_id = $1 AND report = 'ai_surface' AND dimension = 'page' AND page_url IS NOT NULL
              AND metric_date BETWEEN $2::date AND $3::date
            GROUP BY page_url`,
          [projectId, start, end],
        );
        const beacon = await tx.query(
          "SELECT 1 FROM attribution_configs WHERE project_id = $1 AND workspace_id = app.current_workspace() AND status <> 'disabled'",
          [projectId],
        );
        const sessions =
          beacon.rowCount === 0
            ? null
            : await tx.query<UrlFigure>(
                `SELECT landing_url AS url, sum(sessions)::int AS n
                   FROM attribution_daily
                  WHERE workspace_id = app.current_workspace() AND project_id = $1 AND referrer_class <> 'unattributed_direct'
                    AND metric_date BETWEEN $2::date AND $3::date
                  GROUP BY landing_url`,
                [projectId, start, end],
              );

        const cited = foldByKey(citations.rows);
        const shown = foldByKey(impressions.rows);
        const visits = sessions === null ? null : foldByKey(sessions.rows);
        const ids = new Set<string>([...cited.keys(), ...shown.keys()]);
        const pages: GscCorrelationPage[] = [...ids]
          .map((id) => ({
            url: (cited.get(id) ?? shown.get(id))!.url,
            citations: cited.get(id)?.n ?? 0,
            gsc_ai_impressions: shown.get(id)?.n ?? null,
            ai_sessions: visits === null ? null : (visits.get(id)?.n ?? 0),
          }))
          .sort((a, b) => (b.gsc_ai_impressions ?? -1) - (a.gsc_ai_impressions ?? -1) || b.citations - a.citations || a.url.localeCompare(b.url))
          .slice(0, MAX_PAGES);

        // The classic report's query dimension only.
        const queries = await tx.query<{ query_text: string; impressions: number; clicks: number }>(
          `SELECT query_text, sum(impressions)::int AS impressions, sum(clicks)::int AS clicks
             FROM gsc_daily
            WHERE workspace_id = app.current_workspace() AND project_id = $1 AND report = 'classic' AND dimension = 'query' AND query_text IS NOT NULL
              AND metric_date BETWEEN $2::date AND $3::date
            GROUP BY query_text
            ORDER BY sum(impressions) DESC, query_text
            LIMIT ${String(MAX_QUERIES)}`,
          [projectId, start, end],
        );
        const prompts = await tx.query<{ id: string; text: string }>(
          "SELECT id, text FROM tracked_prompts WHERE workspace_id = app.current_workspace() AND project_id = $1 AND status = 'active' AND deleted_at IS NULL ORDER BY id",
          [projectId],
        );
        let joined = 0;
        const search_queries = queries.rows.map((row) => {
          const match = matchQueryToPrompt(row.query_text, prompts.rows);
          if (match !== null) joined += 1;
          return {
            query: row.query_text,
            report: "classic" as const,
            label: GSC_SEARCH_QUERY_LABEL,
            impressions: row.impressions,
            clicks: row.clicks,
            match:
              match === null
                ? null
                : {
                    prompt_id: match.promptId,
                    prompt_text: prompts.rows.find((p) => p.id === match.promptId)!.text,
                    method: match.method,
                    confidence: match.confidence,
                    exact: false as const,
                    low_confidence: match.lowConfidence,
                  },
          };
        });

        span.setAttribute("gsc.correlation.pages", pages.length);
        span.setAttribute("gsc.correlation.queries", search_queries.length);
        incrementCounter("nominara_gsc_correlation_reads_total", { window_days: String(windowDays) });
        // Counts only: never a URL, a query or a workspace name.
        logger.log({ event: "gsc.correlation.read", window_days: windowDays, pages: pages.length, queries: search_queries.length, queries_joined: joined });
        return { ...base, connected: true, health_status: conn.health_status, window_start: start, window_end: end, frontier, signals: signals(frontier), pages, search_queries };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
        observeValue("nominara_gsc_correlation_duration_ms", Date.now() - started);
      }
    });
  }
}
