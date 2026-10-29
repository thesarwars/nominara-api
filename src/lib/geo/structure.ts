import type { ClientBase } from "pg";
import {
  type AnswerFormValue,
  type GeoAnalysisWrite,
  type GeoFinding,
  type GeoStructureCluster,
  type GeoStructureDetail,
  type PositionClassValue,
} from "../../../contracts/analytics/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { dataSourceOf } from "../analytics/data-source.js";
import { SCORING_VERSION } from "../scoring/index.js";

// STORY-060 — A3 answer structure: the form of the answers engines give, and
// where the brand sits inside them, from columns the parser already writes
// (`mention_facts.answer_form`, `.position_class`). Free and unmetered; no
// engine, embedding provider or crawl is touched.
//
// The structure-match gap (a table-dominant cluster against a brand page with
// neither table nor spec list) needs the brand's page. `StructureInput.pages`
// carries what the document model (STORY-050) found on it; while the loader
// has no page source it is null, and then the verdict is `no_action` with that
// reason stated and `page_forms`/`template` empty. A gap asserted without the
// page would be a fabricated finding, so "no pages" never fires one.

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

/** What the AUX document model found on one of the brand's own pages (`ContentBlock.tables` / `.lists`, summed over the page). */
export interface StructurePage {
  url: string;
  tables: number;
  lists: { ordered: number; unordered: number; definition: number };
}

/** One page's forms from its document model (STORY-050): the blocks' tables and lists, summed over the page. Pure. */
export function structurePageFrom(doc: { url: string; blocks: readonly { tables: number; lists: StructurePage["lists"] }[] }): StructurePage {
  const lists = { ordered: 0, unordered: 0, definition: 0 };
  let tables = 0;
  for (const b of doc.blocks) {
    tables += b.tables;
    lists.ordered += b.lists.ordered;
    lists.unordered += b.lists.unordered;
    lists.definition += b.lists.definition;
  }
  return { url: doc.url, tables, lists };
}

/**
 * BUILDER PROPOSAL: the task rule a structure-match gap generates a task through. Like `TG-ENTITY-ALIAS`, it is in no reference
 * and is not yet a `task_generation_rules` row, so `openGeoTasks` cannot resolve a task for it until the owner approves it.
 */
export const STRUCTURE_TASK_RULE = "TG-STRUCTURE-TEMPLATE";

export interface StructureInput {
  windowStart: string;
  windowDays: 7 | 30 | 90;
  rootDomain: string;
  /** Distinct answers per engine and form in the window. */
  forms: {
    engine: string;
    dataSource: "live" | "demo";
    form: AnswerFormValue;
    answers: number;
    /** The prompt's topic cluster (STORY-040 AC8); absent or null when the prompt belongs to none. */
    cluster?: { id: string; label: string } | null;
  }[];
  /** Distinct answers per position class of the brand's first mention, current window. */
  position: { cls: PositionClassValue; answers: number }[];
  /** The same, for the window of equal length immediately before. */
  priorPosition: { cls: PositionClassValue; answers: number }[];
  /**
   * The brand's own assessed pages. `null`/absent/empty means NOT ASSESSED (no page source, or a crawl that fetched
   * nothing) and never means "a page with no table": a gap is only asserted against a page that was actually read.
   */
  pages?: readonly StructurePage[] | null;
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const pct = (x: number): string => `${String(Math.round(x * 100))}%`;

function formCounts(rows: { form: AnswerFormValue; answers: number }[]): { form: AnswerFormValue; count: number }[] {
  return FORM_ORDER.map((form) => ({ form, count: rows.filter((r) => r.form === form).reduce((n, r) => n + r.answers, 0) }));
}

/**
 * STORY-040 AC8 — one entry per prompt cluster (plus one for unclustered prompts), each with its form counts, its
 * engines, and a dominant form only when the cluster itself has `STRUCTURE_MIN_ANSWERS` answers.
 * Largest first, then by id with the unclustered entry last, so the order never depends on input order.
 */
function clusterDistributions(rows: StructureInput["forms"]): GeoStructureCluster[] {
  const groups = new Map<string | null, { label: string | null; rows: StructureInput["forms"] }>();
  for (const row of rows) {
    const id = row.cluster?.id ?? null;
    const group = groups.get(id) ?? { label: row.cluster?.label ?? null, rows: [] };
    group.rows.push(row);
    groups.set(id, group);
  }
  return [...groups.entries()]
    .map(([id, group]) => {
      const total = group.rows.reduce((n, r) => n + r.answers, 0);
      const forms = formCounts(group.rows);
      const sufficient = total >= STRUCTURE_MIN_ANSWERS;
      return {
        cluster_id: id,
        label: group.label,
        total,
        sufficient,
        dominant_form: sufficient ? forms.reduce((best, cur) => (cur.count > best.count ? cur : best)).form : null,
        forms,
        engines: [...new Set(group.rows.map((r) => r.engine))].sort().map((engine) => {
          const engineRows = group.rows.filter((r) => r.engine === engine);
          return { engine, total: engineRows.reduce((n, r) => n + r.answers, 0), forms: formCounts(engineRows) };
        }),
      };
    })
    .sort((a, b) => b.total - a.total || (a.cluster_id === null ? 1 : b.cluster_id === null ? -1 : a.cluster_id.localeCompare(b.cluster_id)));
}

const PAGE_FORM_ORDER = ["table", "definition_list", "ordered_list", "unordered_list"] as const;

/** The forms the assessed pages provide, in a fixed order. */
function pageFormsOf(pages: readonly StructurePage[]): string[] {
  const has: Record<(typeof PAGE_FORM_ORDER)[number], boolean> = {
    table: pages.some((p) => p.tables > 0),
    definition_list: pages.some((p) => p.lists.definition > 0),
    ordered_list: pages.some((p) => p.lists.ordered > 0),
    unordered_list: pages.some((p) => p.lists.unordered > 0),
  };
  return PAGE_FORM_ORDER.filter((f) => has[f]);
}

/** The structural task's template: the shape engines already answer this cluster in, for the brand's page to mirror. */
export function structureTemplate(clusterLabel: string): string {
  return [
    `Add a comparison table to the page that answers "${clusterLabel}". Engines answer this topic as a table, so give them rows to lift.`,
    "",
    "| Option | Best for | Key capability | Pricing |",
    "|---|---|---|---|",
    "| <Your product> | <audience> | <capability stated as a fact> | <price and currency> |",
    "| <Alternative> | <audience> | <capability> | <price and currency> |",
    "",
    "Keep every cell a plain statement, include the brand's own row, and mark the table up as an HTML table (not an image).",
  ].join("\n");
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
      // One vocabulary everywhere: `mixed` when both kinds of answer fed the engine's numbers.
      data_source: dataSourceOf(
        rows.filter((r) => r.dataSource === "live").reduce((n, r) => n + r.answers, 0),
        rows.filter((r) => r.dataSource === "demo").reduce((n, r) => n + r.answers, 0),
      ),
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

  const pages = input.pages ?? [];
  const assessed = pages.length > 0;
  const pageForms = pageFormsOf(pages);
  const providesStructure = pageForms.includes("table") || pageForms.includes("definition_list");
  const clusters = clusterDistributions(input.forms);
  const gaps = assessed && !providesStructure ? clusters.filter((c) => c.sufficient && c.dominant_form === "comparison_table") : [];
  const firstGap = gaps[0];
  const rationale = !assessed
    ? NO_PAGE_CRAWL_REASON
    : firstGap !== undefined
      ? `The dominant answer form for ${gaps.map((g) => g.label ?? "unclustered prompts").join(", ")} is a comparison table, and the brand's assessed pages provide neither a table nor a spec list.`
      : `The brand's assessed pages provide ${pageForms.length === 0 ? "no tables or lists" : pageForms.join(", ")}; no structure-match gap applies.`;

  const detail: GeoStructureDetail = {
    slug: "structure",
    forms,
    total,
    dominant_form: dominant.form,
    engines,
    page_forms: pageForms,
    clusters,
    brand_answers: brandAnswers,
    prior_brand_answers: priorAnswers,
    position,
    template: firstGap === undefined ? null : structureTemplate(firstGap.label ?? "this topic"),
    rationale,
  };

  const finding: GeoFinding = {
    id: "structure-dominant-form",
    severity: "info",
    headline: `${FORM_LABEL[dominant.form]} is the dominant answer form (${pct(dominant.count / total)} of ${String(total)} answers).${movement}`,
    detail: rationale,
    // Without an assessed page, the only page this analysis can point at is the one it could not assess.
    evidence: [
      assessed
        ? { url: pages[0]!.url, snippet: `Provides: ${pageForms.length === 0 ? "no tables or lists" : pageForms.join(", ")}.` }
        : { url: `https://${input.rootDomain}/`, snippet: "No page crawl: the page's answer forms could not be assessed." },
    ],
    metric: { name: "dominant_form_share", value: round4(dominant.count / total) },
    no_action: true,
    // The detail rides on the finding so a read returns the stored row's own aggregate.
    structure: detail,
  };

  const gapFindings: GeoFinding[] = gaps.map((g) => {
    const tables = g.forms.find((x) => x.form === "comparison_table")?.count ?? 0;
    const label = g.label ?? "unclustered prompts";
    return {
      id: `structure-gap-${g.cluster_id ?? "unclustered"}`,
      severity: "medium" as const,
      headline: `Answers for ${label} are mostly comparison tables (${pct(tables / g.total)} of ${String(g.total)}), and the brand's page provides neither a table nor a spec list.`,
      detail: structureTemplate(label),
      evidence: [{ url: pages[0]!.url, snippet: `Provides: ${pageForms.length === 0 ? "no tables or lists" : pageForms.join(", ")}.` }],
      metric: { name: "cluster_table_share", value: round4(tables / g.total) },
      task_rule_code: STRUCTURE_TASK_RULE,
    };
  });

  return {
    write: {
      ...base,
      evidence_cells: total,
      evidence_passages: 0,
      sufficient: true,
      suppression_reason: null,
      findings: [finding, ...gapFindings],
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
  cluster_id: string | null;
  cluster_label: string | null;
  engine_key: string;
  answer_form: AnswerFormValue;
  answers: number;
  is_demo: boolean;
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
    `SELECT tc.id AS cluster_id, tc.label AS cluster_label,
            mf.engine_key, mf.answer_form, count(DISTINCT mf.result_id)::int AS answers,
            (ac.normalizer_version = $4) AS is_demo
       FROM mention_facts mf
       JOIN answer_captures ac ON ac.id = mf.result_id AND ac.captured_at = mf.captured_at
       -- STORY-040 AC8: a prompt has at most one cluster, so this never multiplies an answer. LEFT, because a prompt
       -- in no cluster (or one whose cluster is gone) is still an answer and is reported as unclustered.
       LEFT JOIN tracked_prompts tp ON tp.id = mf.prompt_id
       LEFT JOIN topic_clusters tc ON tc.id = tp.cluster_id
      WHERE mf.project_id = $1
        AND mf.captured_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
        AND mf.captured_at <  ($2::date::timestamp AT TIME ZONE 'UTC') + make_interval(days => $3)
        AND mf.answer_form IS NOT NULL AND mf.scoring_version = $5
      GROUP BY tc.id, tc.label, mf.engine_key, mf.answer_form, (ac.normalizer_version = $4)`,
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
      dataSource: r.is_demo ? "demo" : "live",
      form: r.answer_form,
      answers: r.answers,
      cluster: r.cluster_id === null ? null : { id: r.cluster_id, label: r.cluster_label ?? "" },
    })),
    position: (await positionIn(0)).map((r) => ({ cls: r.position_class, answers: r.answers })),
    priorPosition: (await positionIn(windowDays)).map((r) => ({ cls: r.position_class, answers: r.answers })),
  };
}
