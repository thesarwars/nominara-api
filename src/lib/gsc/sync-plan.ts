// STORY-115 S1/S2/S6 - which days one sync job pulls. The ONLY place a calendar date enters the integration.
//
// Search Console data lags the calendar by two to three days, so "today" is never available: the frontier a job may reach is today
// minus `GSC_DATA_LAG_DAYS` (the upper end of the documented lag), and that is the date stored as `last_sync_date` and shown to the
// customer. Nothing else in the integration reads a clock; the spec beside this file asserts it.
//
// BACKFILL AND INCREMENTAL ARE ONE LOOP over one watermark. With no `last_sync_date` the loop starts `GSC_BACKFILL_MONTHS` back and
// advances `GSC_SLICE_DAYS` per job, committing the watermark after each slice, so an interrupted backfill resumes where it stopped.
// With a watermark it starts `GSC_RESYNC_WINDOW_DAYS - 1` days before it, so the days whose figures may still have been revised are
// pulled again (late-arriving source data), and runs to the frontier. The watermark is one per connection, not one per dimension: both
// reports advance together or not at all.

/** The upper end of "the data lags 2-3 days". */
export const GSC_DATA_LAG_DAYS = 3;
/** Days (the watermark day included) re-pulled each run: figures within the lag may still change. */
export const GSC_RESYNC_WINDOW_DAYS = 3;
/** The retention limit: 16 months on first connect. */
export const GSC_BACKFILL_MONTHS = 16;
/** Days one job pulls. A bound, so a job is short and a backfill is many resumable jobs. */
export const GSC_SLICE_DAYS = 31;

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const moved = new Date(Date.UTC(year!, month! - 1 + months, 1));
  const lastDay = new Date(Date.UTC(moved.getUTCFullYear(), moved.getUTCMonth() + 1, 0)).getUTCDate();
  moved.setUTCDate(Math.min(day!, lastDay));
  return moved.toISOString().slice(0, 10);
}

/** The last day Search Console can be asked about, given `today` (`YYYY-MM-DD`, UTC). */
export function availableThrough(today: string): string {
  return addDays(today, -GSC_DATA_LAG_DAYS);
}

export interface SlicePlan {
  readonly from: string;
  readonly to: string;
  /** True while the first catch-up has not reached the frontier. */
  readonly backfill: boolean;
  /** True when this slice stops short of the frontier: another job is needed. */
  readonly more: boolean;
}

/** The next slice, or `null` when the stored watermark is already past the frontier (nothing may be pulled). */
export function planSlice(input: { readonly today: string; readonly lastSyncDate: string | null }): SlicePlan | null {
  const frontier = availableThrough(input.today);
  const backfill = input.lastSyncDate === null;
  const from = backfill ? addMonths(input.today, -GSC_BACKFILL_MONTHS) : addDays(input.lastSyncDate!, -(GSC_RESYNC_WINDOW_DAYS - 1));
  if (from > frontier) return null;
  const sliceEnd = addDays(from, GSC_SLICE_DAYS - 1);
  const to = sliceEnd < frontier ? sliceEnd : frontier;
  return { from, to, backfill, more: to < frontier };
}
