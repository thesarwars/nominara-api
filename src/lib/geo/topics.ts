import type { ClientBase } from "pg";
import type { GeoAnalysisWrite, GeoFinding, GeoTopicsDetail } from "../../../contracts/analytics/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { clamp01, presenceRate, SCORING_VERSION, shareOfVoice, type Cell } from "../scoring/index.js";
import { ALIGNMENT } from "./alignment/constants.js";
import { hasFactsStatusSql } from "../rollup/aggregate-day.js";
import { DEMO_NORMALIZER_VERSION } from "./structure.js";

// STORY-061 - A5 topical authority (scoring-models.md section 10), persisted. Free and unmetered; it reads `topic_clusters`,
// `answer_captures`, `mention_facts`, `geo_alignments` and `semantic_nodes` and touches no engine, embedding provider or crawl.
//
//   authority(b, t)  = SoV(b, t) . presence_rate(b, t)          SoV is section 2's: an absent entity adds 0 to the numerator and its
//                                                               weight to the denominator, and `Other` entities are in the denominator
//   ownership(t)     = argmax_k authority(k, t) over every tracked entity (ties: the brand, then the label)
//   gap_priority(t)  = commercial_intent(t) . (authority(leader, t) - authority(b, t)) . achievability(t)
//   achievability(t) = 1 - clamp01((target_alignment - current_alignment(t)) / 0.30)
//
// A TOPIC THE BRAND HAS NO BASIS TO WIN IS NEVER RECOMMENDED. Achievability is null (not 0) when no alignment was measured, and a
// null or sub-minimum achievability is never recommended: the guard fails closed.
//
// BUILDER READINGS, because the reference leaves them open (carried to the owner):
//   - current_alignment(t) is the brand's best-aligned analysed page for the cluster (`geo_alignments.current_alignment`, else the
//     baseline); target_alignment is that row's empirical band floor (`target_band_low`, the p50 of the cited documents).
//   - "the minimum" is 0.5, the `topic_gap_high` alert's own achievability floor (scoring-models.md section 15).
//   - A gap TASK is raised for the top decile of gap_priority (the same section 15 row), at least one topic.

/** product-spec catalogue: "30 parsed answers across at least 2 topics." */
export const TOPIC_MIN_ANSWERS = 30;
export const TOPIC_MIN_TOPICS = 2;
/** scoring-models.md section 15, `topic_gap_high`: `achievability >= 0.5`. */
export const TOPIC_MIN_ACHIEVABILITY = 0.5;
/** scoring-models.md section 10: the divisor of the alignment shortfall. */
export const ACHIEVABILITY_SPAN = 0.3;
export const TOPIC_TOP_DECILE = 0.1;
export const TOPIC_TASK_RULE = "TG-TOPIC-CONTENT";
const CONCEPTS_PER_GAP = 5;
/** Customer copy never carries the raw `answer_form` enum. */
const ANSWER_FORM_LABEL: Record<string, string> = {
  ranked_list: "a ranked list",
  comparison_table: "a comparison table",
  single_recommendation: "a single recommendation",
  neutral_enumeration: "a neutral list",
  narrative: "a narrative",
};

export interface TopicEntity {
  /** Stable key a cell's entities refer to. */
  key: string;
  type: "brand" | "competitor";
  label: string;
}

export interface TopicCellInput {
  engineWeight: number;
  /** Every entity detected in the answer, tracked or not: an untracked one is in the SoV denominator only. */
  entities: { key: string; prominence: number }[];
}

export interface TopicInput {
  clusterId: string;
  label: string;
  commercialIntent: number;
  cells: TopicCellInput[];
  currentAlignment: number | null;
  targetAlignment: number | null;
  requiredConcepts: { phrase: string; nodeType: string; corpusDocRatio: number; evidenceUrl: string; evidenceSnippet: string }[];
  structure: string | null;
}

export interface TopicsGeoInput {
  windowStart: string;
  windowDays: 7 | 30 | 90;
  rootDomain: string;
  dataSource: "live" | "demo" | "mixed" | null;
  entities: TopicEntity[];
  topics: TopicInput[];
}

/** `null` when either alignment is unmeasured: unknown is not zero. */
export function achievability(current: number | null, target: number | null): number | null {
  if (current === null || target === null) return null;
  return 1 - clamp01((target - current) / ACHIEVABILITY_SPAN);
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Pure: the persisted row and the read detail from one aggregate, so they cannot disagree. */
export function buildTopics(input: TopicsGeoInput): { write: GeoAnalysisWrite; detail: GeoTopicsDetail | null } {
  const base = { analysis: "topics" as const, window_start: input.windowStart, window_days: input.windowDays, score: null, score_label: null };
  const live = input.topics.filter((t) => t.cells.length > 0);
  const answers = live.reduce((n, t) => n + t.cells.length, 0);

  if (answers < TOPIC_MIN_ANSWERS || live.length < TOPIC_MIN_TOPICS) {
    return {
      write: {
        ...base,
        evidence_cells: answers,
        evidence_passages: 0,
        sufficient: false,
        suppression_reason: `Needs ${String(TOPIC_MIN_ANSWERS)} parsed answers across at least ${String(TOPIC_MIN_TOPICS)} topics; this window has ${String(answers)} across ${String(live.length)} topic${live.length === 1 ? "" : "s"}.`,
        findings: [],
        lever_rank: null,
      },
      detail: null,
    };
  }

  const tracked = input.entities.filter((e) => e.type === "brand" || e.type === "competitor");
  const brand = tracked.find((e) => e.type === "brand");
  if (brand === undefined) throw new RangeError("topical authority needs the brand among the tracked entities");

  const rows = live.map((t) => {
    const authorities = tracked.map((e) => {
      const cells: Cell[] = t.cells.map((c) => {
        const denominator = c.entities.reduce((s, x) => s + x.prominence, 0);
        const mine = c.entities.filter((x) => x.key === e.key).reduce((m, x) => Math.max(m, x.prominence), 0);
        return { status: "answered", engineWeight: c.engineWeight, sov: denominator > 0 ? mine / denominator : 0, brandPresent: mine > 0 };
      });
      const sov = shareOfVoice(cells) ?? 0;
      const presence = presenceRate(cells) ?? 0;
      return { entity: e, sov, presence, authority: sov * presence };
    });
    // argmax; ties go to the brand, then to the label, so input order never decides.
    const ranked = [...authorities].sort(
      (a, b) => b.authority - a.authority || (a.entity.type === "brand" ? -1 : 0) - (b.entity.type === "brand" ? -1 : 0) || byText(a.entity.label, b.entity.label),
    );
    const owner = ranked[0]!;
    const mine = authorities.find((a) => a.entity.type === "brand")!;
    const ach = achievability(t.currentAlignment, t.targetAlignment);
    const gap = ach === null ? null : t.commercialIntent * Math.max(0, owner.authority - mine.authority) * ach;
    return { t, authorities, owner, mine, ach, gap };
  });

  // Top decile of gap_priority over the topics that have one; at least one topic.
  const withGap = rows.filter((r) => r.gap !== null).sort((a, b) => b.gap! - a.gap! || byText(a.t.label, b.t.label) || byText(a.t.clusterId, b.t.clusterId));
  const decile = new Set(withGap.slice(0, Math.max(1, Math.ceil(withGap.length * TOPIC_TOP_DECILE))).map((r) => r.t.clusterId));

  const verdict = (r: (typeof rows)[number]): { recommended: boolean; reason: string | null } => {
    if (r.owner.entity.type === "brand") return { recommended: false, reason: "The brand already holds the highest authority in this topic." };
    if (r.ach === null) return { recommended: false, reason: "No alignment has been measured for this topic, so whether the brand can win it is unknown; it is not recommended." };
    if (r.ach < TOPIC_MIN_ACHIEVABILITY) {
      return { recommended: false, reason: `Achievability ${r.ach.toFixed(2)} is under the ${String(TOPIC_MIN_ACHIEVABILITY)} minimum: the brand's content is too far from what the cited documents look like to win this topic.` };
    }
    if (r.gap === null || r.gap <= 0) return { recommended: false, reason: "There is no authority gap to close in this topic." };
    if (!decile.has(r.t.clusterId)) return { recommended: false, reason: "A winnable gap, but outside the top decile of gap priority; it is not asked for yet." };
    return { recommended: true, reason: null };
  };

  const topicRows = rows
    .map((r) => {
      const v = verdict(r);
      const row = (a: (typeof r.authorities)[number]): GeoTopicsDetail["topics"][number]["owner"] => ({
        entity_type: a.entity.type,
        entity_label: a.entity.label,
        sov: round(a.sov),
        presence_rate: round(a.presence),
        authority: round(a.authority),
      });
      return {
        raw: r,
        recommended: v.recommended,
        row: {
          cluster_id: r.t.clusterId,
          label: r.t.label,
          answers: r.t.cells.length,
          commercial_intent: r.t.commercialIntent,
          owner: row(r.owner),
          brand_authority: round(r.mine.authority),
          authorities: [...r.authorities].sort((a, b) => b.authority - a.authority || byText(a.entity.label, b.entity.label)).map(row),
          current_alignment: r.t.currentAlignment,
          target_alignment: r.t.targetAlignment,
          achievability: r.ach,
          gap_priority: r.gap,
          recommended: v.recommended,
          not_recommended_reason: v.reason,
        },
      };
    })
    .sort((a, b) => (b.row.gap_priority ?? -1) - (a.row.gap_priority ?? -1) || byText(a.row.label, b.row.label) || byText(a.row.cluster_id, b.row.cluster_id));

  const gaps = topicRows
    .filter((x) => x.recommended)
    .map((x) => ({
      cluster_id: x.raw.t.clusterId,
      label: x.raw.t.label,
      required_concepts: [...x.raw.t.requiredConcepts]
        .sort((a, b) => b.corpusDocRatio - a.corpusDocRatio || byText(a.phrase, b.phrase))
        .slice(0, CONCEPTS_PER_GAP)
        .map((c) => ({ phrase: c.phrase, node_type: c.nodeType, corpus_doc_ratio: c.corpusDocRatio })),
      structure: x.raw.t.structure,
    }));

  const detail: GeoTopicsDetail = {
    slug: "topics",
    data_source: input.dataSource,
    answers,
    min_achievability: TOPIC_MIN_ACHIEVABILITY,
    topics: topicRows.map((x) => x.row),
    gaps,
  };

  const rootEvidence = [{ url: `https://${input.rootDomain}/`, snippet: "Topical authority over the project's topic clusters." }];
  let findings: GeoFinding[];
  const recommended = topicRows.filter((x) => x.recommended);
  if (recommended.length === 0) {
    const winnable = topicRows.some((x) => x.row.achievability !== null && x.row.achievability >= TOPIC_MIN_ACHIEVABILITY && x.row.gap_priority !== null && x.row.gap_priority > 0);
    findings = [
      {
        id: "topics-no-gap",
        severity: "info",
        headline: winnable
          ? "No winnable topic gap is in the top decile of gap priority right now."
          : "No topic is both behind a competitor and winnable on the brand's current alignment, so none is recommended.",
        evidence: rootEvidence,
        no_action: true,
        topics: detail,
      },
    ];
  } else {
    findings = recommended.map((x, i) => {
      const gap = gaps.find((g) => g.cluster_id === x.raw.t.clusterId)!;
      const concepts = gap.required_concepts.map((c) => c.phrase);
      const evidence = x.raw.t.requiredConcepts
        .filter((c) => gap.required_concepts.some((g) => g.phrase === c.phrase))
        .slice(0, 3)
        .map((c) => ({ url: c.evidenceUrl, snippet: c.evidenceSnippet, corpus_doc_ratio: c.corpusDocRatio }));
      return {
        id: `topic-gap-${x.raw.t.clusterId}`,
        severity: "medium" as const,
        headline:
          `Create content for "${x.raw.t.label}", where ${x.row.owner.entity_label} leads (authority ${x.row.owner.authority.toFixed(2)} against the brand's ${x.row.brand_authority.toFixed(2)}).` +
          (concepts.length > 0 ? ` Cover: ${concepts.join(", ")}.` : "") +
          (gap.structure === null ? "" : ` Structure it as ${ANSWER_FORM_LABEL[gap.structure] ?? gap.structure.replaceAll("_", " ")}.`),
        evidence: evidence.length > 0 ? evidence : rootEvidence,
        metric: { name: "gap_priority", value: x.row.gap_priority ?? 0 },
        task_rule_code: TOPIC_TASK_RULE,
        ...(i === 0 ? { topics: detail } : {}),
      };
    });
  }

  return { write: { ...base, evidence_cells: answers, evidence_passages: 0, sufficient: true, suppression_reason: null, findings, lever_rank: null }, detail };
}

interface ClusterRow {
  id: string;
  label: string;
  commercial_intent: number;
}
interface CellRow {
  cluster_id: string;
  result_id: string;
  engine_weight: number;
  is_demo: boolean;
  entities: { key: string; type: string; label: string; prominence: number }[] | null;
}

/**
 * Reads the window's facts. Must run inside the ambient tenant transaction: RLS is the guarantee, the `project_id` filter is for the
 * planner. A cell is a parsed answer to a prompt that belongs to a cluster; a prompt in no cluster is in no topic.
 */
export async function loadTopicsInput(tx: ClientBase, projectId: string, windowStart: string, windowDays: 7 | 30 | 90): Promise<TopicsGeoInput> {
  const project = await tx.query<{ root_domain: string; name: string }>("SELECT root_domain, name FROM projects WHERE id = $1 AND deleted_at IS NULL", [projectId]);
  if (project.rows[0] === undefined) throw new NotFoundError({ message: "no such project" });

  const clusters = await tx.query<ClusterRow>(
    "SELECT id, label, commercial_intent::float8 AS commercial_intent FROM topic_clusters WHERE project_id = $1 ORDER BY id",
    [projectId],
  );

  // One row per answer, with every entity detected in it (prominence = the max over its mentions, section 2.1).
  const cells = await tx.query<CellRow>(
    `SELECT tp.cluster_id, ac.id AS result_id, COALESCE(pe.weight, 1.0)::float8 AS engine_weight,
            (ac.normalizer_version = $4) AS is_demo,
            (SELECT json_agg(json_build_object('key', e.key, 'type', e.entity_type, 'label', e.label, 'prominence', e.prominence))
               FROM (SELECT CASE mf.entity_type WHEN 'brand' THEN 'brand' ELSE COALESCE(mf.entity_id::text, 'label:' || lower(mf.entity_label)) END AS key,
                            mf.entity_type, max(mf.entity_label) AS label, max(mf.prominence)::float8 AS prominence
                       FROM mention_facts mf
                      WHERE mf.result_id = ac.id AND mf.captured_at = ac.captured_at AND mf.project_id = $1 AND mf.scoring_version = $5
                      GROUP BY 1, mf.entity_type) e) AS entities
       FROM answer_captures ac
       JOIN tracked_prompts tp ON tp.id = ac.prompt_id AND tp.project_id = $1 AND tp.deleted_at IS NULL AND tp.cluster_id IS NOT NULL
       LEFT JOIN project_engines pe ON pe.project_id = $1 AND pe.engine_key = ac.engine_key
      WHERE ac.project_id = $1 AND ${hasFactsStatusSql("ac.status")}
        AND ac.captured_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
        AND ac.captured_at <  ($2::date::timestamp AT TIME ZONE 'UTC') + make_interval(days => $3)`,
    [projectId, windowStart, windowDays, DEMO_NORMALIZER_VERSION, SCORING_VERSION],
  );

  const competitors = await tx.query<{ id: string; name: string }>("SELECT id, name FROM competitors WHERE project_id = $1 AND deleted_at IS NULL ORDER BY lower(name), id", [projectId]);
  const entities = new Map<string, TopicEntity>([["brand", { key: "brand", type: "brand", label: project.rows[0].name }]]);
  for (const c of competitors.rows) entities.set(c.id, { key: c.id, type: "competitor", label: c.name });
  // Tracked = the brand and the LIVE competitors (section 10: "over all tracked entities"). A soft-deleted competitor's mentions still
  // sit in the window; they are in the SoV denominator (section 2) and never a candidate for ownership or a listed row.

  // The brand's best-aligned analysed page per cluster; the empirical band floor is the target.
  const alignments = await tx.query<{ prompt_cluster_id: string; current: number | null; target: number | null }>(
    `SELECT DISTINCT ON (prompt_cluster_id) prompt_cluster_id,
            COALESCE(current_alignment, baseline_alignment)::float8 AS current, target_band_low::float8 AS target
       FROM geo_alignments
      WHERE project_id = $1 AND prompt_cluster_id IS NOT NULL AND target_band_low IS NOT NULL
        AND COALESCE(current_alignment, baseline_alignment) IS NOT NULL
      ORDER BY prompt_cluster_id, COALESCE(current_alignment, baseline_alignment) DESC, id`,
    [projectId],
  );
  const alignmentOf = new Map(alignments.rows.map((a) => [a.prompt_cluster_id, a]));

  const nodes = await tx.query<{ prompt_cluster_id: string; phrase: string; node_type: string; corpus_doc_ratio: number; evidence_url: string; evidence_snippet: string }>(
    `SELECT prompt_cluster_id, phrase, node_type, corpus_doc_ratio::float8 AS corpus_doc_ratio, evidence_url, evidence_snippet
       FROM semantic_nodes
      WHERE project_id = $1 AND prompt_cluster_id IS NOT NULL AND collapsed_into_id IS NULL AND corpus_doc_ratio >= $2
      ORDER BY prompt_cluster_id, corpus_doc_ratio DESC, phrase`,
    [projectId, ALIGNMENT.minDocRatio],
  );

  const forms = await tx.query<{ cluster_id: string; answer_form: string }>(
    `SELECT DISTINCT ON (tp.cluster_id) tp.cluster_id, mf.answer_form
       FROM mention_facts mf
       JOIN tracked_prompts tp ON tp.id = mf.prompt_id AND tp.project_id = $1 AND tp.cluster_id IS NOT NULL
      WHERE mf.project_id = $1 AND mf.answer_form IS NOT NULL AND mf.scoring_version = $4
        AND mf.captured_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
        AND mf.captured_at <  ($2::date::timestamp AT TIME ZONE 'UTC') + make_interval(days => $3)
      GROUP BY tp.cluster_id, mf.answer_form
      ORDER BY tp.cluster_id, count(DISTINCT mf.result_id) DESC, mf.answer_form`,
    [projectId, windowStart, windowDays, SCORING_VERSION],
  );
  const formOf = new Map(forms.rows.map((f) => [f.cluster_id, f.answer_form]));

  const demo = cells.rows.filter((r) => r.is_demo).length;
  return {
    windowStart,
    windowDays,
    rootDomain: project.rows[0].root_domain,
    // Nothing measured is null, never "demo".
    dataSource: cells.rows.length === 0 ? null : demo > 0 && demo < cells.rows.length ? "mixed" : demo > 0 ? "demo" : "live",
    entities: [...entities.values()],
    topics: clusters.rows.map((c) => {
      const a = alignmentOf.get(c.id);
      return {
        clusterId: c.id,
        label: c.label,
        commercialIntent: c.commercial_intent,
        cells: cells.rows
          .filter((r) => r.cluster_id === c.id)
          .map((r) => ({ engineWeight: r.engine_weight, entities: (r.entities ?? []).map((e) => ({ key: e.key, prominence: e.prominence })) })),
        currentAlignment: a?.current ?? null,
        targetAlignment: a?.target ?? null,
        requiredConcepts: nodes.rows
          .filter((n) => n.prompt_cluster_id === c.id)
          .map((n) => ({ phrase: n.phrase, nodeType: n.node_type, corpusDocRatio: n.corpus_doc_ratio, evidenceUrl: n.evidence_url, evidenceSnippet: n.evidence_snippet })),
        structure: formOf.get(c.id) ?? null,
      };
    }),
  };
}
