import type { ClientBase } from "pg";
import { CUSTOM_RANGE_MAX_DAYS, customRangeDays } from "../../../contracts/analytics/custom-range.schema.js";
import { ValidationFailedError } from "../../api/errors/domain-errors.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { resolveWorkspaceRetention, type RetentionWindow } from "../../workers/rollup/retention.js";

// STORY-090 AC9 (FR-OVW-03) - "a custom range is bounded by plan retention, with out-of-range dates disabled and explained, never silently clamped".
//
// A range the plan cannot serve is a 400 that says why and names the boundary; it is NEVER trimmed to what fits, because a chart that quietly shows fewer days
// than were asked for is believed to be the range the customer picked. The bound is the rollup window IN FORCE (`resolveWorkspaceRetention`: while a
// retention-shortening deferral runs it is the longer of the two windows, so a read and the sweep cannot disagree about which side a day is on). Both the
// scorecards and the Growth Map read the rollup layer, so `retention.rollups_days` is the right window for both.

const DAY_MS = 86_400_000;

export type CustomRangeRefusal =
  | { readonly reason: "in_future"; readonly field: "to"; readonly today: string }
  | { readonly reason: "beyond_retention"; readonly field: "from"; readonly earliest_allowed: string; readonly retention_days: number }
  | { readonly reason: "too_long"; readonly field: "to"; readonly max_days: number };

/** The window in days, or null where nothing is ever purged (a plan with no rollup window, or an unlimited one). */
export function retentionDaysOf(window: RetentionWindow): number | null {
  return typeof window === "number" ? window : null;
}

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);
}

/** Pure judgement of one range against the workspace-local `today` and the retention window. The first problem in a fixed order: future, retention, length. */
export function judgeCustomRange(input: { readonly from: string; readonly to: string; readonly today: string; readonly retentionDays: number | null }): CustomRangeRefusal | null {
  if (input.to > input.today) return { reason: "in_future", field: "to", today: input.today };
  if (input.retentionDays !== null) {
    const earliest = shiftDays(input.today, -input.retentionDays);
    if (input.from < earliest) return { reason: "beyond_retention", field: "from", earliest_allowed: earliest, retention_days: input.retentionDays };
  }
  if (customRangeDays(input.from, input.to) > CUSTOM_RANGE_MAX_DAYS) return { reason: "too_long", field: "to", max_days: CUSTOM_RANGE_MAX_DAYS };
  return null;
}

function messageFor(refusal: CustomRangeRefusal): string {
  switch (refusal.reason) {
    case "in_future":
      return `to cannot be after today (${refusal.today})`;
    case "beyond_retention":
      return `from is before your plan's retention: the earliest day available is ${refusal.earliest_allowed} (${String(refusal.retention_days)} days)`;
    case "too_long":
      return `a custom range covers at most ${String(refusal.max_days)} days`;
  }
}

/**
 * Throws the 400 (`validation_failed`, one issue naming the field and the boundary) for a range the workspace cannot be served. `timezone` is the project's
 * workspace's, so "today" is the day the rollups are bucketed by. Runs inside the request's tenant transaction (RLS scopes the workspace row).
 */
export async function assertCustomRangeAllowed(
  tx: ClientBase,
  workspaceId: string,
  timezone: string,
  range: { readonly from: string; readonly to: string },
  surface: string,
): Promise<void> {
  const today = (await tx.query<{ today: string }>("SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today", [timezone])).rows[0]!.today;
  const retention = await resolveWorkspaceRetention(tx, workspaceId);
  const refusal = judgeCustomRange({ ...range, today, retentionDays: retentionDaysOf(retention.rollupsDays) });
  if (refusal === null) {
    incrementCounter("nominara_analytics_custom_range_reads_total", { surface, outcome: "served" });
    return;
  }
  incrementCounter("nominara_analytics_custom_range_reads_total", { surface, outcome: refusal.reason });
  throw new ValidationFailedError({ message: messageFor(refusal), details: { issues: [{ path: [refusal.field], message: messageFor(refusal) }] } });
}
