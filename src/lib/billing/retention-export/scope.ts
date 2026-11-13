import type { ClientBase } from "pg";
import type { RetentionWindow } from "../../../workers/rollup/retention.js";

// STORY-185 - what a full-data export covers: exactly what the pending purge will remove.
//
// A retention-shortening deferral is pending while `workspaces.retention_purge_not_before` has not passed (the same test the sweep and the read
// paths use: at the instant itself it is still deferred). The cutoffs are the notice's own: the purge DATE minus the NEW window, so the export
// and the notice name the same line (lib/billing/retention-shortening.ts: `cutoffFor`).
//
// A section is in scope when the new plan's window is a number and it purges more than the replaced window did: the replaced window
// (`retention_deferred_*_days`) is null ("never purged": an unlimited or a not-applicable window, which the deferral record cannot tell apart)
// or longer. A window that did not move is not in scope: nothing beyond the ordinary expiry goes because of this change. The cancel-to-Free
// case needs no special path: Free's windows are just the new plan's.
//
// A null deferred window is read as "this section goes": that is what the purge does (the sweep treats the new numeric window as the line). For
// a move off a not-applicable window the notice does not list rollups, but the purge still removes them, so the export includes them: it
// covers what is actually removed. (The notice's gap is an owner decision recorded with STORY-077.)

const DAY_MS = 86_400_000;

export interface ExportSection {
  /** The new plan's window, in days. */
  readonly windowDays: number;
  /** Anything older than this goes at the first purge. */
  readonly cutoff: Date;
}

export interface ExportScope {
  readonly purgeNotBefore: Date;
  readonly raw: ExportSection | null;
  readonly rollups: ExportSection | null;
}

function section(planWindow: RetentionWindow, deferredWindow: number | null, purgeNotBefore: Date): ExportSection | null {
  if (typeof planWindow !== "number") return null;
  if (deferredWindow !== null && deferredWindow <= planWindow) return null;
  return { windowDays: planWindow, cutoff: new Date(purgeNotBefore.getTime() - planWindow * DAY_MS) };
}

export interface ScopeParts {
  readonly until: Date | null;
  readonly deferredRaw: number | null;
  readonly deferredRollups: number | null;
  readonly planRaw: RetentionWindow;
  readonly planRollups: RetentionWindow;
}

/** The scope for these parts, or null when no deferral is pending at `now` (or it would purge nothing more). Pure: shared by the reader and the notice. */
export function scopeFromParts(parts: ScopeParts, now: Date): ExportScope | null {
  if (parts.until === null || parts.until.getTime() < now.getTime()) return null;
  const raw = section(parts.planRaw, parts.deferredRaw, parts.until);
  const rollups = section(parts.planRollups, parts.deferredRollups, parts.until);
  if (raw === null && rollups === null) return null;
  return { purgeNotBefore: parts.until, raw, rollups };
}

/** What `retention_exports.scope` stores: the purge date and the cutoffs (null when that window is not shortened). */
export interface ScopeSnapshot {
  readonly purge_not_before: string;
  readonly raw_cutoff: string | null;
  readonly rollups_cutoff: string | null;
}

export function scopeSnapshot(scope: ExportScope): ScopeSnapshot {
  return { purge_not_before: scope.purgeNotBefore.toISOString(), raw_cutoff: scope.raw?.cutoff.toISOString() ?? null, rollups_cutoff: scope.rollups?.cutoff.toISOString() ?? null };
}

/** True only when `stored` is a snapshot of exactly this scope. A null, malformed or older snapshot never matches (superseded). */
export function sameScope(stored: unknown, scope: ExportScope): boolean {
  if (typeof stored !== "object" || stored === null) return false;
  const want = scopeSnapshot(scope);
  const have = stored as Partial<ScopeSnapshot>;
  return have.purge_not_before === want.purge_not_before && have.raw_cutoff === want.raw_cutoff && have.rollups_cutoff === want.rollups_cutoff;
}

/** The scope of the workspace's pending deferral, or null when none is pending (or it would purge nothing more). Reads inside the caller's tenant transaction. */
export async function readExportScope(tx: ClientBase, workspaceId: string, now: Date): Promise<ExportScope | null> {
  const r = await tx.query<{ until: Date | null; deferred_raw: number | null; deferred_rollups: number | null; raw: unknown; rollups: unknown }>(
    `SELECT w.retention_purge_not_before AS until, w.retention_deferred_raw_days AS deferred_raw, w.retention_deferred_rollups_days AS deferred_rollups,
            p.entitlements->'retention.raw_captures_days'->'value' AS raw, p.entitlements->'retention.rollups_days'->'value' AS rollups
       FROM workspaces w JOIN plans p ON p.key = w.plan_key
      WHERE w.id = $1 AND w.deleted_at IS NULL`,
    [workspaceId],
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  return scopeFromParts({ until: row.until, deferredRaw: row.deferred_raw, deferredRollups: row.deferred_rollups, planRaw: row.raw as RetentionWindow, planRollups: row.rollups as RetentionWindow }, now);
}
