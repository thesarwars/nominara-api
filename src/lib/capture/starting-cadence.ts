import type { ProjectCadence } from "./dispatch-cells.js";

// Owner decision 2026-10-09 pm #2 — a project's starting cadence comes from
// the workspace plan's `scan.cadence` entitlement, mapped onto the values the
// `projects.cadence` CHECK allows (hourly, daily, twice_weekly, weekly,
// manual):
//
//   weekly          -> weekly         (Starter)
//   twice_weekly    -> twice_weekly   (Growth)
//   daily_priority  -> daily          (Business; the priority subset is a
//                                      scope concern, not a wake frequency)
//   hourly_priority -> daily          (Enterprise: CAPPED at daily until the
//                                      hourly tier exists)
//
// Absent, null or unrecognised -> weekly, the column's own DEFAULT and the
// slowest scheduled cadence: an unknown entitlement must not buy extra runs.
const CADENCE_FOR_ENTITLEMENT: Readonly<Record<string, ProjectCadence>> = {
  weekly: "weekly",
  twice_weekly: "twice_weekly",
  daily: "daily",
  daily_priority: "daily",
  hourly: "daily",
  hourly_priority: "daily",
};

export const DEFAULT_STARTING_CADENCE: ProjectCadence = "weekly";

export function startingCadenceFor(scanCadence: unknown): ProjectCadence {
  if (typeof scanCadence !== "string") return DEFAULT_STARTING_CADENCE;
  return CADENCE_FOR_ENTITLEMENT[scanCadence] ?? DEFAULT_STARTING_CADENCE;
}
