import type { ClientBase } from "pg";
import { ATTRIBUTION_WINDOW_DAYS, type AttributionWindowDays } from "../../../contracts/attribution/index.js";
import { joinWindow, type JoinedRow } from "./rollup-join.js";

// STORY-114 - one project's one window of `attribution_url_rollup`, from the three first-party tables.
//
//   citations     citation_facts          rows on the brand's OWN pages (`is_owned`), counted per cited URL
//   sessions      attribution_daily       AI-referred sessions and conversions; `unattributed_direct` is the honest floor, not an AI session
//   impressions   gsc_daily 'ai_surface'  page dimension, current window
//   clicks        gsc_daily 'classic'     page dimension, current window
//
// Reads this database only (no network call, ADR-0003) and every query carries `workspace_id = app.current_workspace()`. It reads
// no per-visitor data and writes none: `attribution_daily` is already aggregated at ingest, and the only write is the rollup.
//
// A WINDOW is `windowDays` days starting at `windowStart`, in the workspace's timezone; its PRIOR window is the `windowDays` days
// before. Recomputing REPLACES the window's rows (delete, then insert, in the caller's transaction and under its project lock), so
// the result is idempotent per project, window start, window length and URL, and a URL that has left every source leaves the table.

export const ROLLUP_WINDOW_LENGTHS: readonly AttributionWindowDays[] = ATTRIBUTION_WINDOW_DAYS;

export function addDays(date: string, days: number): string {
  const [year, month, dayOfMonth] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, dayOfMonth! + days)).toISOString().slice(0, 10);
}

export interface WindowSpec {
  readonly projectId: string;
  /** `YYYY-MM-DD`, workspace-local. */
  readonly windowStart: string;
  readonly windowDays: AttributionWindowDays;
}

/** The project's workspace timezone, or `undefined` when the project is gone. */
export async function projectTimezone(tx: ClientBase, projectId: string): Promise<string | undefined> {
  const found = await tx.query<{ timezone: string }>(
    `SELECT w.timezone FROM projects p JOIN workspaces w ON w.id = p.workspace_id
      WHERE p.id = $1 AND p.workspace_id = app.current_workspace() AND p.deleted_at IS NULL`,
    [projectId],
  );
  return found.rows[0]?.timezone;
}

/** Today in the workspace's zone, asked of Postgres so the conversion uses the same tz database the other rollups do. */
export async function localToday(tx: ClientBase, timezone: string): Promise<string> {
  const row = await tx.query<{ today: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today`, [timezone]);
  return row.rows[0]!.today;
}

/** A rebuild's first step: every rollup row of the project, whatever key it was built under. The next windows recompute from the sources. */
export async function purgeProjectRollups(tx: ClientBase, projectId: string): Promise<number> {
  const deleted = await tx.query("DELETE FROM attribution_url_rollup WHERE workspace_id = app.current_workspace() AND project_id = $1", [projectId]);
  return deleted.rowCount ?? 0;
}

export async function rollUpWindow(tx: ClientBase, spec: WindowSpec, timezone: string): Promise<JoinedRow[]> {
  const priorStart = addDays(spec.windowStart, -spec.windowDays);
  const endExclusive = addDays(spec.windowStart, spec.windowDays);

  const citations = await tx.query<{ url: string; current: number; prior: number }>(
    `SELECT c.normalized_url AS url,
            count(*) FILTER (WHERE c.captured_at >= ($2::date::timestamp AT TIME ZONE $4))::int AS current,
            count(*) FILTER (WHERE c.captured_at <  ($2::date::timestamp AT TIME ZONE $4))::int AS prior
       FROM citation_facts c
      WHERE c.workspace_id = app.current_workspace() AND c.project_id = $1 AND c.is_owned
        AND c.captured_at >= ($5::date::timestamp AT TIME ZONE $4) AND c.captured_at < ($3::date::timestamp AT TIME ZONE $4)
      GROUP BY c.normalized_url`,
    [spec.projectId, spec.windowStart, endExclusive, timezone, priorStart],
  );

  const sessions = await tx.query<{ url: string; sessions: number; sessions_prior: number; conversions: number }>(
    `SELECT d.landing_url AS url,
            coalesce(sum(d.sessions)     FILTER (WHERE d.metric_date >= $2::date), 0)::int AS sessions,
            coalesce(sum(d.sessions)     FILTER (WHERE d.metric_date <  $2::date), 0)::int AS sessions_prior,
            coalesce(sum(d.conversions)  FILTER (WHERE d.metric_date >= $2::date), 0)::int AS conversions
       FROM attribution_daily d
      WHERE d.workspace_id = app.current_workspace() AND d.project_id = $1
        AND d.referrer_class <> 'unattributed_direct'
        AND d.metric_date >= $4::date AND d.metric_date < $3::date
      GROUP BY d.landing_url`,
    [spec.projectId, spec.windowStart, endExclusive, priorStart],
  );

  // WHAT SEARCH CONSOLE HAS MEASURED, NOT WHETHER IT IS CONNECTED. A live connection that has never synced, or whose watermark is before
  // the window, has measured nothing: its figures are unknown (null), never a zero, because a zero reads as "no impressions" and lets
  // `classifyUrl` call a page AI-only on no evidence. So a figure is known only when `last_sync_date` (the frontier: Google lags the
  // calendar by days) reaches into the window, and it is counted only up to that frontier. Within it, a URL with no row is a real zero.
  // `gsc_connections` has ONE watermark for two reports, so AI-surface impressions are additionally known only when the last sync was not
  // recorded as unable to serve that report: the classic watermark never implies AI-surface coverage.
  const coverage = await tx.query<{ synced_through: string | null; ai_surface_served: boolean }>(
    `SELECT g.last_sync_date::text AS synced_through, (g.last_error IS DISTINCT FROM 'ai_surface_report_unavailable') AS ai_surface_served
       FROM gsc_connections g
      WHERE g.workspace_id = app.current_workspace() AND g.project_id = $1 AND g.revoked_at IS NULL
      ORDER BY g.last_sync_date DESC NULLS LAST LIMIT 1`,
    [spec.projectId],
  );
  const syncedThrough = coverage.rows[0]?.synced_through ?? null;
  const windowHasCoverage = syncedThrough !== null && syncedThrough >= spec.windowStart;
  let impressions: Array<{ url: string; value: number }> | null = null;
  let clicks: Array<{ url: string; value: number }> | null = null;
  if (windowHasCoverage) {
    const search = await tx.query<{ report: string; url: string; impressions: number; clicks: number }>(
      `SELECT g.report, g.page_url AS url, sum(g.impressions)::int AS impressions, sum(g.clicks)::int AS clicks
         FROM gsc_daily g
        WHERE g.workspace_id = app.current_workspace() AND g.project_id = $1 AND g.dimension = 'page' AND g.page_url IS NOT NULL
          AND g.metric_date >= $2::date AND g.metric_date < $3::date AND g.metric_date <= $4::date
        GROUP BY g.report, g.page_url`,
      [spec.projectId, spec.windowStart, endExclusive, syncedThrough],
    );
    clicks = search.rows.filter((r) => r.report === "classic").map((r) => ({ url: r.url, value: r.clicks }));
    if (coverage.rows[0]?.ai_surface_served === true) impressions = search.rows.filter((r) => r.report === "ai_surface").map((r) => ({ url: r.url, value: r.impressions }));
  }

  const rows = joinWindow({
    citations: citations.rows.map((r) => ({ url: r.url, current: r.current, prior: r.prior })),
    sessions: sessions.rows.map((r) => ({ url: r.url, sessions: r.sessions, sessionsPrior: r.sessions_prior, conversions: r.conversions })),
    impressions,
    clicks,
  });

  await tx.query(
    "DELETE FROM attribution_url_rollup WHERE workspace_id = app.current_workspace() AND project_id = $1 AND window_start = $2::date AND window_days = $3",
    [spec.projectId, spec.windowStart, spec.windowDays],
  );
  if (rows.length > 0) {
    await tx.query(
      `INSERT INTO attribution_url_rollup
         (workspace_id, project_id, window_start, window_days, landing_url_hash, landing_url, citations, citations_prior,
          ai_sessions, ai_sessions_prior, conversions, cvr, gsc_ai_impressions, organic_clicks, pattern)
       SELECT app.current_workspace(), $1, $2::date, $3::smallint, u.hash, u.url, u.cit, u.cit_prior, u.sess, u.sess_prior, u.conv, u.cvr, u.imp, u.clk, u.pattern
         FROM unnest($4::bytea[], $5::text[], $6::int[], $7::int[], $8::int[], $9::int[], $10::int[], $11::real[], $12::int[], $13::int[], $14::text[])
              AS u(hash, url, cit, cit_prior, sess, sess_prior, conv, cvr, imp, clk, pattern)`,
      [
        spec.projectId,
        spec.windowStart,
        spec.windowDays,
        rows.map((r) => r.urlHash),
        rows.map((r) => r.url),
        rows.map((r) => r.citations),
        rows.map((r) => r.citationsPrior),
        rows.map((r) => r.aiSessions),
        rows.map((r) => r.aiSessionsPrior),
        rows.map((r) => r.conversions),
        rows.map((r) => r.cvr),
        rows.map((r) => r.gscAiImpressions),
        rows.map((r) => r.organicClicks),
        rows.map((r) => r.pattern),
      ],
    );
  }
  return rows;
}
