import { createHash } from "node:crypto";
import type { ClientBase } from "pg";
import type { GeneratedTaskInput } from "../../modules/tasks/tasks.service.js";
import type { AliasEntry } from "./entity-matcher.js";

// STORY-036 AC9 - candidate competitor discovery's rolling count, flag and task. `tracking-engine.md` Stage 2: capitalised multi-token
// phrases in list positions that are not known entities are recorded as entity_type = 'other' (the matcher does that); "with a rolling
// 30-day count. Crossing 10 occurrences raises a candidate_competitor_detected flag and generates a discovery task."

/** The reference's constants, verbatim. */
export const CANDIDATE_THRESHOLD = 10;
export const CANDIDATE_WINDOW_DAYS = 30;
/** Carried on the capture's own `flags` (an open string list in the contract), like `highlights_withheld_normalizer_stale`. */
export const CANDIDATE_FLAG = "candidate_competitor_detected";

/** A task title is bounded by `TASK_TITLE_MAX` in the contract; the label is engine text and is cut rather than trusted. */
const LABEL_MAX = 80;

export interface CandidateSignal {
  readonly key: string;
  /** As first written in an answer. Engine text: never logged, shown only to the customer who owns the project. */
  readonly label: string;
  /** Distinct captures in the window that listed it. */
  readonly seenCount: number;
}

/** Case and whitespace folded. The SQL below computes the same expression, so a key from either side compares equal. */
export function candidateKey(label: string): string {
  return label.replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * The untracked candidates THIS capture lists whose rolling count has reached the threshold.
 *
 * WHAT IS COUNTED: distinct captures (cells), not raw occurrences. The reference's own example reads "Pipedrive appeared in 14 of 90 cells in
 * the last 30 days" (api-specification s6), and an answer that lists a name three times is one observation of it, not three. Reported as a
 * decision to confirm, because the AC text says "occurrences".
 *
 * THE WINDOW ENDS AT THE CAPTURE'S OWN TIME, not at now(), so a re-parse of the same capture gives the same answer, and the lower bound is
 * what lets the planner prune partitions. A candidate that has since been added as a tracked alias is dropped: its old 'other' rows are
 * history, and it is no longer a discovery.
 *
 * Runs on the parse transaction AFTER this capture's facts are written, so the count includes this capture.
 */
export async function candidatesCrossingThreshold(
  tx: ClientBase,
  input: { projectId: string; resultId: string; capturedAt: Date; tracked: readonly AliasEntry[] },
): Promise<CandidateSignal[]> {
  const found = await tx.query<{ key: string; label: string; seen: number }>(
    `WITH mine AS (
       SELECT DISTINCT lower(btrim(regexp_replace(entity_label, '\\s+', ' ', 'g'))) AS key
         FROM mention_facts
        WHERE result_id = $2 AND entity_type = 'other'
     )
     SELECT lower(btrim(regexp_replace(f.entity_label, '\\s+', ' ', 'g'))) AS key,
            min(f.entity_label) AS label,
            count(DISTINCT f.result_id)::int AS seen
       FROM mention_facts f
      WHERE f.project_id = $1
        AND f.entity_type = 'other'
        AND f.captured_at <= $3::timestamptz
        AND f.captured_at > $3::timestamptz - interval '30 days'
        AND lower(btrim(regexp_replace(f.entity_label, '\\s+', ' ', 'g'))) IN (SELECT key FROM mine)
      GROUP BY 1`,
    [input.projectId, input.resultId, input.capturedAt],
  );

  const tracked = new Set(input.tracked.flatMap((entry) => [candidateKey(entry.alias), candidateKey(entry.label)]));
  return found.rows
    .filter((row) => row.seen >= CANDIDATE_THRESHOLD && !tracked.has(row.key))
    .map((row) => ({ key: row.key, label: row.label, seenCount: row.seen }))
    .sort((a, b) => b.seenCount - a.seenCount || a.key.localeCompare(b.key));
}

/**
 * The discovery task, for `TasksService.createGeneratedTask`.
 *
 * ONE PER PROJECT AND CANDIDATE: the fingerprint holds no count, so a candidate seen 14 times and then 15 times is the same open task. The
 * 30-day cooldown stops a dismissed task being re-created by the very next capture that lists the same name. `monitoring` because the
 * action is a decision (track it or not), not content, technical or authority work. `rule_code` is null, as the displacement recovery
 * plan's tasks are: this is not a catalog rule.
 */
export function discoveryTaskInput(projectId: string, signal: CandidateSignal): GeneratedTaskInput {
  const label = signal.label.length > LABEL_MAX ? `${signal.label.slice(0, LABEL_MAX)}...` : signal.label;
  return {
    projectId,
    kind: "monitoring",
    origin: "auto",
    ruleCode: null,
    fingerprint: createHash("sha256").update(`candidate_competitor_detected|${projectId}|${candidateKey(signal.key)}`, "utf8").digest(),
    title: `Review ${label}: listed in AI answers but not tracked`,
    description:
      `${label} appeared in ${String(signal.seenCount)} captured answers in the last ${String(CANDIDATE_WINDOW_DAYS)} days in a list of options, ` +
      "and is not one of your tracked competitors. Decide whether to track it.",
    sourceDisplacementId: null,
    sourceDomainId: null,
    affectedUrl: null,
    cooldownDays: CANDIDATE_WINDOW_DAYS,
  };
}
