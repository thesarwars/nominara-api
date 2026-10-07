import type { ClientBase } from "pg";
import {
  type AnswerFormValue,
  type GeoDataSource,
  type GeoAnalysisWrite,
  type GeoFinding,
  type GeoStructureDetail,
  type PositionClassValue,
} from "../../../contracts/analytics/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { SCORING_VERSION } from "../scoring/index.js";

// STORY-060 — A3 answer structure: the form of the answers engines give, and
// where the brand sits inside them, from columns the parser already writes
// (`mention_facts.answer_form`, `.position_class`). Free and unmetered; no
// engine, embedding provider or crawl is touched.
//
// WHAT IS DELIBERATELY NOT HERE: the structure-match gap (a table-dominant
// cluster against a brand page with neither table nor spec list). It needs the
// brand's page, and no page crawl exists. The verdict is therefore always
// `no_action`, with that reason stated, and `page_forms`/`template` are empty.
// A gap asserted without the page would be a fabricated finding.

/** product-spec §A3 / geo-insights catalogue: "30 parsed answers in the window." */
export const STRUCTURE_MIN_ANSWERS = 30;

/** Display order for forms and position classes; also the tie-break for the dominant form. */
const FORM_ORDER: readonly AnswerFormValue[] = ["ranked_list", "comparison_table", "single_recommendation", "neutral_enumeration", "narrative"];
const CLASS_ORDER: readonly PositionClassValue[] = ["recommendation", "ranked", "neutral_list", "also_consider", "caveat"];
const FORM_LABEL: Readonly<Record<AnswerFormValue, string>> = {
  ranked_list: "Ranked list",
  comparison_table: "Comparison table",
  single_recommendation: "Single recommendation",
  neutral_enumeration: "Neutral enumeration",
  narrative: "Narrative",
};

/** The engine marker the STORY-169 demo seed stamps on every capture it writes. */
export const DEMO_NORMALIZER_VERSION = "demo-seed";

export const NO_PAGE_CRAWL_REASON =
  "No page crawl exists for this project, so the structure-match gap cannot be assessed against the brand's page. No gap is asserted.";

export interface StructureInput {
  windowStart: string;
  windowDays: 7 | 30 | 90;
  rootDomain: string;
  /** Distinct answers per engine and form in the window. */
  forms: { engine: string; dataSource: GeoDataSource; form: AnswerFormValue; answers: number }[];
  /** Distinct answers per position class of the brand's first mention, current window. */
  position: { cls: PositionClassValue; answers: number }[];
  /** The same, for the window of equal length immediately before. */
  priorPosition: { cls: PositionClassValue; answers: number }[];
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const pct = (x: number): string => `${String(Math.round(x * 100))}%`;

function formCounts(rows: { form: AnswerFormValue; answers: number }[]): { form: AnswerFormValue; count: number }[] {
  return FORM_ORDER.map((form) => ({ form, count: rows.filter((r) => r.form === form).reduce((n, r) => n + r.answers, 0) }));
}

/** Pure: the persisted row and the read detail from one aggregate, so they cannot disagree. */
export function buildStructure(input: StructureInput): { write: GeoAnalysisWrite; detail: GeoStructureDetail | null } {
  const total = input.forms.reduce((n, r) => n + r.answers, 0);
  const base = { analysis: "structure" as const, window_start: input.windowStart, window_days: input.windowDays, score: null, score_label: null };

  if (total < STRUCTURE_MIN_ANSWERS) {
    return {
      write: {
        ...base,
        evidence_cells: total,
        evidence_passages: 0,
        sufficient: false,
        suppression_reason: `Needs ${String(STRUCTURE_MIN_ANSWERS)} parsed answers with a classified form in the window; this window has ${String(total)}.`,
        findings: [],
        lever_rank: null,
      },
      detail: null,
    };
  }

  const forms = formCounts(input.forms);
  // First maximum in FORM_ORDER wins a tie, so the result never depends on input order.
  const dominant = forms.reduce((best, cur) => (cur.count > best.count ? cur : best));

  const engineKeys = [...new Set(input.forms.map((r) => r.engine))].sort();
  const engines = engineKeys.map((engine) => {
    const rows = input.forms.filter((r) => r.engine === engine);
    return {
      engine,
      // Any demo row taints the engine's numbers: 'live' is only claimed when nothing is seeded.
      data_source: (rows.some((r) => r.dataSource === "demo") ? "demo" : "live") as GeoDataSource,
      total: rows.reduce((n, r) => n + r.answers, 0),
      forms: formCounts(rows),
    };
  });

  const brandAnswers = input.position.reduce((n, r) => n + r.answers, 0);
  const priorAnswers = input.priorPosition.reduce((n, r) => n + r.answers, 0);
  const share = (rows: StructureInput["position"], denom: number, cls: PositionClassValue): number =>
    round4(rows.filter((r) => r.cls === cls).reduce((n, r) => n + r.answers, 0) / denom);
  // Absent is not zero: with no brand answer there is no distribution at all.
  const position =
    brandAnswers === 0
      ? []
      : CLASS_ORDER.map((cls) => ({
          cls,
          share: share(input.position, brandAnswers, cls),
          prior: priorAnswers === 0 ? null : share(input.priorPosition, priorAnswers, cls),
        }));

  const rec = position.find((p) => p.cls === "recommendation");
  const movement =
    rec === undefined
      ? ""
      : rec.prior === null
        ? ` The brand sits in the recommendation clause in ${pct(rec.share)} of its answers (no prior window to compare).`
        : ` The brand's recommendation-clause share moved from ${pct(rec.prior)} to ${pct(rec.share)}.`;

  const detail: GeoStructureDetail = {
    slug: "structure",
    forms,
    total,
    dominant_form: dominant.form,
    engines,
    page_forms: [],
    brand_answers: brandAnswers,
    prior_brand_answers: priorAnswers,
    position,
    template: null,
    rationale: NO_PAGE_CRAWL_REASON,
  };

  const finding: GeoFinding = {
    id: "structure-dominant-form",
    severity: "info",
    headline: `${FORM_LABEL[dominant.form]} is the dominant answer form (${pct(dominant.count / total)} of ${String(total)} answers).${movement}`,
    detail: NO_PAGE_CRAWL_REASON,
    // The only page this analysis can point at is the one it could not assess.
    evidence: [{ url: `https://${input.rootDomain}/`, snippet: "No page crawl: the page's answer forms could not be assessed." }],
    metric: { name: "dominant_form_share", value: round4(dominant.count / total) },
    no_action: true,
    // The detail rides on the finding so a read returns the stored row's own aggregate.
    structure: detail,
  };

  return {
    write: {
      ...base,
      evidence_cells: total,
      evidence_passages: 0,
      sufficient: true,
      suppression_reason: null,
      findings: [finding],
      lever_rank: null,
    },
    detail,
  };
}

/** The window of `days` ending on `asOf` (UTC date, inclusive): its first day as `YYYY-MM-DD`. */
export function windowStartFor(asOf: Date, days: number): string {
  const d = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

interface FormRow {
  engine_key: string;
  answer_form: AnswerFormValue;
  answers: number;
  has_demo: boolean;
}
interface ClassRow {
  position_class: PositionClassValue;
  answers: number;
}

/**
 * Reads the window's facts. Must run inside the ambient tenant transaction: RLS
 * is the guarantee, the `project_id` filter is for the planner.
 */
export async function loadStructureInput(
  tx: ClientBase,
  projectId: string,
  windowStart: string,
  windowDays: 7 | 30 | 90,
): Promise<StructureInput> {
  const project = await tx.query<{ root_domain: string }>("SELECT root_domain FROM projects WHERE id = $1 AND deleted_at IS NULL", [projectId]);
  if (project.rows[0] === undefined) throw new NotFoundError({ message: "no such project" });

  // Window bounds are UTC midnights, whatever the session timezone is.
  const forms = await tx.query<FormRow>(
    `SELECT mf.engine_key, mf.answer_form, count(DISTINCT mf.result_id)::int AS answers,
            bool_or(ac.normalizer_version = $4) AS has_demo
       FROM mention_facts mf
       JOIN answer_captures ac ON ac.id = mf.result_id AND ac.captured_at = mf.captured_at
      WHERE mf.project_id = $1
        AND mf.captured_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
        AND mf.captured_at <  ($2::date::timestamp AT TIME ZONE 'UTC') + make_interval(days => $3)
        AND mf.answer_form IS NOT NULL AND mf.scoring_version = $5
      GROUP BY mf.engine_key, mf.answer_form`,
    [projectId, windowStart, windowDays, DEMO_NORMALIZER_VERSION, SCORING_VERSION],
  );

  // The brand's FIRST mention in each answer decides its position class.
  const positionIn = async (offsetDays: number): Promise<ClassRow[]> =>
    (
      await tx.query<ClassRow>(
        `SELECT position_class, count(*)::int AS answers
           FROM (SELECT DISTINCT ON (result_id) result_id, position_class
                   FROM mention_facts
                  WHERE project_id = $1 AND entity_type = 'brand' AND scoring_version = $5
                    AND captured_at >= ($2::date::timestamp AT TIME ZONE 'UTC') - make_interval(days => $4)
                    AND captured_at <  ($2::date::timestamp AT TIME ZONE 'UTC') - make_interval(days => $4) + make_interval(days => $3)
                  ORDER BY result_id, occurrence_index, char_start) first_mention
          GROUP BY position_class`,
        [projectId, windowStart, windowDays, offsetDays, SCORING_VERSION],
      )
    ).rows;

  return {
    windowStart,
    windowDays,
    rootDomain: project.rows[0].root_domain,
    forms: forms.rows.map((r) => ({
      engine: r.engine_key,
      dataSource: r.has_demo ? "demo" : "live",
      form: r.answer_form,
      answers: r.answers,
    })),
    position: (await positionIn(0)).map((r) => ({ cls: r.position_class, answers: r.answers })),
    priorPosition: (await positionIn(windowDays)).map((r) => ({ cls: r.position_class, answers: r.answers })),
  };
}
