import type { ClientBase } from "pg";
import type { GeoAnalysisWrite, GeoDivergenceDetail, GeoFinding, SurfaceComparison } from "../../../contracts/analytics/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { crossEngineDivergence, divergenceClassFor, SCORING_VERSION } from "../scoring/index.js";
import { hasFactsStatusSql } from "../rollup/aggregate-day.js";
import { DEMO_NORMALIZER_VERSION } from "./structure.js";

// STORY-061 - A4 cross-engine divergence (scoring-models.md section 10), persisted. The formula is src/lib/scoring/divergence.ts; this
// file feeds it from stored facts and turns its attribution into engine-targeted findings. Free and unmetered; no engine, embedding
// provider or crawl is touched (KAD-06): it reads `answer_captures`, `mention_facts`, `citation_facts` and the source index.
//
// LIVE ONLY. The reference says "live", and the owner question on seeded demo engines is open (story technical notes, NEW-C-12), so a
// demo result is counted in `excluded.demo_results` and never enters the mean or the alert.
//
// CITATION COUNTS ARE NEVER COMPARED ACROSS ENGINES. Attribution is a SET difference. The affinity map and the surface comparison use
// "answers citing the domain / answers", which a query fan-out (one licensed surface fans out, the other does not) cannot inflate.

/** product-spec A4 / the catalogue: "10 prompts answered live by at least 2 engines." */
export const DIVERGENCE_MIN_PROMPTS = 10;
/** scoring-models.md section 15, `divergence_high`: `project_divergence >= 0.45` with >= 10 qualifying prompts. */
export const DIVERGENCE_ALERT_THRESHOLD = 0.45;
export const DIVERGENCE_ALERT_MIN_PROMPTS = 10;
export const DIVERGENCE_TASK_RULE = "TG-DIVERGENCE";
/** The prompts the detail lists (most divergent first), the targets it names, and the findings (one task each) it raises. BUILDER CHOICES: the reference sets no cap. */
export const DIVERGENCE_LISTED_PROMPTS = 50;
export const DIVERGENCE_LISTED_TARGETS = 10;
export const DIVERGENCE_MAX_FINDINGS = 3;
const AFFINITY_DOMAINS_PER_ENGINE = 20;

/** The two licensed SERP surfaces (engine catalogue, kind `licensed_serp`). */
export const LICENSED_SURFACES = ["google_aio", "google_ai_mode"] as const;

export interface DivergenceGeoPrompt {
  promptId: string;
  /** `tracked_prompts.stability_score`; null when never measured. */
  stabilityScore: number | null;
  /** At most one per engine: the latest parsed capture in the window. */
  results: {
    engine: string;
    /** The brand's FIRST mention's stored `position_class`; null when the brand was not mentioned. */
    positionClass: string | null;
    dataSource: "live" | "demo";
    citedDomains: string[];
  }[];
}

export interface DivergenceAffinityInput {
  engine: string;
  /** Live parsed answers on this engine in the window. */
  answers: number;
  domains: { domain: string; answersCiting: number; sourceClass: string | null }[];
  citationsByClass: Record<string, number>;
}

export interface DivergenceGeoInput {
  windowStart: string;
  windowDays: 7 | 30 | 90;
  rootDomain: string;
  prompts: DivergenceGeoPrompt[];
  /** `context_weight` by domain; a domain absent from the map weighs 0. */
  contextWeights: Record<string, number>;
  affinity: DivergenceAffinityInput[];
}

export interface SurfaceSide {
  engine: string;
  answers: number;
  domains: { domain: string; answersCiting: number }[];
}

/**
 * The two licensed surfaces side by side, on `answers citing the domain / answers`. A comparison of raw citation counts is never made:
 * it is refused (not guessed) when either surface has no live answers or the pair is not the two licensed surfaces.
 */
export function compareLicensedSurfaces(a: SurfaceSide, b: SurfaceSide): SurfaceComparison {
  const pair = [a.engine, b.engine].sort().join("|");
  if (pair !== [...LICENSED_SURFACES].sort().join("|")) {
    return { status: "refused", reason: "Only the two licensed Google surfaces are compared with each other; other engines are compared by citation set, never by count." };
  }
  if (a.answers <= 0 || b.answers <= 0) {
    return { status: "refused", reason: "A surface with no live answers has no rate to compare; citation counts are not compared without a per-answer basis." };
  }
  const ratesA = new Map(a.domains.map((d) => [d.domain, d.answersCiting / a.answers]));
  const ratesB = new Map(b.domains.map((d) => [d.domain, d.answersCiting / b.answers]));
  const domains = [...new Set([...ratesA.keys(), ...ratesB.keys()])].sort();
  return {
    status: "normalised",
    engines: [a.engine, b.engine],
    basis: "answers_citing_domain / answers",
    domains: domains.map((domain) => ({ domain, rate_a: Math.min(1, ratesA.get(domain) ?? 0), rate_b: Math.min(1, ratesB.get(domain) ?? 0) })),
  };
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Pure: the persisted row and the read detail from one aggregate, so they cannot disagree. */
export function buildDivergence(input: DivergenceGeoInput): { write: GeoAnalysisWrite; detail: GeoDivergenceDetail | null } {
  const base = { analysis: "divergence" as const, window_start: input.windowStart, window_days: input.windowDays };

  const demoResults = input.prompts.reduce((n, p) => n + p.results.filter((r) => r.dataSource === "demo").length, 0);
  const scored = crossEngineDivergence({
    contextWeights: input.contextWeights,
    prompts: input.prompts.map((p) => ({
      promptId: p.promptId,
      stabilityScore: p.stabilityScore,
      engines: p.results
        .filter((r) => r.dataSource === "live")
        .map((r) => ({ engine: r.engine, positionClass: divergenceClassFor(r.positionClass), citedDomains: r.citedDomains, dataSource: "live" as const })),
    })),
  });

  if (scored.qualifyingPrompts < DIVERGENCE_MIN_PROMPTS) {
    return {
      write: {
        ...base,
        score: null,
        score_label: null,
        evidence_cells: scored.qualifyingPrompts,
        evidence_passages: 0,
        sufficient: false,
        suppression_reason: `Needs ${String(DIVERGENCE_MIN_PROMPTS)} prompts answered live by at least 2 engines; this window has ${String(scored.qualifyingPrompts)}.`,
        findings: [],
        lever_rank: null,
      },
      detail: null,
    };
  }

  const stabilityById = new Map(input.prompts.map((p) => [p.promptId, p.stabilityScore]));
  const projectDivergence = scored.projectDivergence!; // qualifying >= 10, so a mean exists
  const crossed = scored.qualifyingPrompts >= DIVERGENCE_ALERT_MIN_PROMPTS && projectDivergence >= DIVERGENCE_ALERT_THRESHOLD;

  const divergent = scored.prompts
    .filter((p) => p.divergence > 0 && p.attribution !== null)
    .sort((a, b) => b.divergence - a.divergence || byText(a.promptId, b.promptId));

  const targetMap = new Map<string, { losing: string; domain: string; weight: number; prompts: number; winners: Set<string> }>();
  for (const p of divergent) {
    const a = p.attribution!;
    for (const d of a.domains) {
      const key = `${a.losingEngine}\u0000${d.domain}`;
      const t = targetMap.get(key) ?? { losing: a.losingEngine, domain: d.domain, weight: d.contextWeight, prompts: 0, winners: new Set<string>() };
      t.prompts += 1;
      t.winners.add(a.winningEngine);
      targetMap.set(key, t);
    }
  }
  const targets = [...targetMap.values()]
    .sort((a, b) => b.weight - a.weight || b.prompts - a.prompts || byText(a.losing, b.losing) || byText(a.domain, b.domain))
    .map((t) => ({ losing_engine: t.losing, domain: t.domain, context_weight: t.weight, prompts: t.prompts, winning_engines: [...t.winners].sort() }));

  const affinity = input.affinity
    .filter((e) => e.answers > 0)
    .map((e) => {
      const totalCitations = Object.values(e.citationsByClass).reduce((s, n) => s + n, 0);
      return {
        engine: e.engine,
        answers: e.answers,
        domains: [...e.domains]
          .sort((a, b) => b.answersCiting - a.answersCiting || byText(a.domain, b.domain))
          .slice(0, AFFINITY_DOMAINS_PER_ENGINE)
          .map((d) => ({ domain: d.domain, answers_citing: d.answersCiting, presence_rate: Math.min(1, d.answersCiting / e.answers), source_class: d.sourceClass })),
        source_classes: Object.entries(e.citationsByClass)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))
          .map(([source_class, n]) => ({ source_class, share: n / totalCitations })),
      };
    })
    .sort((a, b) => byText(a.engine, b.engine));

  const side = (engine: string): SurfaceSide | null => {
    const e = affinity.find((x) => x.engine === engine);
    return e === undefined ? null : { engine, answers: e.answers, domains: input.affinity.find((x) => x.engine === engine)!.domains };
  };
  const [aio, mode] = [side("google_aio"), side("google_ai_mode")];
  const surfaceComparison = aio === null || mode === null ? null : compareLicensedSurfaces(aio, mode);

  const detail: GeoDivergenceDetail = {
    slug: "divergence",
    data_source: "live",
    project_divergence: projectDivergence,
    qualifying_prompts: scored.qualifyingPrompts,
    excluded: {
      fewer_than_two_live_engines: scored.excluded.fewerThanTwoEngines,
      no_stability: scored.excluded.noStability,
      unscored_results: scored.excluded.unscoredResults,
      demo_results: demoResults,
    },
    alert: { threshold: DIVERGENCE_ALERT_THRESHOLD, min_prompts: DIVERGENCE_ALERT_MIN_PROMPTS, crossed },
    prompts: divergent.slice(0, DIVERGENCE_LISTED_PROMPTS).map((p) => ({
      prompt_id: p.promptId,
      divergence: p.divergence,
      stability_score: Math.min(1, Math.max(0, stabilityById.get(p.promptId) ?? 0)),
      winning_engine: p.attribution!.winningEngine,
      losing_engine: p.attribution!.losingEngine,
      missing_domains: p.attribution!.domains.map((d) => ({ domain: d.domain, context_weight: d.contextWeight })),
    })),
    targets: targets.slice(0, DIVERGENCE_LISTED_TARGETS),
    affinity,
    surface_comparison: surfaceComparison,
  };

  const rootEvidence = (snippet: string): GeoFinding["evidence"] => [{ url: `https://${input.rootDomain}/`, snippet }];
  const mean = projectDivergence.toFixed(2);
  let findings: GeoFinding[];
  if (crossed && targets.length > 0) {
    findings = targets.slice(0, DIVERGENCE_MAX_FINDINGS).map((t, i) => ({
      id: `divergence-${t.losing_engine}-${t.domain}`,
      severity: "medium" as const,
      headline: `The ${t.losing_engine} answers do not cite ${t.domain}, which ${t.winning_engines.join(" and ")} cite${t.winning_engines.length === 1 ? "s" : ""} for ${String(t.prompts)} prompt${t.prompts === 1 ? "" : "s"} where the brand is recommended there and not here.`,
      evidence: [{ url: `https://${t.domain}/`, snippet: `Cited by ${t.winning_engines.join(", ")} and absent from ${t.losing_engine} on ${String(t.prompts)} divergent prompt${t.prompts === 1 ? "" : "s"}.` }],
      metric: { name: "project_divergence", value: projectDivergence, target: DIVERGENCE_ALERT_THRESHOLD },
      task_rule_code: DIVERGENCE_TASK_RULE,
      engine: t.losing_engine,
      ...(i === 0 ? { divergence: detail } : {}),
    }));
  } else {
    findings = [
      {
        id: crossed ? "divergence-no-missing-domain" : "divergence-below-alert",
        severity: "info",
        headline: crossed
          ? `Engines disagree (mean divergence ${mean}) but the losing engines cite every domain the winners do, so no domain is missing.`
          : `Engines agree closely enough: mean divergence ${mean} across ${String(scored.qualifyingPrompts)} prompts, under the ${String(DIVERGENCE_ALERT_THRESHOLD)} alert.`,
        evidence: rootEvidence("Cross-engine divergence over prompts answered live by at least 2 engines."),
        metric: { name: "project_divergence", value: projectDivergence, target: DIVERGENCE_ALERT_THRESHOLD },
        no_action: true,
        divergence: detail,
      },
    ];
  }

  return {
    write: {
      ...base,
      score: projectDivergence,
      score_label: "Mean cross-engine divergence (0 to 1)",
      evidence_cells: scored.qualifyingPrompts,
      evidence_passages: 0,
      sufficient: true,
      suppression_reason: null,
      findings,
      lever_rank: null,
    },
    detail,
  };
}

interface CaptureRow {
  prompt_id: string;
  engine_key: string;
  result_id: string;
  is_demo: boolean;
  stability_score: number | null;
  position_class: string | null;
}

const windowClause = (alias: string): string =>
  `${alias}.captured_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
        AND ${alias}.captured_at <  ($2::date::timestamp AT TIME ZONE 'UTC') + make_interval(days => $3)`;

/**
 * Reads the window's facts. Must run inside the ambient tenant transaction: RLS is the guarantee, the `project_id` filter is for the
 * planner. One result per (prompt, engine): the latest parsed capture in the window.
 */
export async function loadDivergenceInput(
  tx: ClientBase,
  projectId: string,
  windowStart: string,
  windowDays: 7 | 30 | 90,
): Promise<DivergenceGeoInput> {
  const project = await tx.query<{ root_domain: string }>("SELECT root_domain FROM projects WHERE id = $1 AND deleted_at IS NULL", [projectId]);
  if (project.rows[0] === undefined) throw new NotFoundError({ message: "no such project" });

  const captures = await tx.query<CaptureRow>(
    `SELECT latest.prompt_id, latest.engine_key, latest.id AS result_id, (latest.normalizer_version = $4) AS is_demo,
            tp.stability_score, first_mention.position_class
       FROM (SELECT DISTINCT ON (ac.prompt_id, ac.engine_key) ac.id, ac.captured_at, ac.prompt_id, ac.engine_key, ac.normalizer_version
               FROM answer_captures ac
              WHERE ac.project_id = $1 AND ${hasFactsStatusSql("ac.status")} AND ${windowClause("ac")}
              ORDER BY ac.prompt_id, ac.engine_key, ac.captured_at DESC, ac.id) latest
       JOIN tracked_prompts tp ON tp.id = latest.prompt_id AND tp.project_id = $1 AND tp.deleted_at IS NULL
       LEFT JOIN LATERAL (SELECT mf.position_class
                            FROM mention_facts mf
                           WHERE mf.result_id = latest.id AND mf.captured_at = latest.captured_at
                             AND mf.project_id = $1 AND mf.entity_type = 'brand' AND mf.scoring_version = $5
                           ORDER BY mf.occurrence_index, mf.char_start LIMIT 1) first_mention ON true
      ORDER BY latest.prompt_id, latest.engine_key`,
    [projectId, windowStart, windowDays, DEMO_NORMALIZER_VERSION, SCORING_VERSION],
  );

  const resultIds = captures.rows.map((r) => r.result_id);
  const cited = new Map<string, Set<string>>();
  if (resultIds.length > 0) {
    const rows = await tx.query<{ result_id: string; domain: string }>(
      `SELECT DISTINCT cf.result_id, lower(cf.domain) AS domain
         FROM citation_facts cf
        WHERE cf.project_id = $1 AND cf.result_id = ANY($4::uuid[]) AND ${windowClause("cf")}`,
      [projectId, windowStart, windowDays, resultIds],
    );
    for (const r of rows.rows) (cited.get(r.result_id) ?? cited.set(r.result_id, new Set()).get(r.result_id)!).add(r.domain);
  }

  const byPrompt = new Map<string, DivergenceGeoPrompt>();
  for (const c of captures.rows) {
    const p = byPrompt.get(c.prompt_id) ?? { promptId: c.prompt_id, stabilityScore: c.stability_score, results: [] };
    p.results.push({ engine: c.engine_key, positionClass: c.position_class, dataSource: c.is_demo ? "demo" : "live", citedDomains: [...(cited.get(c.result_id) ?? [])].sort() });
    byPrompt.set(c.prompt_id, p);
  }

  // context_weight: the project's own source index, the widest recent row per domain (engine 'all').
  const weights = await tx.query<{ domain: string; context_weight: number }>(
    `SELECT lower(sd.domain) AS domain, psi.context_weight::float8 AS context_weight
       FROM (SELECT DISTINCT ON (source_domain_id) source_domain_id, context_weight
               FROM project_source_index
              WHERE project_id = $1 AND engine_key = 'all' AND window_days = $2 AND scoring_version = $3
              ORDER BY source_domain_id, window_start DESC) psi
       JOIN source_domains sd ON sd.id = psi.source_domain_id`,
    [projectId, windowDays, SCORING_VERSION],
  );

  // The engine-source affinity map: every live parsed answer in the window, not only the qualifying prompts.
  const answers = await tx.query<{ engine_key: string; answers: number }>(
    `SELECT ac.engine_key, count(*)::int AS answers
       FROM answer_captures ac
      WHERE ac.project_id = $1 AND ${hasFactsStatusSql("ac.status")} AND ac.normalizer_version <> $4 AND ${windowClause("ac")}
      GROUP BY ac.engine_key`,
    [projectId, windowStart, windowDays, DEMO_NORMALIZER_VERSION],
  );
  const domainRows = await tx.query<{ engine_key: string; domain: string; answers_citing: number; source_class: string | null; citations: number }>(
    `SELECT cf.engine_key, lower(cf.domain) AS domain, count(DISTINCT cf.result_id)::int AS answers_citing,
            mode() WITHIN GROUP (ORDER BY cf.source_class) AS source_class, count(*)::int AS citations
       FROM citation_facts cf
       JOIN answer_captures ac ON ac.id = cf.result_id AND ac.captured_at = cf.captured_at
      WHERE cf.project_id = $1 AND ${hasFactsStatusSql("ac.status")} AND ac.normalizer_version <> $4 AND ${windowClause("cf")}
      GROUP BY cf.engine_key, lower(cf.domain)`,
    [projectId, windowStart, windowDays, DEMO_NORMALIZER_VERSION],
  );
  const affinity: DivergenceAffinityInput[] = answers.rows.map((a) => {
    const mine = domainRows.rows.filter((d) => d.engine_key === a.engine_key);
    const classes: Record<string, number> = {};
    for (const d of mine) if (d.source_class !== null) classes[d.source_class] = (classes[d.source_class] ?? 0) + d.citations;
    return {
      engine: a.engine_key,
      answers: a.answers,
      domains: mine.map((d) => ({ domain: d.domain, answersCiting: d.answers_citing, sourceClass: d.source_class })),
      citationsByClass: classes,
    };
  });

  return {
    windowStart,
    windowDays,
    rootDomain: project.rows[0].root_domain,
    prompts: [...byPrompt.values()],
    contextWeights: Object.fromEntries(weights.rows.map((w) => [w.domain, w.context_weight])),
    affinity,
  };
}
