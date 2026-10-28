// STORY-047 - every number clustering turns on, with where it comes from. None is tunable by env: a threshold that moves under
// a deploy makes two projects' clusters incomparable.

/** aux-and-geo-analysis.md (prompt clusters): "prompts grouped by embedding cosine >= 0.82". A member's cosine to its seed. */
export const CLUSTER_SIMILARITY_FLOOR = 0.82;

/**
 * The fewest members a cluster has. The reference fixes the floor but not a minimum size; two is the smallest that lets a prompt be
 * an OUTLIER at all (a minimum of one would make every prompt a cluster and the "unassigned" outcome impossible). BUILDER READING,
 * flagged for the owner in the STORY-047 report - raising it is a one-line change here and a re-run, not a migration.
 */
export const MIN_CLUSTER_SIZE = 2;

/** projects-and-prompts.md topic_clusters: "recomputed when the prompt set changes by >= 10%". */
export const MATERIAL_CHANGE_FRACTION = 0.1;

/** system-architecture.md section 4 (`topic.cluster`): "cron weekly". */
export const WEEKLY_RECOMPUTE_DAYS = 7;

/** scoring-models.md section on commercial intent: `decision` 1.00 - `consideration` 0.70 - `awareness` 0.40. Mirrored in SQL by `FUNNEL_WEIGHT_SQL`. */
export const FUNNEL_WEIGHTS = { decision: 1.0, consideration: 0.7, awareness: 0.4 } as const;

/** The same weights as a SQL expression over `funnel_stage`; a spec pins it equal to `FUNNEL_WEIGHTS`. */
export const FUNNEL_WEIGHT_SQL = "CASE funnel_stage WHEN 'decision' THEN 1.0 WHEN 'consideration' THEN 0.7 ELSE 0.4 END";

/** A bound on one project's clusters, so a pathological set cannot loop the grouping statement without end. */
export const MAX_CLUSTERS_PER_PROJECT = 200;

/** How many member prompts (nearest the group's centre) the labeller sees. */
export const LABEL_SAMPLE_SIZE = 5;

/** A label's length bound. The contract allows 120 (a user may write more); an automatic label is a short phrase. */
export const AUTO_LABEL_MAX = 80;

export const TOPIC_CLUSTER_QUEUE = "topic.cluster";
