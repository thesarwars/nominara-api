import type { ClientBase } from "pg";
import {
  type DataSource,
  type GeoAnalysisWrite,
  type GeoFinding,
  type GeoSentimentDetail,
  type SentimentMention,
} from "../../../contracts/analytics/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import {
  NEGATIVE_ALERT_MIN_CELLS,
  NEGATIVE_CELL_RATE_ALERT,
  NEGATIVE_CELL_RATE_RISE_ALERT,
  negativeSentimentRose,
  SCORING_VERSION,
  shouldAlertOnNegativeSentiment,
} from "../scoring/index.js";
import { hasFactsStatusSql } from "../rollup/aggregate-day.js";
import { DEMO_NORMALIZER_VERSION } from "./structure.js";

// STORY-061 — A6 sentiment drivers: which non-positive brand mentions exist,
// the sentence each rests on, and the source the framing traces to, from
// columns the parser already writes (`mention_facts.evidence_*`,
// `.negative_reasons`, `citation_facts`). Free and unmetered; no engine,
// embedding provider or crawl is touched.
//
// WHAT IS DELIBERATELY NOT HERE
//  - A contradiction against the brand's own verified structured data. None
//    exists to compare with, so `factual_error` is false WITH A REASON on
//    every mention. A claim is never guessed to be wrong.
//  - A task. The task engine makes it (the `geo_finding` condition reads the finding): each reason class is one finding, and
//    a finding asks for a task ONLY on a CROSSING (owner decision 22): the section 6 level (negative cell rate >= 0.05 with n >= 30)
//    AND the section 15 rise (up >= 0.03 on the prior window, which meets its own n >= 30), so a quiet or chronic window raises none.
//    Themes are trended against the prior window. Never on demo data (owner decision 23): the analysis is shown, labelled, and asks for nothing.
//  - `negative_source_url_hash`: the parser does not write it. The citation a
//    framing traces to is the slot nearest the evidence span, located in the
//    stored answer text; where it cannot be located it is null, never guessed.

/** product-spec §A6 / geo-insights catalogue: "30 mentions of the brand in the window." */
export const SENTIMENT_MIN_MENTIONS = 30;
/** The mentions the detail lists (most recent first). Counts and clusters always cover all of them. */
export const SENTIMENT_LISTED_MENTIONS = 50;
export const SENTIMENT_TASK_RULE = "TG-SENTIMENT-REASON";

export const NO_VERIFIED_DATA_REASON =
  "No verified structured data exists for this brand to compare the claim against, so no factual error is asserted.";

const MAX_EVIDENCE_TEXT = 280;

export interface SentimentMentionInput {
  resultId: string;
  engine: string;
  capturedAt: string;
  label: "neutral" | "negative";
  evidenceStart: number;
  evidenceEnd: number;
  /** The capture's answer text; null when it is no longer held. */
  text: string | null;
  reasons: string[];
  /** Every citation slot of the same answer. */
  citations: { slotIndex: number; url: string; domain: string }[];
}

export interface SentimentInput {
  windowStart: string;
  windowDays: 7 | 30 | 90;
  rootDomain: string;
  /** All brand mentions in the window (the evidence base), whatever their sentiment. */
  brandMentions: number;
  /** null: nothing was measured. */
  dataSource: DataSource | null;
  /** Non-positive brand mentions that carry an evidence span. */
  mentions: SentimentMentionInput[];
  /** `C(T)`: parsed answers in the window, and those with any negative brand mention (section 6's `negative_cell_rate`). */
  cells: number;
  negativeCells: number;
  /** The same two for the prior window of equal length. */
  priorCells: number;
  priorNegativeCells: number;
  /** Prior-window non-positive brand mentions by primary reason class. */
  priorReasonCounts: Record<string, number>;
}

const REASON_LABEL: Readonly<Record<string, string>> = {
  performance_caveat: "a performance caveat",
  outdated_pricing: "outdated pricing",
  missing_feature: "a missing feature",
  complexity_complaint: "a complexity complaint",
  support_complaint: "a support complaint",
  security_concern: "a security concern",
  pricing_objection: "a pricing objection",
  migration_difficulty: "migration difficulty",
  complaint_thread_cited: "a cited complaint thread",
  deprecated_product_reference: "a deprecated product reference",
  factual_error: "a factual error claim",
};
const reasonLabel = (reason: string): string => REASON_LABEL[reason] ?? reason.replace(/_/g, " ");

/**
 * The citation slot nearest the span. A slot is located by finding its URL in
 * the answer text (the parser keeps slot order, not offsets); one that is not
 * in the text cannot be placed and is not a candidate. Distance is 0 inside the
 * span; ties go to the lower slot.
 */
function nearestCitation(x: SentimentMentionInput): SentimentMention["citation"] {
  if (x.text === null) return null;
  let best: { slot: SentimentMentionInput["citations"][number]; distance: number } | null = null;
  for (const slot of x.citations) {
    const at = x.text.indexOf(slot.url);
    if (at === -1) continue;
    const end = at + slot.url.length;
    const distance = end < x.evidenceStart ? x.evidenceStart - end : at > x.evidenceEnd ? at - x.evidenceEnd : 0;
    if (best === null || distance < best.distance || (distance === best.distance && slot.slotIndex < best.slot.slotIndex)) best = { slot, distance };
  }
  return best === null ? null : { slot_index: best.slot.slotIndex, url: best.slot.url, domain: best.slot.domain };
}

function toMention(x: SentimentMentionInput): SentimentMention {
  const text = x.text === null ? null : x.text.slice(x.evidenceStart, x.evidenceEnd).slice(0, MAX_EVIDENCE_TEXT);
  return {
    result_id: x.resultId,
    engine: x.engine,
    captured_at: x.capturedAt,
    label: x.label,
    evidence_start: x.evidenceStart,
    evidence_end: x.evidenceEnd,
    evidence_text: text === null || text.length === 0 ? null : text,
    cues: [...x.reasons],
    // Null, not a made-up class, when the parser found none.
    reason: x.reasons[0] ?? null,
    factual_error: false,
    factual_error_reason: NO_VERIFIED_DATA_REASON,
    citation: nearestCitation(x),
  };
}

/** Pure: the persisted row and the read detail from one aggregate, so they cannot disagree. */
export function buildSentiment(input: SentimentInput): { write: GeoAnalysisWrite; detail: GeoSentimentDetail | null } {
  const base = { analysis: "sentiment" as const, window_start: input.windowStart, window_days: input.windowDays, score: null, score_label: null };

  if (input.brandMentions < SENTIMENT_MIN_MENTIONS) {
    return {
      write: {
        ...base,
        evidence_cells: input.brandMentions,
        evidence_passages: 0,
        sufficient: false,
        suppression_reason: `Needs ${String(SENTIMENT_MIN_MENTIONS)} mentions of the brand in the window; this window has ${String(input.brandMentions)}.`,
        findings: [],
        lever_rank: null,
      },
      detail: null,
    };
  }

  const all = input.mentions.map(toMention);

  // Clusters group by the originating domain of the traced citation.
  const byDomain = new Map<string, { count: number; engines: Set<string>; reasons: Set<string> }>();
  for (const x of all) {
    if (x.citation === null) continue;
    const c = byDomain.get(x.citation.domain) ?? { count: 0, engines: new Set<string>(), reasons: new Set<string>() };
    c.count += 1;
    c.engines.add(x.engine);
    if (x.reason !== null) c.reasons.add(x.reason);
    byDomain.set(x.citation.domain, c);
  }
  // A cluster spanning engines is ranked first; then size; then domain, so input order never decides.
  const clusters = [...byDomain.entries()]
    .map(([domain, c]) => ({
      domain,
      mention_count: c.count,
      engine_count: c.engines.size,
      engines: [...c.engines].sort(),
      reasons: [...c.reasons].sort(),
    }))
    .sort((a, b) => b.engine_count - a.engine_count || b.mention_count - a.mention_count || a.domain.localeCompare(b.domain));

  // One reason class per distinct primary reason; each becomes one task rule.
  const byReason = new Map<string, number>();
  for (const x of all) if (x.reason !== null) byReason.set(x.reason, (byReason.get(x.reason) ?? 0) + 1);
  const reasonClasses = [...byReason.entries()]
    .map(([reason, mention_count]) => ({
      reason,
      mention_count,
      task_title: `Address ${reasonLabel(reason)} in how engines describe the brand`,
      // null: the prior window held no parsed answer, so nothing was measured. 0: it was measured and the theme was absent.
      prior_mention_count: input.priorCells === 0 ? null : (input.priorReasonCounts[reason] ?? 0),
    }))
    .sort((a, b) => b.mention_count - a.mention_count || a.reason.localeCompare(b.reason));

  const recentFirst = [...all].sort((a, b) => (a.captured_at < b.captured_at ? 1 : a.captured_at > b.captured_at ? -1 : a.result_id < b.result_id ? 1 : -1));

  const level = shouldAlertOnNegativeSentiment(input.cells, input.negativeCells);
  const rose = negativeSentimentRose(input.cells, input.negativeCells, input.priorCells, input.priorNegativeCells);
  const crossed = level && rose;

  const detail: GeoSentimentDetail = {
    slug: "sentiment",
    data_source: input.dataSource,
    brand_mentions: input.brandMentions,
    non_positive_mentions: all.length,
    unattributed_mentions: all.filter((x) => x.citation === null).length,
    mentions: recentFirst.slice(0, SENTIMENT_LISTED_MENTIONS),
    clusters,
    reason_classes: reasonClasses,
    factual_error_reason: NO_VERIFIED_DATA_REASON,
    threshold: {
      cells: input.cells,
      negative_cells: input.negativeCells,
      negative_cell_rate: input.cells === 0 ? null : input.negativeCells / input.cells,
      prior_negative_cell_rate: input.priorCells === 0 ? null : input.priorNegativeCells / input.priorCells,
      rate_threshold: NEGATIVE_CELL_RATE_ALERT,
      prior_cells: input.priorCells,
      rise_threshold: NEGATIVE_CELL_RATE_RISE_ALERT,
      min_cells: NEGATIVE_ALERT_MIN_CELLS,
      rose,
      crossed,
    },
  };
  // Owner decision 23: any demo data in the window (or nothing measured) is analysed and labelled, and never asks for a task.
  const asksForTasks = crossed && input.dataSource === "live";

  const rootEvidence = (snippet: string) => [{ url: `https://${input.rootDomain}/`, snippet }];
  const evidenceFor = (mention: SentimentMention | undefined, fallback: string): GeoFinding["evidence"] =>
    mention === undefined
      ? rootEvidence(fallback)
      : [
          {
            url: mention.citation?.url ?? `https://${input.rootDomain}/`,
            snippet: mention.evidence_text ?? `Evidence span ${String(mention.evidence_start)}-${String(mention.evidence_end)} (answer text no longer held).`,
          },
        ];

  const top = clusters[0];
  const topNote =
    top === undefined
      ? ""
      : ` Most of it traces to ${top.domain} (${String(top.mention_count)} mention${top.mention_count === 1 ? "" : "s"} across ${String(top.engine_count)} engine${top.engine_count === 1 ? "" : "s"}).`;

  let findings: GeoFinding[];
  if (reasonClasses.length === 0) {
    findings = [
      {
        id: "sentiment-no-reason-class",
        severity: "info",
        headline:
          all.length === 0
            ? "No non-positive brand mention carries an evidence span in this window."
            : `${String(all.length)} non-positive brand mention${all.length === 1 ? "" : "s"}, none with a discernible reason class.${topNote}`,
        detail: "A reason is only reported when the parser found one; none is inferred.",
        evidence: evidenceFor(recentFirst[0], "No non-positive mention in the window."),
        metric: { name: "non_positive_mentions", value: all.length },
        no_action: true,
        sentiment: detail,
      },
    ];
  } else {
    findings = reasonClasses.map((rc, i) => ({
      id: `sentiment-reason-${rc.reason}`,
      severity: crossed ? ("medium" as const) : ("low" as const),
      headline: `${String(rc.mention_count)} ${rc.mention_count === 1 ? "mention frames" : "mentions frame"} the brand through ${reasonLabel(rc.reason)}.` + (i === 0 ? topNote : ""),
      evidence: evidenceFor(recentFirst.find((x) => x.reason === rc.reason), "No evidence span."),
      metric: { name: "reason_class_mentions", value: rc.mention_count },
      // One task per reason class, and only on a live crossing: a theme under it (or on demo data) is reported, not assigned.
      ...(asksForTasks ? { task_rule_code: SENTIMENT_TASK_RULE } : { no_action: true as const }),
      // The detail rides on the finding that speaks for the analysis, once.
      ...(i === 0 ? { sentiment: detail } : {}),
    }));
  }

  return {
    write: {
      ...base,
      evidence_cells: input.brandMentions,
      evidence_passages: 0,
      sufficient: true,
      suppression_reason: null,
      findings,
      lever_rank: null,
    },
    detail,
  };
}

interface CellCountRow {
  cells: number;
  negative_cells: number;
  demo_cells: number;
}
interface PriorReasonRow {
  reason: string;
  mentions: number;
}
interface BrandCountRow {
  brand_mentions: number;
  demo: number;
  live: number;
}
interface MentionRow {
  result_id: string;
  engine_key: string;
  captured_at: Date;
  sentiment_label: "neutral" | "negative";
  evidence_start: number;
  evidence_end: number;
  negative_reasons: string[];
  text: string | null;
}
interface CitationRow {
  result_id: string;
  slot_index: number;
  raw_url: string;
  domain: string;
}

function dataSourceOf(brandMentions: number, demo: number, live: number): DataSource | null {
  if (brandMentions === 0) return null;
  return demo > 0 && live > 0 ? "mixed" : demo > 0 ? "demo" : "live";
}

/**
 * Reads the window's facts. Must run inside the ambient tenant transaction: RLS
 * is the guarantee, the `project_id` filter is for the planner. Window bounds
 * are UTC midnights, whatever the session timezone is.
 */
export async function loadSentimentInput(
  tx: ClientBase,
  projectId: string,
  windowStart: string,
  windowDays: 7 | 30 | 90,
): Promise<SentimentInput> {
  const project = await tx.query<{ root_domain: string }>("SELECT root_domain FROM projects WHERE id = $1 AND deleted_at IS NULL", [projectId]);
  if (project.rows[0] === undefined) throw new NotFoundError({ message: "no such project" });

  const window = (alias: string): string =>
    `${alias}.captured_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
        AND ${alias}.captured_at <  ($2::date::timestamp AT TIME ZONE 'UTC') + make_interval(days => $3)`;

  const counts = await tx.query<BrandCountRow>(
    `SELECT count(*)::int AS brand_mentions,
            (count(*) FILTER (WHERE ac.normalizer_version = $4))::int AS demo,
            (count(*) FILTER (WHERE ac.normalizer_version <> $4))::int AS live
       FROM mention_facts mf
       JOIN answer_captures ac ON ac.id = mf.result_id AND ac.captured_at = mf.captured_at
      WHERE mf.project_id = $1 AND mf.entity_type = 'brand' AND mf.scoring_version = $5 AND ${window("mf")}`,
    [projectId, windowStart, windowDays, DEMO_NORMALIZER_VERSION, SCORING_VERSION],
  );
  const c = counts.rows[0]!;

  // No sentiment verdict without the sentence that caused it: a mention with no span is not a driver.
  const mentions = await tx.query<MentionRow>(
    `SELECT mf.result_id, mf.engine_key, mf.captured_at, mf.sentiment_label, mf.evidence_start, mf.evidence_end,
            mf.negative_reasons, ac.payload ->> 'text' AS text
       FROM mention_facts mf
       JOIN answer_captures ac ON ac.id = mf.result_id AND ac.captured_at = mf.captured_at
      WHERE mf.project_id = $1 AND mf.entity_type = 'brand' AND mf.scoring_version = $4
        AND mf.sentiment_label <> 'positive'
        AND mf.evidence_start IS NOT NULL AND mf.evidence_end IS NOT NULL
        AND ${window("mf")}
      ORDER BY mf.captured_at DESC, mf.result_id, mf.occurrence_index`,
    [projectId, windowStart, windowDays, SCORING_VERSION],
  );

  // C(T): parsed answers, and those with any negative brand mention. Offset 0 is the window, offset `windowDays` the prior window.
  const cellCounts = async (offsetDays: number): Promise<CellCountRow> =>
    (
      await tx.query<CellCountRow>(
        `SELECT count(*)::int AS cells,
                (count(*) FILTER (WHERE ac.normalizer_version = $6))::int AS demo_cells,
                (count(*) FILTER (WHERE EXISTS (
                   SELECT 1 FROM mention_facts mf
                    WHERE mf.result_id = ac.id AND mf.captured_at = ac.captured_at AND mf.project_id = $1
                      AND mf.entity_type = 'brand' AND mf.sentiment_label = 'negative' AND mf.scoring_version = $5)))::int AS negative_cells
           FROM answer_captures ac
          WHERE ac.project_id = $1 AND ${hasFactsStatusSql("ac.status")}
            AND ac.captured_at >= ($2::date::timestamp AT TIME ZONE 'UTC') - make_interval(days => $4)
            AND ac.captured_at <  ($2::date::timestamp AT TIME ZONE 'UTC') - make_interval(days => $4) + make_interval(days => $3)`,
        [projectId, windowStart, windowDays, offsetDays, SCORING_VERSION, DEMO_NORMALIZER_VERSION],
      )
    ).rows[0]!;
  const now = await cellCounts(0);
  const prior = await cellCounts(windowDays);
  const priorReasons = await tx.query<PriorReasonRow>(
    `SELECT mf.negative_reasons[1] AS reason, count(*)::int AS mentions
       FROM mention_facts mf
       JOIN answer_captures ac ON ac.id = mf.result_id AND ac.captured_at = mf.captured_at AND ac.project_id = $1 AND ${hasFactsStatusSql("ac.status")}
      WHERE mf.project_id = $1 AND mf.entity_type = 'brand' AND mf.scoring_version = $5
        AND mf.sentiment_label <> 'positive' AND mf.evidence_start IS NOT NULL AND mf.evidence_end IS NOT NULL
        AND cardinality(mf.negative_reasons) > 0
        AND mf.captured_at >= ($2::date::timestamp AT TIME ZONE 'UTC') - make_interval(days => $4)
        AND mf.captured_at <  ($2::date::timestamp AT TIME ZONE 'UTC') - make_interval(days => $4) + make_interval(days => $3)
      GROUP BY 1`,
    [projectId, windowStart, windowDays, windowDays, SCORING_VERSION],
  );

  const resultIds = [...new Set(mentions.rows.map((r) => r.result_id))];
  const citations =
    resultIds.length === 0
      ? []
      : (
          await tx.query<CitationRow>(
            `SELECT cf.result_id, cf.slot_index, cf.raw_url, cf.domain
               FROM citation_facts cf
              WHERE cf.project_id = $1 AND cf.result_id = ANY($4::uuid[]) AND ${window("cf")}`,
            [projectId, windowStart, windowDays, resultIds],
          )
        ).rows;
  const slotsByResult = new Map<string, SentimentMentionInput["citations"]>();
  for (const r of citations) {
    const list = slotsByResult.get(r.result_id) ?? [];
    list.push({ slotIndex: r.slot_index, url: r.raw_url, domain: r.domain });
    slotsByResult.set(r.result_id, list);
  }

  return {
    windowStart,
    windowDays,
    rootDomain: project.rows[0].root_domain,
    brandMentions: c.brand_mentions,
    cells: now.cells,
    negativeCells: now.negative_cells,
    priorCells: prior.cells,
    priorNegativeCells: prior.negative_cells,
    priorReasonCounts: Object.fromEntries(priorReasons.rows.map((r) => [r.reason, r.mentions])),
    // Nothing measured is null, never "demo".
    // Demo is judged on the window's mentions AND its parsed answers (a demo answer that never named the brand is still demo data).
    dataSource: dataSourceOf(c.brand_mentions, c.demo + now.demo_cells, c.live + (now.cells - now.demo_cells)),
    mentions: mentions.rows.map((r) => ({
      resultId: r.result_id,
      engine: r.engine_key,
      capturedAt: r.captured_at.toISOString(),
      label: r.sentiment_label,
      evidenceStart: r.evidence_start,
      evidenceEnd: r.evidence_end,
      text: r.text,
      reasons: r.negative_reasons,
      citations: slotsByResult.get(r.result_id) ?? [],
    })),
  };
}
