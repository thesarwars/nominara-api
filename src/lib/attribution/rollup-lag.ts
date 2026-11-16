// STORY-114 AC6 / owner decision 107(c) - the attribution rollup lag objective: at most 2 hours from the newest ingested
// beacon session or citation (the ingest watermark) to its appearance, i.e. the COMMIT, in the attribution rollup.

export const ATTRIBUTION_LAG_OBJECTIVE_SECONDS = 2 * 60 * 60;

/**
 * Null when nothing has been ingested: no figure, never a 0 (a 0 would read as "perfectly fresh"). A watermark ahead of the
 * commit (clock skew between the writer and this process) is a lag of 0, never a negative one.
 */
export function attributionLagSeconds(watermarkMs: number | null, committedAtMs: number): { lagSeconds: number; withinObjective: boolean } | null {
  if (watermarkMs === null) return null;
  const lagSeconds = Math.max(0, committedAtMs - watermarkMs) / 1000;
  return { lagSeconds, withinObjective: lagSeconds <= ATTRIBUTION_LAG_OBJECTIVE_SECONDS };
}
