import type { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { z } from "zod";
import { incrementCounter } from "../telemetry/metrics.js";
import { afterCommit } from "../../tenancy/tenant-context.js";
import { isRealIsoDate } from "./iso-date.js";

// STORY-042 AC6 / EC-12 — the `rollup_dirty` set: late-arriving facts mark their workspace-local date dirty, and the
// dirty-date sweep (rollup-sweep.ts) reprocesses it within 15 minutes. Upserts are idempotent, so reprocessing is safe.
//
// WHAT COUNTS AS "LATE". A fact is late when it lands on a day that is already CLOSED (before the workspace-local today),
// whether or not that day has a metric_daily row yet:
//   - a closed day WITH a row is stale the moment a fact lands on it;
//   - a closed day with NO row is marked too. The closed-day sweep only ever looks at yesterday, so an older day with no row
//     (a parse backlog longer than a day, a re-parse of an old quiet day) would otherwise never be rolled up; and for
//     yesterday, a fact that commits while the day's very first rollup is mid-flight sees no row yet and would otherwise
//     be missed by that rollup's snapshot AND by every later sweep. An extra reprocess costs one idempotent rollup, and
//     the set holds one member per (project, date), so a burst of facts is one job per sweep tick, not one per fact;
//   - the OPEN day is not marked: every run enqueues its own rollup after its last parse, and the 00:20 closed-day
//     rollup reads whatever facts exist by then.
//
// THE MARK IS WRITTEN AFTER COMMIT, never inside the transaction and never awaited across it: a transaction must not be
// held open across an await on Valkey, and a mark written before a commit that then rolls back is a mark for a fact that
// does not exist. A failed mark is retried in-process a bounded number of times (a Valkey blip must not leave the day's
// metric_daily stale for good: nothing else re-detects the fact), then logged and counted
// (`nominara_rollup_dirty_mark_failed_total`, which should alert at > 0). It cannot fail the parse: the facts are
// committed and a retry would re-run the whole parse for a bookkeeping fault.
//
// THE SET IS A SORTED SET, THE SCORE IS THE MARK'S VERSION. Every mark moves the member's score strictly forward, the
// sweep reads the score, puts it in the job key, and removes the member only if the score is STILL the one it read
// (atomic compare-and-remove, Lua). A fact that commits between the sweep's enqueue and its clear therefore leaves its
// member behind for the next tick instead of being swept away with the mark that preceded it, and its new version is a new
// job key, so the queue's dedup cannot hand it back onto the job that missed it.

export interface DirtyEntry {
  readonly workspaceId: string;
  readonly projectId: string;
  /** `YYYY-MM-DD`, workspace-local. */
  readonly metricDate: string;
}

/** The ioredis surface the set needs, so tests can stand in for it without a server. */
export interface DirtySetRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zrange(key: string, start: number, stop: string, withScores: "WITHSCORES"): Promise<string[]>;
}

/** KEYS[1] set; ARGV[1] requested score, ARGV[2] member. The score only ever moves forward, even for two marks in one millisecond. */
export const MARK_SCRIPT = `
local current = redis.call('ZSCORE', KEYS[1], ARGV[2])
local score = tonumber(ARGV[1])
if current and tonumber(current) >= score then score = tonumber(current) + 1 end
redis.call('ZADD', KEYS[1], score, ARGV[2])
return score
`;

/** KEYS[1] set; ARGV is member, version pairs. Removes a member only when its score is still the version the sweep read. */
export const CLEAR_IF_UNCHANGED_SCRIPT = `
local removed = 0
for i = 1, #ARGV, 2 do
  local current = redis.call('ZSCORE', KEYS[1], ARGV[i])
  if current and tonumber(current) == tonumber(ARGV[i + 1]) then
    redis.call('ZREM', KEYS[1], ARGV[i])
    removed = removed + 1
  end
end
return removed
`;

const memberSchema = z
  .tuple([z.string().uuid(), z.string().uuid(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)])
  .refine(([, , date]) => isRealIsoDate(date));

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

/** An entry as the sweep read it: `version` is the mark's score, and the only thing `clear` will remove it against. */
export interface PeekedDirtyEntry extends DirtyEntry {
  readonly version: number;
}

export class RollupDirtySet {
  constructor(
    private readonly redis: DirtySetRedis,
    private readonly key: string,
  ) {}

  /** `now` is the requested version (epoch ms); the stored version is strictly greater than any the member had. */
  async mark(entry: DirtyEntry, now: number = Date.now()): Promise<void> {
    await this.redis.eval(MARK_SCRIPT, 1, this.key, now, encodeDirtyEntry(entry));
  }

  /**
   * Reads up to `limit` entries, oldest mark first, WITHOUT removing them: the sweep removes an entry only after its job is
   * enqueued (`clear`), so a crash between the two re-enqueues (idempotent) instead of losing the mark. Malformed members
   * are removed and counted here — they can never become a job.
   */
  async peek(limit: number = DIRTY_BATCH_SIZE): Promise<{ entries: PeekedDirtyEntry[]; malformed: number }> {
    const flat = await this.redis.zrange(this.key, 0, String(limit - 1), "WITHSCORES");
    const entries: PeekedDirtyEntry[] = [];
    const bad: string[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const member = flat[i]!;
      const entry = decodeDirtyEntry(member);
      const version = Number(flat[i + 1]);
      if (entry === null || !Number.isFinite(version)) bad.push(member);
      else entries.push({ ...entry, version });
    }
    if (bad.length > 0) await this.redis.zrem(this.key, ...bad);
    return { entries, malformed: bad.length };
  }

  /** Removes each entry only if nothing re-marked it since it was read. Returns how many were removed. */
  async clear(entries: readonly PeekedDirtyEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    const args = entries.flatMap((entry) => [encodeDirtyEntry(entry), String(entry.version)]);
    return Number(await this.redis.eval(CLEAR_IF_UNCHANGED_SCRIPT, 1, this.key, ...args));
  }
}

/** Bounded in-process retry of a failed mark: total wait stays well under a second, then the failure is reported. */
export const DIRTY_MARK_RETRY_DELAYS_MS: readonly number[] = [50, 200];

/**
 * Called by the parse writer once it has persisted facts. Decides lateness (see the header) and, if the fact is late,
 * defers the mark until the transaction has committed. Returns whether a mark was scheduled.
 */
export async function markDateDirtyIfLate(
  tx: ClientBase,
  fact: { workspaceId: string; projectId: string; capturedAt: Date },
  mark: (entry: DirtyEntry) => Promise<void>,
  logger: Logger,
  retryDelaysMs: readonly number[] = DIRTY_MARK_RETRY_DELAYS_MS,
): Promise<boolean> {
  const found = await tx.query<{ metric_date: string; closed: boolean }>(
    `SELECT to_char(d.local_date, 'YYYY-MM-DD') AS metric_date,
            d.local_date < (now() AT TIME ZONE w.timezone)::date AS closed
       FROM workspaces w
      CROSS JOIN LATERAL (SELECT ($2::timestamptz AT TIME ZONE w.timezone)::date AS local_date) d
      WHERE w.id = $1`,
    [fact.workspaceId, fact.capturedAt],
  );
  const row = found.rows[0];
  if (row === undefined || !row.closed) return false;

  const entry: DirtyEntry = { workspaceId: fact.workspaceId, projectId: fact.projectId, metricDate: row.metric_date };
  afterCommit(() => {
    void markWithRetry(mark, entry, retryDelaysMs)
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
          attempts: retryDelaysMs.length + 1,
          error: error instanceof Error ? error.name : "unknown",
        });
      });
  });
  return true;
}

async function markWithRetry(mark: (entry: DirtyEntry) => Promise<void>, entry: DirtyEntry, delaysMs: readonly number[]): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mark(entry);
      return;
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
