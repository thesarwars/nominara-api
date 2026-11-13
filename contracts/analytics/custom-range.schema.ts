import { z } from "zod";

// STORY-090 AC8/AC9 (FR-OVW-03) - the custom range the Overview's filter bar offers: `timeframe=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`, on the scorecards and the
// Growth Map. The dates are WORKSPACE-LOCAL calendar days (the days the rollups are bucketed by), both inclusive.
//
// WHAT THE CONTRACT REFUSES (400, never a default): a custom range missing either date, a preset timeframe that carries a range (it would be silently
// ignored, which is how a customer ends up reading a 30-day chart believing it is the range they picked), and an inverted range. WHAT IT CANNOT KNOW is
// today's date and the plan's retention, so "in the future", "beyond retention" and "longer than a year" are the service's refusals, each with its reason.

/** The longest custom range: a year and a leap day. PROVISIONAL (not in the references): it bounds the Growth Map's one payload, whatever the plan's retention. */
export const CUSTOM_RANGE_MAX_DAYS = 366;

const customDateSchema = z.iso.date();

/** The two fields, added to a query object that also carries `timeframe`. */
export const customRangeFields = {
  from: customDateSchema.optional(),
  to: customDateSchema.optional(),
} as const;

const DAY_MS = 86_400_000;

/** Inclusive day count of `from … to` (`YYYY-MM-DD`). Pure calendar arithmetic in UTC, so no DST hour can move it. */
export function customRangeDays(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / DAY_MS) + 1;
}

/** `scoring-models.md` §13: granularity auto-selects, `>90d → week`; a custom range is no different. */
export function customRangeGranularity(days: number): "day" | "week" {
  return days > 90 ? "week" : "day";
}

/** `superRefine` body shared by every query that takes a custom range. */
export function refineCustomRange(query: { timeframe: string; from?: string | undefined; to?: string | undefined }, ctx: z.RefinementCtx): void {
  if (query.timeframe === "custom") {
    for (const key of ["from", "to"] as const) {
      if (query[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required when timeframe is custom` });
    }
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      ctx.addIssue({ code: "custom", path: ["from"], message: "from must not be after to" });
    }
    return;
  }
  for (const key of ["from", "to"] as const) {
    if (query[key] !== undefined) ctx.addIssue({ code: "custom", path: [key], message: `${key} is only valid with timeframe=custom` });
  }
}
