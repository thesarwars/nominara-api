import { Injectable, Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  GSC_FRONTIER_COPY,
  GSC_PROMPT_CANDIDATE_LABEL,
  GSC_PROMPT_CANDIDATE_LIMIT_COPY,
  type GscHealthStatus,
  type GscPromptCandidates,
  type GscPromptCandidatesQuery,
} from "../../../contracts/integrations/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { matchQueryToPrompt } from "../../lib/gsc/query-match.js";
import { addDays } from "../../lib/gsc/sync-plan.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-115 AC11 / FR-PA-04 - `GET /projects/{id}/gsc/prompt-candidates`: the CLASSIC report's real queries, offered as prompt candidates
// labelled "real Google query" (distinct from "generated"). PROVISIONAL (batch 13): read-only; it writes no prompt and costs nothing.
//
//   * ONE REPORT. Only `report = 'classic'`, `dimension = 'query'` is read; no statement touches the AI-surface rows, so no AI figure can
//     reach a candidate (FR-OA-04a: the two reports are never conflated).
//   * NO VOLUME CLAIM. The figures are Google search impressions and clicks, and the response says so (FR-PA-04a). Nothing estimates how
//     many AI prompts a query would be.
//   * THE FRONTIER, NOT TODAY. The window ends at the stored `last_sync_date`; before a first sync there is no window at all.
//   * NOTHING ALREADY TRACKED. A query that fuzzy-matches an existing, non-deleted prompt at or above the query-match floor is not
//     offered (the same deterministic trigram join the correlation surface uses); the limit is applied after that, so a covered query
//     takes no slot.

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("gsc-prompt-candidates");

const WINDOW_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;
/** How many of the highest-impression queries are considered before the tracked ones are removed. */
const CONSIDERED_QUERIES = 500;

@Injectable()
export class GscPromptCandidatesService {
  async read(projectId: string, query: GscPromptCandidatesQuery): Promise<GscPromptCandidates> {
    return tracer.startActiveSpan("gsc.prompt_candidates.read", async (span) => {
      try {
        const store = currentTenantStore();
        if (store === undefined) throw new Error("GscPromptCandidatesService requires an active tenant context");
        const tx = store.client;
        const windowDays = WINDOW_DAYS[query.timeframe];
        const project = await tx.query("SELECT 1 FROM projects WHERE id = $1 AND workspace_id = app.current_workspace() AND deleted_at IS NULL", [projectId]);
        if (project.rowCount === 0) throw new NotFoundError({ message: "no such project" });

        const connection = await tx.query<{ health_status: GscHealthStatus; last_sync_date: string | null }>(
          "SELECT health_status, last_sync_date::text AS last_sync_date FROM gsc_connections WHERE project_id = $1 AND workspace_id = app.current_workspace() AND revoked_at IS NULL",
          [projectId],
        );
        const conn = connection.rows[0];
        const base = { window_days: windowDays, frontier_note: GSC_FRONTIER_COPY, limits_note: GSC_PROMPT_CANDIDATE_LIMIT_COPY };
        const frontier = conn?.last_sync_date ?? null;
        if (conn === undefined || frontier === null) {
          incrementCounter("nominara_gsc_prompt_candidates_reads_total", { outcome: conn === undefined ? "not_connected" : "not_synced" });
          return { ...base, connected: conn !== undefined, health_status: conn?.health_status ?? null, window_start: null, window_end: null, frontier: null, candidates: [] };
        }
        const end = frontier;
        const start = addDays(end, -(windowDays - 1));

        const queries = await tx.query<{ query_text: string; impressions: number; clicks: number }>(
          `SELECT query_text, sum(impressions)::int AS impressions, sum(clicks)::int AS clicks
             FROM gsc_daily
            WHERE workspace_id = app.current_workspace() AND project_id = $1 AND report = 'classic' AND dimension = 'query' AND query_text IS NOT NULL
              AND metric_date BETWEEN $2::date AND $3::date
            GROUP BY query_text
            ORDER BY sum(impressions) DESC, query_text
            LIMIT ${String(CONSIDERED_QUERIES)}`,
          [projectId, start, end],
        );
        const prompts = await tx.query<{ id: string; text: string }>(
          "SELECT id, text FROM tracked_prompts WHERE workspace_id = app.current_workspace() AND project_id = $1 AND deleted_at IS NULL ORDER BY id",
          [projectId],
        );
        const candidates = queries.rows
          .filter((row) => matchQueryToPrompt(row.query_text, prompts.rows) === null)
          .slice(0, query.limit)
          .map((row) => ({
            text: row.query_text,
            source: "gsc_query" as const,
            report: "classic" as const,
            label: GSC_PROMPT_CANDIDATE_LABEL as typeof GSC_PROMPT_CANDIDATE_LABEL,
            impressions: row.impressions,
            clicks: row.clicks,
          }));

        span.setAttribute("gsc.prompt_candidates.offered", candidates.length);
        incrementCounter("nominara_gsc_prompt_candidates_reads_total", { outcome: "read" });
        // Counts only: never a query, a URL or a workspace name.
        logger.log({ event: "gsc.prompt_candidates.read", window_days: windowDays, considered: queries.rows.length, offered: candidates.length });
        return { ...base, connected: true, health_status: conn.health_status, window_start: start, window_end: end, frontier, candidates };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
