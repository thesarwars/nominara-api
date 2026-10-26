import type { ClientBase } from "pg";
import { DEMO_SEED_MARKER } from "../../db/seed/demo/constants.js";
import { fingerprintTransitions, isMaterialPromptSetChange } from "../analytics/growth-map.js";
import { nameUuid } from "../ids/name-uuid.js";

// STORY-066 AC8 / AC9 — the two configuration pins the rollup emits for one
// project and one workspace-local day (`scoring-models.md` §13):
//
//   engine_model_change  a vendor-reported model fingerprint changed — severity
//                        `warning`, portal-hidden by default.
//   prompt_set_change    ≥ 10 % of the prompt set added or removed in one day.
//
// They are the events most likely to CAUSE a movement that has nothing to do
// with the customer's work, which is why the chart has to show them.
//
// IDEMPOTENT BY A NAMED SOURCE. `ux_milestones_source` is unique over
// (source_type, source_id) for every project at once, and neither event has a
// row of its own, so each is named with `nameUuid` from parts that always
// include the project: a re-run of the same day yields the same ids and
// `ON CONFLICT DO NOTHING` pins nothing more, while the same model change seen
// on two projects pins once on each. `source_type` is `system` — no migration.
//
// Runs inside the rollup's tenant transaction and project lock; reads only
// this database. No `workspace_id` predicate on the reads — RLS scopes them.

/** Pins both configuration kinds for `metricDate`; returns how many new pins were written. */
export async function refreshProjectMilestones(
  tx: ClientBase,
  workspaceId: string,
  projectId: string,
  metricDate: string,
  timezone: string,
): Promise<number> {
  return (
    (await pinEngineModelChanges(tx, workspaceId, projectId, metricDate, timezone)) +
    (await pinPromptSetChanges(tx, workspaceId, projectId, metricDate, timezone))
  );
}

/** How far back one rollup catches up on `prompt_set_change`: the longest growth-map timeframe (365d). */
export const PROMPT_SET_CATCH_UP_DAYS = 365;

/**
 * STORY-066 AC9, review round 2 — the days the rollup of `metricDate` evaluates for `prompt_set_change`: every day from the previous
 * rolled-up day through `metricDate`. The rollup visits only days with captures (a parse batch, the closed-day sweep, a dirty
 * date), so a project on a weekly or manual cadence that changes its prompt set on a day with no capture would otherwise never be
 * evaluated for that day, and the next capture day would count the change in its `before` — the jump on the chart with no marker.
 * The previous rolled-up day is included: a change made later that day, after its last rollup, is caught. Bounded to the trailing
 * PROMPT_SET_CATCH_UP_DAYS. Pure; dates are `YYYY-MM-DD` calendar days.
 */
export function promptSetDaysToEvaluate(previousRolledUp: string | null, metricDate: string): string[] {
  const end = utcMidnight(metricDate);
  const floor = end - PROMPT_SET_CATCH_UP_DAYS * DAY_MS;
  const previous = previousRolledUp === null ? end : utcMidnight(previousRolledUp);
  const start = Math.max(Math.min(previous, end), floor);
  const days: string[] = [];
  for (let at = start; at <= end; at += DAY_MS) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}

const DAY_MS = 86_400_000;

/**
 * A `YYYY-MM-DD` calendar day as the epoch ms of its UTC midnight. ECMAScript parses the date-only ISO form as UTC (never local
 * time), so no time suffix is appended — and no `${day}T…` template literal is built, which ISO-13's key-construction scanner
 * cannot tell from a cache key.
 */
function utcMidnight(day: string): number {
  return Date.parse(day);
}

async function pinPromptSetChanges(tx: ClientBase, workspaceId: string, projectId: string, metricDate: string, timezone: string): Promise<number> {
  // The previous day this project was rolled up: the latest metric_daily date before this one (RLS scopes the read).
  const previous = await tx.query<{ day: string | null }>(
    `SELECT to_char(max(metric_date), 'YYYY-MM-DD') AS day FROM metric_daily WHERE project_id = $1 AND metric_date < $2::date`,
    [projectId, metricDate],
  );
  let pinned = 0;
  for (const day of promptSetDaysToEvaluate(previous.rows[0]?.day ?? null, metricDate)) {
    pinned += await pinPromptSetChange(tx, workspaceId, projectId, day, timezone);
  }
  return pinned;
}

/**
 * The day as a [start, end) instant range. Bounds on the raw `captured_at`
 * rather than `(captured_at AT TIME ZONE tz)::date`, so the capture reads
 * prune to the day's partitions.
 */
const DAY_BOUNDS = `(($2::date)::timestamp AT TIME ZONE $3) AS day_start, (($2::date + 1)::timestamp AT TIME ZONE $3) AS day_end`;

async function pinEngineModelChanges(tx: ClientBase, workspaceId: string, projectId: string, metricDate: string, timezone: string): Promise<number> {
  // A demo-seeded capture never counts (the seed writes invented fingerprints
  // under real engine keys), and a capture that reported no fingerprint says
  // nothing about the model.
  const captures = await tx.query<{ engine_key: string; model_fingerprint: string; captured_at: Date }>(
    `WITH d AS (SELECT ${DAY_BOUNDS})
     SELECT c.engine_key, c.model_fingerprint, c.captured_at
       FROM answer_captures c, d
      WHERE c.project_id = $1
        AND c.captured_at >= d.day_start AND c.captured_at < d.day_end
        AND c.model_fingerprint IS NOT NULL
        AND c.normalizer_version <> $4
      ORDER BY c.engine_key, c.captured_at, c.id`,
    [projectId, metricDate, timezone, DEMO_SEED_MARKER],
  );
  if (captures.rows.length === 0) return 0;

  const byEngine = new Map<string, { fingerprint: string; at: Date }[]>();
  for (const row of captures.rows) {
    byEngine.set(row.engine_key, [...(byEngine.get(row.engine_key) ?? []), { fingerprint: row.model_fingerprint, at: row.captured_at }]);
  }

  // The last fingerprint each engine reported BEFORE the day, under the same rules.
  const previous = await tx.query<{ engine_key: string; model_fingerprint: string | null; display_name: string | null }>(
    `WITH d AS (SELECT ${DAY_BOUNDS})
     SELECT e.engine_key, prior.model_fingerprint, en.display_name
       FROM unnest($5::text[]) AS e(engine_key)
       CROSS JOIN d
       LEFT JOIN engines en ON en.key = e.engine_key
       LEFT JOIN LATERAL (
         SELECT c.model_fingerprint
           FROM answer_captures c
          WHERE c.project_id = $1 AND c.engine_key = e.engine_key
            AND c.captured_at < d.day_start
            AND c.model_fingerprint IS NOT NULL
            AND c.normalizer_version <> $4
          ORDER BY c.captured_at DESC
          LIMIT 1
       ) prior ON true`,
    [projectId, metricDate, timezone, DEMO_SEED_MARKER, [...byEngine.keys()]],
  );

  // ONE PIN PER (engine, from, to) PER DAY, named by the DAY and not by the instant. The rollup runs after every parse batch, and
  // capture workers commit out of order: a capture taken EARLIER than one an earlier rollup already saw can commit after it, so a
  // re-run finds the same change at an earlier instant. An instant in the name would pin it twice (AC7); the day cannot move. The
  // pin's `occurred_at` is then moved to the earliest instant seen (`LEAST`), and a vendor whose fingerprint flips per request
  // pins each distinct change once a day rather than once per flip.
  let pinned = 0;
  for (const row of previous.rows) {
    const label = row.display_name ?? row.engine_key;
    const earliest = new Map<string, { from: string; to: string; at: Date }>();
    for (const transition of fingerprintTransitions(row.model_fingerprint, byEngine.get(row.engine_key) ?? [])) {
      const key = JSON.stringify([transition.from, transition.to]);
      if (!earliest.has(key)) earliest.set(key, transition);
    }
    for (const transition of earliest.values()) {
      const result = await tx.query<{ inserted: boolean }>(
        `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, detail, severity, source_type, source_id,
                                 affected_engines, visible_in_portal)
         VALUES ($1, $2, $3, 'engine_model_change', $4, $5, 'warning', 'system', $6, ARRAY[$7::text], false)
         ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL
         DO UPDATE SET occurred_at = LEAST(milestones.occurred_at, EXCLUDED.occurred_at)
         RETURNING (xmax = 0) AS inserted`,
        [
          workspaceId,
          projectId,
          transition.at,
          `${label} model fingerprint changed`,
          `${transition.from} to ${transition.to}`,
          nameUuid("engine_model_change", projectId, row.engine_key, transition.from, transition.to, metricDate),
          row.engine_key,
        ],
      );
      if (result.rows[0]?.inserted === true) pinned += 1;
    }
  }
  return pinned;
}

async function pinPromptSetChange(tx: ClientBase, workspaceId: string, projectId: string, metricDate: string, timezone: string): Promise<number> {
  // `before` is the set that existed when the day began; a prompt counts as
  // REMOVED that day when it was deleted, or archived (the archive is the
  // status change, stamped by `updated_at`), during it.
  //
  // ⚠ KNOWN LIMITS, open for an owner decision (STORY-066 review round 1; put to the owner in
  // plans-7day/followups-2026-10-26-s066.md, items 1 and 2):
  //   1. `tracked_prompts` has no status-change timestamp, so `updated_at`
  //      stands in for the archive time. `touch_updated_at` bumps it on ANY
  //      later update of an archived row, so such an update moves the
  //      prompt's "removed" day, and a re-roll of that later day can pin a
  //      spurious change (and a re-roll of an earlier day counts the prompt
  //      in `before`). The fix is a schema change (a status-change timestamp
  //      or record), which the story does not name.
  //   2. `paused` (a downgrade or retention pause) is not counted as a
  //      removal, and paused prompts stay in `before`. Whether the "prompt
  //      set" of §13 is the measured (active) set is not settled.
  const counts = await tx.query<{ before: number; added: number; removed: number; last_change: Date | null }>(
    `WITH d AS (SELECT ${DAY_BOUNDS}),
     p AS (
       SELECT t.created_at, t.deleted_at,
              CASE WHEN t.status = 'archived' AND t.deleted_at IS NULL THEN t.updated_at END AS archived_at
         FROM tracked_prompts t
        WHERE t.project_id = $1
     )
     SELECT count(*) FILTER (WHERE p.created_at < d.day_start
                               AND (p.deleted_at IS NULL OR p.deleted_at >= d.day_start)
                               AND (p.archived_at IS NULL OR p.archived_at >= d.day_start))::int AS before,
            count(*) FILTER (WHERE p.created_at >= d.day_start AND p.created_at < d.day_end)::int AS added,
            count(*) FILTER (WHERE p.created_at < d.day_start
                               AND ((p.deleted_at >= d.day_start AND p.deleted_at < d.day_end)
                                 OR (p.archived_at >= d.day_start AND p.archived_at < d.day_end)))::int AS removed,
            max(GREATEST(
                  CASE WHEN p.created_at  >= d.day_start AND p.created_at  < d.day_end THEN p.created_at END,
                  CASE WHEN p.deleted_at  >= d.day_start AND p.deleted_at  < d.day_end THEN p.deleted_at END,
                  CASE WHEN p.archived_at >= d.day_start AND p.archived_at < d.day_end THEN p.archived_at END)) AS last_change
       FROM p CROSS JOIN d`,
    [projectId, metricDate, timezone],
  );
  const change = counts.rows[0];
  if (change === undefined || change.last_change === null || !isMaterialPromptSetChange(change)) return 0;

  const result = await tx.query(
    `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, detail, severity, source_type, source_id, visible_in_portal)
     VALUES ($1, $2, $3, 'prompt_set_change', 'Prompt set changed', $4, 'info', 'system', $5, true)
     ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
    [
      workspaceId,
      projectId,
      change.last_change,
      `${String(change.added)} added, ${String(change.removed)} removed of ${String(change.before)}`,
      nameUuid("prompt_set_change", projectId, metricDate),
    ],
  );
  return result.rowCount ?? 0;
}
