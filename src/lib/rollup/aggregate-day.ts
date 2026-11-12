import type { ClientBase } from "pg";
import { SCORING_VERSION } from "../scoring/index.js";

// STORY-042 — one day's facts, grouped.
//
// ⚠ THIS FILE COMPUTES NO SCORES, AND THAT IS A DEPARTURE FROM §14.
//
// `scoring-models.md` §14 writes the whole rollup as one INSERT…SELECT that
// computes `presence_rate`, `sov`, `sentiment_score`, `citation_share` and
// `visibility_score` in SQL. Implementing it that way would put a SECOND
// implementation of every formula in the product next to the first, in a
// different language, with no shared test — and STORY-041's whole purpose is
// that there is exactly one:
//
//   "All per-result metrics are computed by the pure functions in
//   `src/lib/scoring`" — tracking-engine.md Stage 6
//
// The two would drift. Worse, they would drift silently: §14's SQL and
// §3's formula are already written with different null handling, and
// `visibility_score` in SQL has no way to express STORY-041's decision to
// renormalise over the components that exist.
//
// So SQL does what SQL is for — GROUPING OVER FACT ROWS — and returns raw
// counts and sums. Every ratio and every score is computed by the scoring
// library from those counts, in `roll-up-day.ts`. The numbers are identical
// to §14's by construction, because they come from the formulas §14 is
// transcribing.

/** One (engine, entity) group for one workspace-local day. */
export interface DayAggregate {
  readonly engineKey: string;
  readonly entityType: "brand" | "competitor";
  /** The brand's is the PROJECT id — see `roll-up-day.ts`. */
  readonly entityId: string;
  readonly cellsTotal: number;
  readonly cellsPresent: number;
  readonly liveCells: number;
  /** Σ `w_e · sov(e,c)` over the day's cells, and Σ `w_e` — §2.3's two halves. */
  readonly sovWeighted: number;
  readonly weightTotal: number;
  readonly prominenceSum: number;
  readonly mentionRows: number;
  readonly rankSum: number;
  readonly rankRows: number;
  readonly mentionsTotal: number;
  readonly mentionsPositive: number;
  readonly mentionsNeutral: number;
  readonly mentionsNegative: number;
  /** Σ `prominence · sentiment_score` — §6's numerator. */
  readonly sentWeighted: number;
  readonly citationsTotal: number;
  readonly citationsOwned: number;
  readonly citationOwnedPositionWeight: number;
  readonly citationPositionWeightTotal: number;
  /** Σ `prominence · render_score` and its weight — §8, for the rendering quality. */
  readonly renderWeighted: number;
  readonly renderWeightTotal: number;
  readonly renderMentionRows: number;
}

/**
 * ⚠ ENGINES THAT CANNOT RENDER ATTRIBUTES ARE EXCLUDED FROM THE RENDERING
 * DENOMINATOR — STORY-039's AC6, and it has to be applied HERE because the
 * aggregate is per engine and the exclusion is per engine.
 *
 * Kept as SQL rather than imported from `rendering.ts` because this is a
 * query predicate; the list is asserted equal to the library's in
 * `rollup.spec.ts`, so the two cannot drift apart silently.
 */
const ATTRIBUTE_CAPABLE = "('google_ai_mode','google_aio')";

/**
 * Aggregate one project's facts for one WORKSPACE-LOCAL day.
 *
 * `AT TIME ZONE`, NEVER A FIXED OFFSET. This is the subtle correctness
 * requirement in the story: "A project in a distant timezone has a different
 * 'today' than the server, and a server-local rollup would attribute its
 * captures to the wrong day — visibly wrong on a daily chart, and invisible
 * in any test that runs in one timezone."
 *
 * `captured_at AT TIME ZONE $tz` converts the stored `timestamptz` into that
 * zone's wall clock, and `::date` takes its calendar day. A fixed offset gets
 * every ordinary day right and every DST boundary wrong, which is why the
 * story demands 23- and 25-hour day tests: they are the only ones that can
 * tell the two implementations apart.
 *
 * NO `workspace_id` PREDICATE — RLS scopes the tenant (`NFR-SEC-01`).
 */
export async function aggregateDay(
  tx: ClientBase,
  projectId: string,
  metricDate: string,
  timezone: string,
): Promise<DayAggregate[]> {
  return aggregateRange(tx, projectId, metricDate, metricDate, timezone, SCORING_VERSION);
}

/**
 * The same aggregation over a DATE RANGE, inclusive at both ends.
 *
 * STORY-136 needs it, and needs it to be THIS function rather than a
 * re-aggregation of `metric_daily`. `scoring-models.md` §3 defines every
 * component over `C(T)` — the set of cells in the timeframe — not over daily
 * rollup rows, and the two are not the same number: `PresenceRate(30d)` is
 * `Σ present / Σ total` over the window, never the mean of thirty daily
 * rates, and they differ whenever the daily cell counts differ.
 *
 * Re-deriving from `metric_daily` would also have to pass through `real`
 * columns — `avg_prominence` is the only route back to the prominence sum
 * the sentiment weighting needs — and float4 carries about seven significant
 * digits. Slice 4's success metric is a Visibility Score a customer can
 * recompute by hand from an exported cell list and match **exactly to
 * 1e-9**, which a lossy intermediate cannot deliver.
 *
 * `metric_daily` keeps its job: the per-day series a chart plots. This is the
 * window aggregate, and the facts are the only honest source for it.
 */
/**
 * What counts as a MEASUREMENT, as a SQL fragment.
 *
 * Takes the status COLUMN rather than assuming an alias, because one of the
 * two readers in this file queries `answer_captures` unaliased — and the
 * first version of the guard that was supposed to keep these in step missed
 * that copy for exactly that reason, requiring a `c.` prefix the line did not
 * have.
 *
 * ⚠ EXPORTED, AND A DENY-LIST, AND BOTH MATTER.
 *
 * Exported because `scorecards.service.ts` asks the same question when it
 * decides which engines are in the blend, and the two must agree exactly: if
 * a status counts as a measurement in the stored cross-engine rollup and not
 * in the scorecard's membership, the engine drops out of the header's blend
 * while the chart still counts it. That is a live divergence this story
 * already shipped once by a different route (the window boundary), found in
 * review, and it came back the moment two spellings of one boundary existed.
 * A review then found this one: an allow-list here and a deny-list there,
 * equal over today's five statuses and opposite in kind.
 *
 * A DENY-LIST, so a status added by a later migration counts as a measurement
 * until someone decides otherwise. That direction is deliberate: the
 * alternative silently drops real data from a published score, where this
 * one surfaces it and is visible.
 *
 * `answer_captures_status_check` permits exactly captured/parsed/skipped/
 * failed/blocked today. A sixth value is a decision about this constant.
 */
const NON_MEASUREMENT_STATUSES = ["failed", "blocked"] as const;

function statusList(): string {
  return NON_MEASUREMENT_STATUSES.map((status) => `'${status}'`).join(", ");
}

export function measurementStatusSql(statusColumn = "c.status"): string {
  return `${statusColumn} NOT IN (${statusList()})`;
}

/**
 * The complement — "this cell is NOT a measurement".
 *
 * ⚠ DERIVED FROM THE SAME ARRAY, because three places were asking this
 * question with the set written out by hand: `run-progress.ts`'s failed-cell
 * count, `capture-execute.handler.ts`'s `failedEngines`, and
 * `growth-map.service.ts`'s failure days. A review found the first copy of the
 * POSITIVE form; widening the scan that found it turned up these three of the
 * negative form.
 *
 * They are one boundary, not two: if a sixth `answer_captures.status` is ever
 * classed as a non-measurement, every one of these has to move together or a
 * cell counts as failed on the progress bar and as data in the score.
 */
export function nonMeasurementStatusSql(statusColumn = "c.status"): string {
  return `${statusColumn} IN (${statusList()})`;
}

/**
 * What counts as HAVING ANSWERED, as a SQL fragment. Takes the status column
 * for the same reason as above.
 *
 * ⚠ A DIFFERENT QUESTION FROM measurementStatusSql, AND AN ALLOW-LIST ON
 * PURPOSE — the one place in this story where an allow-list is the right
 * shape, so the reason is written down rather than assumed.
 *
 * This answers "when did this engine last produce an answer", which feeds
 * `last_captured_at`, the next-run projection and FR-CRD-09's freshness
 * claim. A status nobody has thought about must NOT silently become a "last
 * answered at": that would make a stale engine look fresh and push its next
 * run further out. Failing toward STALE is the correct bias here, and it is
 * the opposite of the bias measurementStatusSql wants — where dropping a
 * real capture out of a published score is the worse mistake.
 *
 * ⚠ A SECOND NAMED CONSTANT RATHER THAN AN EXEMPTION IN A SCANNER'S ALLOW
 * LIST. A review pointed out that an exemption leaves ONE rule plus a hole,
 * and that on a hypothetical sixth status the two predicates inside a single
 * scorecards query would disagree — the engine counted as measured for
 * scoring and never-measured for freshness, in one response. Two named rules
 * cannot drift into that; one rule plus an exemption can. It is also what
 * `matrix.service.ts` had been spelling out by hand.
 */
export function answeredStatusSql(statusColumn = "c.status"): string {
  return `${statusColumn} IN ('captured', 'parsed', 'skipped')`;
}

/**
 * "This capture's FACTS EXIST" — the only status with parsed output.
 *
 * ⚠ THE FIFTH QUESTION, AND IT USES A DIFFERENT OPERATOR, WHICH IS HOW IT
 * HID. The guard that keeps these rules from being copied scanned for `IN`
 * and `NOT IN`; `l2-semantic-reuse.ts` says `ac.status = 'parsed'`. Round
 * four's finding escaped on the alias prefix, this one on the operator — the
 * same class one dimension over, and the guard's title claimed a coverage it
 * did not have.
 *
 * It is an EQUALITY rather than an allow-list on purpose, and that is the
 * distinction worth keeping: L2 semantic reuse copies `mention_facts` from a
 * source capture, and only `parsed` has any. A sixth status would not belong
 * here even if it were a measurement and even if it had answered — it would
 * need its own facts first. So unlike the four rules above, this one does not
 * widen when the domain does.
 */
export function hasFactsStatusSql(statusColumn = "c.status"): string {
  return `${statusColumn} = 'parsed'`;
}

/**
 * "This cell produced a FRESH capture in this run" — run progress only.
 *
 * ⚠ DELIBERATELY EXCLUDES `skipped`, WHICH IS WHY IT IS NOT
 * `answeredStatusSql`. A suppressed cell HAS an answer (that is the point of
 * the cache) and counts toward freshness, but `capture_runs.skipped_cells`
 * accounts for it separately — so counting it here too would double-count it
 * in the progress bar.
 *
 * Named rather than left inline because a scan cannot tell a third question
 * from a third spelling of the same one, and the next reader cannot either.
 */
export function capturedInRunStatusSql(statusColumn = "c.status"): string {
  return `${statusColumn} IN ('captured', 'parsed')`;
}

/**
 * "This cell is a REUSED (suppressed) cell" — the L1/L2 rows the planner writes, which are `skipped` and STAY
 * `skipped` (STORY-032 AC7, owner decision 2026-10-13).
 *
 * ⚠ A SIXTH QUESTION, AND AN EQUALITY FOR THE REASON `hasFactsStatusSql`'S IS: it names one status, and a sixth
 * status would not join it. It is separate from `answeredStatusSql` (which ALSO admits captured/parsed) because
 * the re-match asks "which rows are reused", and from `capturedInRunStatusSql` because run progress deliberately
 * excludes exactly these rows — `capture_runs.skipped_cells` already counts them, so a reused row that became
 * `parsed` would be counted twice.
 */
export function reusedStatusSql(statusColumn = "c.status"): string {
  return `${statusColumn} = 'skipped'`;
}

/**
 * "This cell was never sent: we could not ask" — STORY-031. The status of a cell refused before any vendor call (a disabled
 * engine, the spend hard stop, and the engine-unavailable skips: a quota-opened breaker, a degraded engine).
 *
 * ⚠ A SEVENTH QUESTION, AND AN EQUALITY: it names exactly one status, and it is deliberately NOT `nonMeasurementStatusSql`. The
 * engine-skip refund (credits/engine-skip-refund.ts) pairs it with the skip `error_code`s, and a `failed` row can carry the same
 * code (`quota_exhausted` on the call that HIT the quota, which reached the vendor and is not refunded). Widening this to the
 * non-measurement list would refund that call too.
 */
export function blockedStatusSql(statusColumn = "c.status"): string {
  return `${statusColumn} = 'blocked'`;
}

/**
 * `scoringVersion` — STORY-136 AC9. When given, only rows stamped with that version are read: a capture, and each of
 * its mentions, written under another scoring version is not part of a score reported under this one. `null` (never
 * a default: callers say it) reads every version; the scorecards, panel and rollup pass the library's
 * current version, so a v2 row can never be summed into a v1 figure.
 */
export async function aggregateRange(
  tx: ClientBase,
  projectId: string,
  fromDate: string,
  toDate: string,
  timezone: string,
  scoringVersion: string | null,
  instants?: { readonly from: string; readonly to: string },
  /**
   * STORY-188 - restrict the cells to the member prompts of ONE topic cluster (a live prompt whose `cluster_id` is this). The same
   * query and the same scoring path as the project's figure, over a narrower set of cells: a cluster's score is never a second formula.
   */
  clusterId?: string,
): Promise<DayAggregate[]> {
  const result = await tx.query<Record<string, string | null>>(
    `WITH day_cells AS (
       SELECT c.id, c.engine_key, c.status, c.cache_layer, c.brand_present, c.sov,
              COALESCE(pe.weight, 1.0)::real AS engine_weight
         FROM answer_captures c
         -- ⚠ project_engines, NOT the entitled view, AND THAT IS DELIBERATE.
         -- STORY-152 moved the entitlement reads onto project_entitled_engines;
         -- this one stays because it is not an entitlement read. It is the
         -- WEIGHT applied to a capture that already happened, and a historical
         -- measurement must not be re-weighted — or dropped — because the plan
         -- changed afterwards. Joining the view here would silently rewrite
         -- yesterday's score on a downgrade.
         LEFT JOIN project_engines pe
                ON pe.project_id = c.project_id AND pe.engine_key = c.engine_key
        WHERE c.project_id = $1
          AND (c.captured_at AT TIME ZONE $3)::date BETWEEN $2::date AND $4::date
          -- STORY-066 AC1 — the optional [from, to) INSTANT bounds on the raw
          -- partition key. The date predicate above is an expression over
          -- captured_at and cannot prune a partition; these can, and the 24h
          -- view relies on them to touch only the one or two partitions a day
          -- spans. Unbound (NULL) for every other caller.
          AND ($6::timestamptz IS NULL OR c.captured_at >= $6::timestamptz)
          AND ($7::timestamptz IS NULL OR c.captured_at <  $7::timestamptz)
          -- A FAILED CELL IS NOT A MEASUREMENT. §2.5 excludes it from both
          -- numerator and denominator; a refusal ('parsed' with the flag) is
          -- data and stays in. The predicate is measurementStatusSql(), declared
          -- above -- see there for why it is not written out here.
          AND ${measurementStatusSql()}
          AND ($5::text IS NULL OR c.scoring_version = $5::text)
          -- STORY-188 - one topic cluster's member prompts. Unbound (NULL) for every other caller.
          AND ($8::uuid IS NULL OR c.prompt_id IN (
                SELECT tp.id FROM tracked_prompts tp
                 WHERE tp.cluster_id = $8::uuid AND tp.project_id = $1 AND tp.workspace_id = app.current_workspace() AND tp.deleted_at IS NULL))
     ),
     entities AS (
       -- Every (engine, entity) pair that appears in the range, so a
       -- competitor mentioned on one engine and not another gets a row for
       -- each — the absent one carrying cells_total and a zero share, which
       -- is §2.3's rule and the reason it cannot be a join over mentions
       -- alone.
       SELECT DISTINCT m.engine_key,
              m.entity_type,
              COALESCE(m.entity_id, $1::uuid) AS entity_id
         FROM mention_facts m
         JOIN day_cells dc ON dc.id = m.result_id
        WHERE m.entity_type IN ('brand', 'competitor')
          AND ($5::text IS NULL OR m.scoring_version = $5::text)
       UNION
       -- ⚠ THE BRAND ALWAYS HAS A ROW WHEREVER THERE ARE CELLS, mentioned or
       -- not. Found by STORY-136.
       --
       -- Derived from mentions alone, a day on which the engine answered a
       -- hundred times and named the brand in none of them produced NO BRAND
       -- ROW — so the day vanished from metric_daily entirely, and the
       -- overview would show "no data" for the single most important finding
       -- the product can report: presence rate 0.
       --
       -- That is the same conflation as the matrix's absent-versus-failed
       -- rule, one level up. "The engine answered and did not name you" is a
       -- measurement; the absence of a row says nobody asked.
       --
       -- Competitors are NOT unioned in: a competitor with no mention
       -- anywhere in the range is not being tracked in it, and inventing a
       -- zero row for every competitor on every engine would multiply the
       -- table by the competitor count for no finding.
       SELECT DISTINCT dc.engine_key, 'brand'::text AS entity_type, $1::uuid AS entity_id
         FROM day_cells dc
     ),
     per_engine AS (
       SELECT dc.engine_key,
              count(*)::int                                              AS cells_total,
              count(*) FILTER (WHERE dc.cache_layer = 'live')::int        AS live_cells,
              sum(dc.engine_weight)::double precision                     AS weight_total
         FROM day_cells dc
        GROUP BY dc.engine_key
     )
     SELECT e.engine_key,
            e.entity_type,
            e.entity_id::text,
            pe.cells_total::text,
            pe.live_cells::text,
            pe.weight_total::text,
            -- PRESENT means this entity was mentioned in the cell, not that
            -- the cell had any mention at all.
            (SELECT count(DISTINCT m.result_id) FROM mention_facts m
               JOIN day_cells dc ON dc.id = m.result_id
              WHERE dc.engine_key = e.engine_key AND m.entity_type = e.entity_type
                AND COALESCE(m.entity_id, $1::uuid) = e.entity_id
                AND ($5::text IS NULL OR m.scoring_version = $5::text))::text  AS cells_present,
            -- §2.3's numerator. answer_captures.sov is the BRAND's share,
            -- so a competitor row carries 0 here: per-entity share over a
            -- window is EPIC-08's competitive panel, not this rollup.
            (SELECT COALESCE(sum(dc.engine_weight * COALESCE(dc.sov, 0)), 0)
               FROM day_cells dc
              WHERE dc.engine_key = e.engine_key
                AND e.entity_type = 'brand')::text                        AS sov_weighted,
            agg.prominence_sum, agg.mention_rows, agg.rank_sum, agg.rank_rows,
            agg.mentions_total, agg.pos, agg.neu, agg.neg, agg.sent_weighted,
            agg.render_weighted, agg.render_weight_total, agg.render_mention_rows,
            cit.cit_total, cit.cit_owned, cit.cit_owned_pw, cit.cit_pw_total
       FROM entities e
       JOIN per_engine pe ON pe.engine_key = e.engine_key
       CROSS JOIN LATERAL (
         SELECT COALESCE(sum(m.prominence), 0)::text                       AS prominence_sum,
                count(*)::text                                             AS mention_rows,
                COALESCE(sum(m.list_position), 0)::text                     AS rank_sum,
                count(m.list_position)::text                                AS rank_rows,
                count(*)::text                                             AS mentions_total,
                count(*) FILTER (WHERE m.sentiment_label = 'positive')::text AS pos,
                count(*) FILTER (WHERE m.sentiment_label = 'neutral')::text  AS neu,
                count(*) FILTER (WHERE m.sentiment_label = 'negative')::text AS neg,
                COALESCE(sum(m.prominence * m.sentiment_score), 0)::text     AS sent_weighted,
                COALESCE(sum(m.prominence * m.render_score)
                         FILTER (WHERE m.engine_key IN ${ATTRIBUTE_CAPABLE}), 0)::text AS render_weighted,
                COALESCE(sum(m.prominence)
                         FILTER (WHERE m.engine_key IN ${ATTRIBUTE_CAPABLE}), 0)::text AS render_weight_total,
                count(*) FILTER (WHERE m.engine_key IN ${ATTRIBUTE_CAPABLE})::text     AS render_mention_rows
           FROM mention_facts m
           JOIN day_cells dc ON dc.id = m.result_id
          WHERE dc.engine_key = e.engine_key
            AND m.entity_type = e.entity_type
            AND COALESCE(m.entity_id, $1::uuid) = e.entity_id
            AND ($5::text IS NULL OR m.scoring_version = $5::text)
       ) agg
       CROSS JOIN LATERAL (
         -- Citations belong to the CELL, not to an entity, so every entity
         -- row on an engine carries the same figures. The brand's row is the
         -- one §3 reads; a competitor's is there so the panel can compare.
         SELECT count(*)::text                                              AS cit_total,
                count(*) FILTER (WHERE f.is_owned)::text                    AS cit_owned,
                COALESCE(sum(f.position_weight) FILTER (WHERE f.is_owned), 0)::text AS cit_owned_pw,
                COALESCE(sum(f.position_weight), 0)::text                   AS cit_pw_total
           FROM citation_facts f
           JOIN day_cells dc ON dc.id = f.result_id
          WHERE dc.engine_key = e.engine_key
            -- §4 — an unresolved citation is excluded from share, counted as
            -- neither owned nor foreign.
            AND f.http_status IS NOT NULL
       ) cit`,
    [projectId, fromDate, timezone, toDate, scoringVersion, instants?.from ?? null, instants?.to ?? null, clusterId ?? null],
  );

  return result.rows.map((row) => ({
    engineKey: String(row.engine_key),
    entityType: row.entity_type as "brand" | "competitor",
    entityId: String(row.entity_id),
    cellsTotal: Number(row.cells_total),
    cellsPresent: Number(row.cells_present),
    liveCells: Number(row.live_cells),
    sovWeighted: Number(row.sov_weighted),
    weightTotal: Number(row.weight_total),
    prominenceSum: Number(row.prominence_sum),
    mentionRows: Number(row.mention_rows),
    rankSum: Number(row.rank_sum),
    rankRows: Number(row.rank_rows),
    mentionsTotal: Number(row.mentions_total),
    mentionsPositive: Number(row.pos),
    mentionsNeutral: Number(row.neu),
    mentionsNegative: Number(row.neg),
    sentWeighted: Number(row.sent_weighted),
    citationsTotal: Number(row.cit_total),
    citationsOwned: Number(row.cit_owned),
    citationOwnedPositionWeight: Number(row.cit_owned_pw),
    citationPositionWeightTotal: Number(row.cit_pw_total),
    renderWeighted: Number(row.render_weighted),
    renderWeightTotal: Number(row.render_weight_total),
    renderMentionRows: Number(row.render_mention_rows),
  }));
}

/** The engine list the rendering exclusion above uses — asserted against the library's. */
export const AGGREGATE_ATTRIBUTE_CAPABLE_ENGINES: readonly string[] = ["google_ai_mode", "google_aio"];

/**
 * Which workspace-local dates a project has facts on, within a UTC range.
 *
 * Used by the rebuild path, which is handed a date range and has to know
 * which days inside it actually have anything.
 */
export async function datesWithFacts(
  tx: ClientBase,
  projectId: string,
  timezone: string,
  fromDate: string,
  toDate: string,
): Promise<string[]> {
  const result = await tx.query<{ metric_date: string }>(
    `SELECT DISTINCT to_char((captured_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS metric_date
       FROM answer_captures
      WHERE project_id = $1
        AND (captured_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
        -- ⚠ THE COPY THE FIRST VERSION OF THE GUARD MISSED. It sat 185 lines
        -- below the constant, in a file the scanner already read, and escaped
        -- on the alias prefix alone: the scan required a c. prefix and this
        -- line has none. Same question, same deny-list, and the rebuild path
        -- uses it to decide which days to re-roll -- so a divergence here
        -- rebuilds a different set of days than the aggregation measures.
        AND ${measurementStatusSql("status")}
      ORDER BY metric_date`,
    [projectId, timezone, fromDate, toDate],
  );
  return result.rows.map((row) => row.metric_date);
}
