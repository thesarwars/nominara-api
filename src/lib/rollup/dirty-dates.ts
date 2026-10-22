import type { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { z } from "zod";
import { SCORING_VERSION } from "../scoring/index.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { afterCommit } from "../../tenancy/tenant-context.js";

// STORY-042 AC6 / EC-12 — the `rollup_dirty` set: late-arriving facts mark their workspace-local date dirty, and the
// dirty-date sweep (rollup-sweep.ts) reprocesses it within 15 minutes. Upserts are idempotent, so reprocessing is safe.
//
// WHAT COUNTS AS "LATE". A fact is late when it lands on a day that is already CLOSED (before the workspace-local today)
// AND that day already has a metric_daily row under the current scoring version:
//   - a closed day with NO row is not marked: the closed-day sweep enqueues it (facts exist, nothing rolled up after
//     the close), so marking it too would only roll it twice;
//   - the OPEN day is not marked: every run enqueues its own rollup after its last parse, and the 00:20 closed-day
//     rollup reads whatever facts exist by then. Marking every parse of a day that already has a row would turn each
//     cell of every run into a rollup request.
//
// THE MARK IS WRITTEN AFTER COMMIT, never inside the transaction and never awaited across it: a transaction must not be
// held open across an await on Valkey, and a mark written before a commit that then rolls back is a mark for a fact that
// does not exist. A failed mark is logged and counted (it cannot fail the parse: the facts are committed and a retry
// would re-run the whole parse for a bookkeeping fault).

export interface DirtyEntry {
  readonly workspaceId: string;
  readonly projectId: string;
  /** `YYYY-MM-DD`, workspace-local. */
  readonly metricDate: string;
}

/** The ioredis surface the set needs, so tests can stand in for it without a server. */
export interface DirtySetRedis {
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  sscan(key: string, cursor: string, countToken: "COUNT", count: number): Promise<[string, string[]]>;
}

const memberSchema = z
  .tuple([z.string().uuid(), z.string().uuid(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)])
  .refine(([, , date]) => !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date));

export function encodeDirtyEntry(entry: DirtyEntry): string {
  return `${entry.workspaceId}|${entry.projectId}|${entry.metricDate}`;
}

/** Null for anything that is not exactly `workspace|project|date`: a sweep must never enqueue a job from a member it cannot vouch for. */
export function decodeDirtyEntry(member: string): DirtyEntry | null {
  const parsed = memberSchema.safeParse(member.split("|"));
  if (!parsed.success) return null;
  const [workspaceId, projectId, metricDate] = parsed.data;
  return { workspaceId, projectId, metricDate };
}

/** How many members one sweep tick looks at. The set drains across ticks; this bounds one tick's work. */
export const DIRTY_BATCH_SIZE = 500;

export class RollupDirtySet {
  constructor(
    private readonly redis: DirtySetRedis,
    private readonly key: string,
  ) {}

  async mark(entry: DirtyEntry): Promise<void> {
    await this.redis.sadd(this.key, encodeDirtyEntry(entry));
  }

  /**
   * Reads up to `limit` entries WITHOUT removing them: the sweep removes an entry only after its job is enqueued
   * (`clear`), so a crash between the two re-enqueues (idempotent) instead of losing the mark. Malformed members are
   * removed and counted here — they can never become a job.
   */
  async peek(limit: number = DIRTY_BATCH_SIZE): Promise<{ entries: DirtyEntry[]; malformed: number }> {
    const entries: DirtyEntry[] = [];
    const bad: string[] = [];
    let cursor = "0";
    do {
      const [next, members] = await this.redis.sscan(this.key, cursor, "COUNT", limit);
      cursor = next;
      for (const member of members) {
        const entry = decodeDirtyEntry(member);
        if (entry === null) bad.push(member);
        else if (entries.length < limit) entries.push(entry);
      }
    } while (cursor !== "0" && entries.length < limit);
    if (bad.length > 0) await this.redis.srem(this.key, ...bad);
    // SSCAN may return a member more than once across pages.
    const unique = [...new Map(entries.map((entry) => [encodeDirtyEntry(entry), entry])).values()];
    return { entries: unique, malformed: bad.length };
  }

  async clear(entries: readonly DirtyEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.redis.srem(this.key, ...entries.map(encodeDirtyEntry));
  }
}

/**
 * Called by the parse writer once it has persisted facts. Decides lateness (see the header) and, if the fact is late,
 * defers the mark until the transaction has committed. Returns whether a mark was scheduled.
 */
export async function markDateDirtyIfLate(
  tx: ClientBase,
  fact: { workspaceId: string; projectId: string; capturedAt: Date },
  mark: (entry: DirtyEntry) => Promise<void>,
  logger: Logger,
): Promise<boolean> {
  const found = await tx.query<{ metric_date: string; closed: boolean; rolled: boolean }>(
    `SELECT to_char(d.local_date, 'YYYY-MM-DD') AS metric_date,
            d.local_date < (now() AT TIME ZONE w.timezone)::date AS closed,
            EXISTS (SELECT 1 FROM metric_daily md
                     WHERE md.project_id = $2 AND md.metric_date = d.local_date AND md.scoring_version = $4) AS rolled
       FROM workspaces w
      CROSS JOIN LATERAL (SELECT ($3::timestamptz AT TIME ZONE w.timezone)::date AS local_date) d
      WHERE w.id = $1`,
    [fact.workspaceId, fact.projectId, fact.capturedAt, SCORING_VERSION],
  );
  const row = found.rows[0];
  if (row === undefined || !row.closed || !row.rolled) return false;

  const entry: DirtyEntry = { workspaceId: fact.workspaceId, projectId: fact.projectId, metricDate: row.metric_date };
  afterCommit(() => {
    void mark(entry)
      .then(() => {
        incrementCounter("nominara_rollup_dirty_marked_total");
      })
      .catch((error: unknown) => {
        incrementCounter("nominara_rollup_dirty_mark_failed_total");
        logger.error({
          event: "rollup.dirty_mark_failed",
          workspace_id: entry.workspaceId,
          project_id: entry.projectId,
          metric_date: entry.metricDate,
          error: error instanceof Error ? error.name : "unknown",
        });
      });
  });
  return true;
}
