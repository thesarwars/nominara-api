import type { ClientBase } from "pg";
import { NotFoundError } from "../../api/errors/domain-errors.js";

// STORY-136 — the analytics reads' window, shared since NEW-C-1 so the
// competitor panel and the scorecards cut the SAME days: two spellings of one
// boundary is how a header and a chart disagree at a DST boundary.

export const TIMEFRAME_DAYS: Readonly<Record<"7d" | "30d" | "90d", number>> = Object.freeze({
  "7d": 7,
  "30d": 30,
  "90d": 90,
});

export interface ResolvedWindow {
  from: string;
  to: string;
  priorFrom: string;
  priorTo: string;
  timezone: string;
}

/**
 * The window, in the PROJECT'S WORKSPACE TIMEZONE.
 *
 * Asked of Postgres rather than computed in Node, so the conversion uses
 * the same tz database `aggregateRange` does — a rollup bucketing a capture
 * into one day while this window excludes it would make the scorecard and
 * the chart disagree at every DST boundary.
 *
 * The prior window is the SAME LENGTH immediately before, which is what
 * §3's delta compares. An unaligned prior window would make the delta a
 * comparison of a month against a fortnight.
 */
export async function resolveWindow(tx: ClientBase, projectId: string, days: number, knownTimezone?: string): Promise<ResolvedWindow> {
  let timezone: string | undefined = knownTimezone;
  if (knownTimezone === undefined) {
    const settings = await tx.query<{ timezone: string }>(
      `SELECT w.timezone
         FROM projects p JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [projectId],
    );
    timezone = settings.rows[0]?.timezone;
  } else {
    // NEW-E-099a — the portal supplies the workspace's timezone (its role cannot read `workspaces`); the project is
    // still checked here, on the portal's own scoped read of `projects`.
    const found = await tx.query("SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL", [projectId]);
    if (found.rowCount === 0) timezone = undefined;
  }
  if (timezone === undefined) throw new NotFoundError({ message: "no such project" });

  const bounds = await tx.query<{ from: string; to: string; prior_from: string; prior_to: string }>(
    `SELECT to_char(today - make_interval(days => $1::int - 1), 'YYYY-MM-DD') AS from,
            to_char(today, 'YYYY-MM-DD')                                      AS to,
            to_char(today - make_interval(days => $1::int * 2 - 1), 'YYYY-MM-DD') AS prior_from,
            to_char(today - make_interval(days => $1::int), 'YYYY-MM-DD')     AS prior_to
       FROM (SELECT (now() AT TIME ZONE $2)::date AS today) t`,
    [days, timezone],
  );
  const row = bounds.rows[0]!;
  return { from: row.from, to: row.to, priorFrom: row.prior_from, priorTo: row.prior_to, timezone };
}
