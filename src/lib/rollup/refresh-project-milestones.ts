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
    (await pinPromptSetChange(tx, workspaceId, projectId, metricDate, timezone))
  );
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

  let pinned = 0;
  for (const row of previous.rows) {
    const label = row.display_name ?? row.engine_key;
    for (const transition of fingerprintTransitions(row.model_fingerprint, byEngine.get(row.engine_key) ?? [])) {
      const result = await tx.query(
        `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, detail, severity, source_type, source_id,
                                 affected_engines, visible_in_portal)
         VALUES ($1, $2, $3, 'engine_model_change', $4, $5, 'warning', 'system', $6, ARRAY[$7::text], false)
         ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
        [
          workspaceId,
          projectId,
          transition.at,
          `${label} model fingerprint changed`,
          `${transition.from} to ${transition.to}`,
          nameUuid("engine_model_change", projectId, row.engine_key, transition.from, transition.to, transition.at.toISOString()),
          row.engine_key,
        ],
      );
      pinned += result.rowCount ?? 0;
    }
  }
  return pinned;
}

async function pinPromptSetChange(tx: ClientBase, workspaceId: string, projectId: string, metricDate: string, timezone: string): Promise<number> {
  // `before` is the set that existed when the day began; a prompt counts as
  // REMOVED that day when it was deleted, or archived (the archive is the
  // status change, stamped by `updated_at`), during it.
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
