// STORY-032 AC14 — tracking-engine.md §6's suppression targets, measured PER
// COHORT.
//
// §6: "Overall >= 30% (alarm < 25%); the daily-cadence cohort >= 22% (alarm <
// 18%); the free cohort >= 45%. A single blended threshold would fire
// constantly against the daily cohort, whose design target is lower, while
// masking a collapse in the free cohort."
//
// That sentence names both failures of a blended number, and they point in
// opposite directions. Against the daily cohort a blended threshold is too
// STRICT — it alarms on a cohort designed to suppress less, and an alarm that
// fires constantly is one nobody reads. Against the free cohort it is too
// LOOSE — the free cohort's 45% target is well above the 30% overall, so a
// free-tier collapse from 45% to 30% moves the blended figure barely at all
// and reports healthy while the cheapest tier stops being cheap.
//
// COHORTS OVERLAP, and that is deliberate rather than sloppy. A free-plan
// project on daily cadence belongs to all three. Partitioning into disjoint
// buckets would mean each run is measured against exactly one target, and the
// free-cohort target — the strictest — would stop applying to precisely the
// runs most likely to breach it.

export type SuppressionCohort = "overall" | "daily_cadence" | "free_plan";

export interface CohortTarget {
  /** §6's design target: the rate this cohort is expected to hold. */
  readonly target: number;
  /**
   * The rate below which this cohort alarms.
   *
   * NULL for `free_plan`, and that is a RECORDED GAP rather than an
   * oversight: §6 gives the free cohort a target of 45% and states no alarm
   * threshold, while giving one for the other two. Inventing 40% here would
   * look consistent and would be a number no reference committed to — the
   * same reasoning error-details.schema.ts records for `quota_exceeded`'s
   * missing details shape. The target is still measured and still reported;
   * only the alarm is absent.
   */
  readonly alarmBelow: number | null;
}

export const SUPPRESSION_TARGETS: Readonly<Record<SuppressionCohort, CohortTarget>> = Object.freeze({
  overall: { target: 0.3, alarmBelow: 0.25 },
  daily_cadence: { target: 0.22, alarmBelow: 0.18 },
  free_plan: { target: 0.45, alarmBelow: null },
});

export interface RunCohortInput {
  /** `projects.cadence`. The schema's `hourly` and `daily` are §5's two priority cadences. */
  readonly cadence: "hourly" | "daily" | "twice_weekly" | "weekly" | "manual";
  readonly planKey: string;
}

/**
 * Every cohort this run belongs to — never exactly one.
 *
 * `overall` always applies. A run is additionally in `daily_cadence` if it
 * captures at least daily, and in `free_plan` if the workspace is on the free
 * tier. A free-plan daily project is in all three and is measured against all
 * three, which is the point.
 */
export function cohortsFor(run: RunCohortInput): SuppressionCohort[] {
  const cohorts: SuppressionCohort[] = ["overall"];
  if (run.cadence === "daily" || run.cadence === "hourly") cohorts.push("daily_cadence");
  if (run.planKey === "free") cohorts.push("free_plan");
  return cohorts;
}

export interface SuppressionMeasurement {
  readonly cohort: SuppressionCohort;
  readonly planned: number;
  readonly skipped: number;
  readonly rate: number;
  readonly meetsTarget: boolean;
  /** False whenever no alarm threshold is defined — an absent threshold never alarms. */
  readonly alarming: boolean;
}

/**
 * One cohort's suppression rate.
 *
 * A run that planned nothing has a rate of ZERO and meets no target, rather
 * than dividing by zero or being silently treated as perfect. An empty
 * measurement folded in as 100% would let a population of empty runs report
 * a healthy cache.
 */
export function measureCohort(cohort: SuppressionCohort, planned: number, skipped: number): SuppressionMeasurement {
  const targets = SUPPRESSION_TARGETS[cohort];
  const rate = planned === 0 ? 0 : skipped / planned;
  return {
    cohort,
    planned,
    skipped,
    rate,
    meetsTarget: planned > 0 && rate >= targets.target,
    alarming: targets.alarmBelow !== null && planned > 0 && rate < targets.alarmBelow,
  };
}

export interface CohortObservation extends RunCohortInput {
  readonly planned: number;
  readonly skipped: number;
}

/**
 * Measures a population of runs against every cohort each belongs to.
 *
 * The aggregate is per cohort, so a run counted in three cohorts contributes
 * its cells to all three denominators. That is the arithmetic a blended
 * figure cannot express, and the whole reason §6 asks for cohorts.
 */
export function measurePopulation(observations: readonly CohortObservation[]): SuppressionMeasurement[] {
  const totals = new Map<SuppressionCohort, { planned: number; skipped: number }>();
  for (const observation of observations) {
    for (const cohort of cohortsFor(observation)) {
      const running = totals.get(cohort) ?? { planned: 0, skipped: 0 };
      running.planned += observation.planned;
      running.skipped += observation.skipped;
      totals.set(cohort, running);
    }
  }
  return [...totals.entries()].map(([cohort, t]) => measureCohort(cohort, t.planned, t.skipped));
}
