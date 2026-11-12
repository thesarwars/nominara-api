import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { fold } from "../../parser/fold.js";
import { normalize } from "../../parser/normalize.js";
import { SCORING_VERSION } from "../../scoring/index.js";
import { uuidV7 } from "../../ids/uuidv7.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { casedSpellings, contextOfNormalised, isAmbiguousNameMatch } from "../entity.js";
import { JUDGE_BATCH_SIZE, JUDGE_BUCKET_ATTEMPTS, JUDGE_BUCKET_MAX_WAIT_MS, JUDGE_LOOKBACK_DAYS, JUDGE_MAX_PER_JOB, JUDGE_WINDOW, NAME_MATCH_JUDGE_MONTHLY_CAP } from "./constants.js";
import type { NameMatchJudge, NameMatchQuery, NameMatchVerdict } from "./port.js";

// STORY-191 - the three phases of the name-match judging job (ADR-0003). The job handler (geo-analyze.handler.ts) wires them into ONE phased processor:
//
//   prepareJudging  one short tenant transaction: read the project's brand-name matches that the v1 heuristic cannot settle (`isAmbiguousNameMatch`)
//                   and that have no verdict under this judge version yet, cut each to the span and a bounded window, and RESERVE them against the workspace's monthly meter.
//   runJudging      NO transaction, NO pooled client: batches go to the model, each after a token from the engine bucket. It reads no tenant data.
//   commitJudging   one short tenant transaction: store the verdicts, ON CONFLICT DO NOTHING, and give back the reservation that was never sent.
//
// IDEMPOTENT under at-least-once delivery: a redelivery re-reads what is still unjudged, and a racing double delivery's second commit writes nothing.
// A match the model fails on is simply not stored, so it is asked again by the next job. The model's `unjudged` IS stored (it is an answer).

const logger = new Logger("geo.name_match_judge");

export interface PendingMatch {
  readonly mentionFactId: string;
  /** `mention_facts.captured_at` as Postgres prints it, so microseconds survive the round trip back into the write. */
  readonly capturedAt: string;
  readonly query: NameMatchQuery;
}

export interface JudgingPrepared {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly judgeVersion: string;
  readonly judgeModel: string;
  /** How many matches this job RESERVED against the workspace's monthly meter (name_match_judge_usage) before any model call. `matches` never exceeds it. */
  readonly reserved: number;
  /** The UTC month (`YYYY-MM-01`) the reservation was taken in, so a release after a month turn goes back to the same row. */
  readonly month: string;
  readonly matches: readonly PendingMatch[];
}

export interface JudgedMatch {
  readonly mentionFactId: string;
  readonly capturedAt: string;
  readonly verdict: NameMatchVerdict;
}

export interface JudgingResult {
  readonly verdicts: readonly JudgedMatch[];
  /** Matches left for a later job: over the budget, or behind a bucket that stayed closed, or in a batch that failed. */
  readonly deferred: number;
  readonly modelCalls: number;
  /** Matches SENT to the model (every batch a call was made for, failed or not): what the monthly meter counts. */
  readonly attempted: number;
  readonly failedBatches: number;
  readonly bucketDenied: boolean;
}

export interface EngineBucketPort {
  tryAcquire(): Promise<{ readonly granted: boolean; readonly retryAfterMs: number }>;
}

export interface RunDeps {
  readonly judge: NameMatchJudge;
  /** The `gemini` engine bucket, the one capture runs draw from (it fails OPEN on a store error). */
  readonly bucket: EngineBucketPort;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface PrepareArgs {
  readonly projectId: string;
  readonly judgeVersion: string;
  readonly judgeModel: string;
  readonly monthlyCap?: number;
  readonly maxMatches?: number;
}

/** Null when there is nothing to do: the project is gone, no ambiguous match is pending, or the month's cap is spent. */
export async function prepareJudging(tx: ClientBase, args: PrepareArgs): Promise<JudgingPrepared | null> {
  const project = await tx.query<{ workspace_id: string; name: string; brand_aliases: string[] }>(
    "SELECT workspace_id, name, brand_aliases FROM projects WHERE id = $1 AND deleted_at IS NULL",
    [args.projectId],
  );
  const p = project.rows[0];
  if (p === undefined) return null;

  const captures = await tx.query<{ text: string | null; mentions: [string, string, string, number, number][] }>(
    `SELECT min(COALESCE(NULLIF(ac.payload ->> 'text', ''), NULLIF(src.payload ->> 'text', ''))) AS text,
            json_agg(json_build_array(mf.id, mf.captured_at::text, mf.matched_alias, mf.char_start, mf.char_end) ORDER BY mf.char_start) AS mentions
       FROM mention_facts mf
       LEFT JOIN answer_captures ac ON ac.id = mf.result_id AND ac.captured_at = mf.captured_at AND ac.workspace_id = mf.workspace_id AND ac.project_id = mf.project_id
       LEFT JOIN answer_captures src ON src.id = ac.source_result_id AND src.workspace_id = ac.workspace_id AND src.project_id = ac.project_id
       LEFT JOIN name_match_verdicts v ON v.mention_fact_id = mf.id AND v.captured_at = mf.captured_at AND v.workspace_id = mf.workspace_id AND v.judge_version = $3
      WHERE mf.project_id = $1 AND mf.entity_type = 'brand' AND mf.scoring_version = $2 AND v.id IS NULL
        AND mf.captured_at >= now() - make_interval(days => $4)
      GROUP BY mf.result_id, mf.captured_at
      ORDER BY mf.captured_at DESC`,
    [args.projectId, SCORING_VERSION, args.judgeVersion, JUDGE_LOOKBACK_DAYS],
  );

  const cased = casedSpellings([p.name, ...p.brand_aliases]);
  const limit = args.maxMatches ?? JUDGE_MAX_PER_JOB;
  const matches: PendingMatch[] = [];
  outer: for (const capture of captures.rows) {
    if (capture.text === null) continue; // no text held: nothing to show a model, and the analysis counts it unjudged
    const text = normalize(capture.text);
    for (const [id, capturedAt, alias, start, end] of capture.mentions) {
      // The window cut here is the ONLY text that ever leaves: the span and JUDGE_WINDOW either side.
      const ctx = contextOfNormalised(text, start, end, JUDGE_WINDOW);
      if (ctx === null) continue;
      const cas = cased.get(fold(alias).folded) ?? alias;
      if (!isAmbiguousNameMatch({ alias: cas, ...ctx })) continue;
      matches.push({ mentionFactId: id, capturedAt, query: { alias: cas, span: ctx.span, before: ctx.before, after: ctx.after } });
      if (matches.length >= limit) break outer;
    }
  }
  if (matches.length === 0) return null;

  // RESERVE the budget, atomically, BEFORE any model call (fix round, owner decision 99l). The row is the workspace's meter for the UTC month; the locking read
  // serialises every job of the workspace across its projects, so each takes only what is left and the cap can never be overshot by concurrent jobs. The
  // reservation commits with this short transaction; `commitJudging` gives back what was not sent. A job that dies in between keeps its reservation (the meter
  // errs high, never low).
  const cap = args.monthlyCap ?? NAME_MATCH_JUDGE_MONTHLY_CAP;
  await tx.query(
    `INSERT INTO name_match_judge_usage (workspace_id, month, matches_sent)
     VALUES (app.current_workspace(), date_trunc('month', now() AT TIME ZONE 'UTC')::date, 0) ON CONFLICT (workspace_id, month) DO NOTHING`,
  );
  const reservation = await tx.query<{ granted: number; month: string }>(
    `WITH cur AS (
       SELECT matches_sent FROM name_match_judge_usage
        WHERE workspace_id = app.current_workspace() AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date FOR UPDATE
     )
     UPDATE name_match_judge_usage u
        SET matches_sent = cur.matches_sent + LEAST($1::int, GREATEST(0, $2::int - cur.matches_sent)), updated_at = now()
       FROM cur
      WHERE u.workspace_id = app.current_workspace() AND u.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
     RETURNING (u.matches_sent - cur.matches_sent)::int AS granted, u.month::text AS month`,
    [matches.length, cap],
  );
  const granted = reservation.rows[0]?.granted ?? 0;
  if (granted === 0) {
    incrementCounter("nominara_geo_name_match_judge_cap_reached_total");
    logger.warn({ event: "geo.name_match_judge.cap_reached", workspace_id: p.workspace_id, project_id: args.projectId });
    return null;
  }
  return { workspaceId: p.workspace_id, projectId: args.projectId, judgeVersion: args.judgeVersion, judgeModel: args.judgeModel, reserved: granted, month: reservation.rows[0]!.month, matches: matches.slice(0, granted) };
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Holds NO transaction and NO client: it is handed what `prepareJudging` returned and a judge, and reads no tenant data. */
export async function runJudging(prepared: JudgingPrepared, deps: RunDeps): Promise<JudgingResult> {
  const sleep = deps.sleep ?? realSleep;
  const queue = prepared.matches.slice(0, Math.max(0, prepared.reserved));
  const verdicts: JudgedMatch[] = [];
  let modelCalls = 0;
  let attempted = 0;
  let failedBatches = 0;
  let bucketDenied = false;

  for (let at = 0; at < queue.length && !bucketDenied; at += JUDGE_BATCH_SIZE) {
    const batch = queue.slice(at, at + JUDGE_BATCH_SIZE);
    // KAD-06 / AC7: the model call takes a token from the same engine bucket capture runs draw from, so judging paces itself against them. A denied token is
    // waited on a bounded number of times; a bucket that stays closed ends the run, and what is left waits for the next job. Never a call without a token.
    let granted = false;
    for (let attempt = 1; attempt <= JUDGE_BUCKET_ATTEMPTS && !granted; attempt++) {
      const lease = await deps.bucket.tryAcquire();
      granted = lease.granted;
      if (!granted && attempt < JUDGE_BUCKET_ATTEMPTS) await sleep(Math.min(Math.max(lease.retryAfterMs, 1), JUDGE_BUCKET_MAX_WAIT_MS));
    }
    if (!granted) {
      bucketDenied = true;
      break;
    }
    modelCalls += 1;
    attempted += batch.length;
    try {
      const answers = await deps.judge.judge(batch.map((m) => m.query));
      // The port promises one verdict per query; a short or long answer is discarded whole rather than paired with the wrong matches.
      if (answers.length !== batch.length) throw new Error("wrong number of verdicts");
      batch.forEach((m, i) => verdicts.push({ mentionFactId: m.mentionFactId, capturedAt: m.capturedAt, verdict: answers[i]! }));
    } catch (error) {
      failedBatches += 1;
      // The error's NAME only: its message can quote the input.
      logger.warn({ event: "geo.name_match_judge.batch_failed", workspace_id: prepared.workspaceId, project_id: prepared.projectId, batch_size: batch.length, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { verdicts, deferred: prepared.matches.length - verdicts.length, modelCalls, attempted, failedBatches, bucketDenied };
}

/**
 * Stores the verdicts (a verdict already stored for this (match, judge version) is left alone) and gives back the part of the reservation that was never sent,
 * so the meter ends at what was ATTEMPTED. Returns how many verdict rows were written.
 */
export async function commitJudging(tx: ClientBase, prepared: JudgingPrepared, result: JudgingResult): Promise<number> {
  const unused = prepared.reserved - result.attempted;
  if (unused > 0) {
    await tx.query(
      `UPDATE name_match_judge_usage SET matches_sent = GREATEST(0, matches_sent - $1::int), updated_at = now()
        WHERE workspace_id = app.current_workspace() AND month = $2::date`,
      [unused, prepared.month],
    );
  }
  let written = 0;
  for (const v of result.verdicts) {
    const res = await tx.query(
      `INSERT INTO name_match_verdicts (id, workspace_id, project_id, mention_fact_id, captured_at, judge_version, judge_model, verdict)
       SELECT $1, p.workspace_id, p.id, $3, $4::timestamptz, $5, $6, $7
         FROM projects p WHERE p.id = $2 AND p.deleted_at IS NULL
       ON CONFLICT (mention_fact_id, judge_version) DO NOTHING`,
      [uuidV7(), prepared.projectId, v.mentionFactId, v.capturedAt, prepared.judgeVersion, prepared.judgeModel, v.verdict],
    );
    written += res.rowCount ?? 0;
    incrementCounter("nominara_geo_name_match_judged_total", { verdict: v.verdict });
  }
  return written;
}
