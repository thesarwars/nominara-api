import type { ClientBase } from "pg";

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
  return aggregateRange(tx, projectId, metricDate, metricDate, timezone);
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
export async function aggregateRange(
  tx: ClientBase,
  projectId: string,
  fromDate: string,
  toDate: string,
  timezone: string,
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
          -- A FAILED CELL IS NOT A MEASUREMENT. §2.5 excludes it from both
          -- numerator and denominator; a refusal ('parsed' with the flag) is
          -- data and stays in.
          AND c.status NOT IN ('failed', 'blocked')
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
                AND COALESCE(m.entity_id, $1::uuid) = e.entity_id)::text  AS cells_present,
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
    [projectId, fromDate, timezone, toDate],
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
        AND status NOT IN ('failed', 'blocked')
      ORDER BY metric_date`,
    [projectId, timezone, fromDate, toDate],
  );
  return result.rows.map((row) => row.metric_date);
}
