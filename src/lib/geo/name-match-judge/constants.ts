import type { ContextWindow } from "../entity.js";

// STORY-191 - the judge's bounds. None of these is a reference constant: scoring-models.md section 10 names the 30-match minimum and nothing
// about how a match is judged. Every number here is a BUILDER READING for the owner to confirm, stated once.

/** The prompt/schema revision. Part of the judge version, so editing the instruction is a re-judge. */
export const NAME_MATCH_PROMPT_VERSION = "name-match-v1";

/** AC6: the span plus this much text each side is all that is sent to the model, never the whole answer. */
export const JUDGE_WINDOW: ContextWindow = { before: 120, after: 60 };

/** Matches per model call: one batched request, the naturaliser's shape. */
export const JUDGE_BATCH_SIZE = 20;

/** One job judges at most this many matches (a project's backlog drains over the next days' jobs, never in one unbounded run). */
export const JUDGE_MAX_PER_JOB = 200;

/**
 * PROVISIONAL - OWNER TO SET. The most matches the model may judge for ONE workspace in one UTC calendar month (owner decision 99c: "a per-workspace
 * monthly cap, provisional value, marked in code for the owner"). 2,000 matches is 100 batched calls a month; at a Flash-class price that is a few
 * cents, far below any plan's price, but it is a guess. Matches over the cap stay `unjudged` (outside the risk denominator) until the month turns.
 * Counted from stored verdicts, so it needs no counter of its own.
 */
export const NAME_MATCH_JUDGE_MONTHLY_CAP = 2_000;

/** A denied engine-bucket token is retried this many times (the wait between is the bucket's own `retryAfterMs`, bounded below) before the run stops. */
export const JUDGE_BUCKET_ATTEMPTS = 3;
export const JUDGE_BUCKET_MAX_WAIT_MS = 10_000;

/** Only matches this recent are judged: the longest window the GEO analyses read. */
export const JUDGE_LOOKBACK_DAYS = 90;
