import {
  geoFindingSchema,
  type GeoAnalysisSummary,
  type GeoDigest,
  type GeoFinding,
  type GeoSlug,
  type Lever,
} from "../../../contracts/analytics/index.js";

// STORY-062 — the pure half of the GEO read: how a PERSISTED row becomes a
// summary, and how the persisted set becomes the digest. Nothing here reads
// a database or recomputes an analysis; every surface calls this over the
// same rows, which is what keeps four surfaces in agreement.

/** One `geo_analyses` row as the service hands it over. */
export interface StoredAnalysis {
  analysis: GeoSlug;
  score: number | null;
  evidenceCells: number;
  evidencePassages: number;
  sufficient: boolean;
  suppressionReason: string | null;
  /** Raw jsonb: re-validated on read, so a finding persisted around the write path is dropped. */
  findings: unknown[];
  leverRank: number | null;
  windowDays: number;
}

export type TaskLink = { task_id: string; label: string; href: string };
export type TaskLookup = (ruleCode: string) => TaskLink | null;

interface CatalogueEntry {
  code: GeoAnalysisSummary["code"];
  title: string;
  minimum: string;
  /** What a project with no stored row for this slug is told. */
  absent: { status: "insufficient" | "post_launch"; needs: string };
}

// Titles and minimums are product-spec §16 / the frontend's META table.
// The ORDER is the display order.
export const GEO_CATALOGUE: Readonly<Record<GeoSlug, CatalogueEntry>> = {
  alignment: {
    code: "A1",
    title: "Semantic alignment",
    minimum: "8 cited passages per topic cluster; below that, only the top 3 recommendations are shown.",
    absent: { status: "insufficient", needs: "A corpus of cited passages. The corpus builder (STORY-058) has not produced one for this project yet." },
  },
  entity: {
    code: "A2",
    title: "Entity readiness",
    minimum: "A brand name engines can tell apart; a high disambiguation risk withholds the score.",
    absent: { status: "insufficient", needs: "Entity profiles. No entity presence check has been recorded for this project yet." },
  },
  structure: {
    code: "A3",
    title: "Answer structure",
    minimum: "30 parsed answers in the window.",
    absent: { status: "insufficient", needs: "30 parsed answers in the window. This analysis has not been computed for this project yet." },
  },
  divergence: {
    code: "A4",
    title: "Cross-engine divergence",
    minimum: "10 prompts answered live by at least 2 engines.",
    absent: { status: "insufficient", needs: "10 prompts answered live by at least 2 engines. This analysis has not been computed for this project yet." },
  },
  topics: {
    code: "A5",
    title: "Topical authority",
    minimum: "30 parsed answers across at least 2 topics.",
    absent: { status: "insufficient", needs: "Topic clusters (STORY-047). None exist for this project yet." },
  },
  sentiment: {
    code: "A6",
    title: "Sentiment drivers",
    minimum: "30 mentions of the brand in the window.",
    absent: { status: "insufficient", needs: "30 mentions of the brand in the window. This analysis has not been computed for this project yet." },
  },
  freshness: {
    code: "A7",
    title: "Freshness & decay",
    minimum: "2 months of history. Built; enabled after launch.",
    absent: { status: "post_launch", needs: "2 months of history. Freshness is enabled after launch." },
  },
};

export const GEO_SLUGS = Object.keys(GEO_CATALOGUE) as GeoSlug[];

/** Findings that survive re-validation. A finding without evidence is dropped, not rendered with a caveat. */
export function validFindings(row: StoredAnalysis): GeoFinding[] {
  const out: GeoFinding[] = [];
  for (const raw of row.findings) {
    const parsed = geoFindingSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** The finding that speaks for the analysis: the best-ranked lever finding, else the first. */
function headlineFinding(findings: GeoFinding[]): GeoFinding | null {
  if (findings.length === 0) return null;
  const ranked = findings.filter((f) => f.lever_rank !== undefined).sort((a, b) => a.lever_rank! - b.lever_rank!);
  return ranked[0] ?? findings[0]!;
}

export function summarize(slug: GeoSlug, row: StoredAnalysis | null, windowDays: number): GeoAnalysisSummary {
  const meta = GEO_CATALOGUE[slug];
  const base = { slug, code: meta.code, title: meta.title, minimum: meta.minimum };

  if (row === null) {
    return {
      ...base,
      status: meta.absent.status,
      evidence: { passages: null, cells: 0, window_days: windowDays },
      needs: meta.absent.needs,
      headline: null,
      score: null,
      verdict: null,
      lever_rank: null,
    };
  }

  const evidence = { passages: row.evidencePassages, cells: row.evidenceCells, window_days: row.windowDays };
  if (!row.sufficient) {
    // Suppression is a first-class state with a reason: no number, no finding.
    return {
      ...base,
      status: "insufficient",
      evidence,
      needs: row.suppressionReason ?? meta.absent.needs,
      headline: null,
      score: null,
      verdict: null,
      lever_rank: null,
    };
  }

  const findings = validFindings(row);
  const speaker = headlineFinding(findings);
  const verdict =
    findings.length === 0 ? null : findings.some((f) => f.task_rule_code !== undefined) ? "action" : "no_action";
  return {
    ...base,
    status: "ready",
    evidence,
    needs: null,
    headline: speaker?.headline ?? null,
    // 0 is a real score; only null means "this analysis publishes none".
    score: row.score,
    verdict,
    lever_rank: row.leverRank,
  };
}

/** The digest: persisted rows only, at most three levers, ranked. */
export function composeDigest(rows: StoredAnalysis[], windowDays: number, taskFor: TaskLookup): GeoDigest {
  const bySlug = new Map(rows.map((r) => [r.analysis, r]));
  const analyses = GEO_SLUGS.map((slug) => summarize(slug, bySlug.get(slug) ?? null, windowDays));

  const candidates = analyses
    .filter((a) => a.status === "ready" && a.lever_rank !== null && a.headline !== null)
    // Rank ties break on display order, which is stable.
    .sort((a, b) => a.lever_rank! - b.lever_rank!)
    .slice(0, 3);

  const levers: Lever[] = candidates.map((a, i) => {
    const row = bySlug.get(a.slug)!;
    const finding = headlineFinding(validFindings(row));
    const task = finding?.task_rule_code !== undefined ? taskFor(finding.task_rule_code) : null;
    return {
      rank: (i + 1) as 1 | 2 | 3,
      headline: a.headline!,
      analysis: `${a.code} · ${a.title}`,
      analysis_href: `geo?analysis=${a.slug}`,
      task,
    };
  });

  const ready = analyses.filter((a) => a.status === "ready");
  const evidence = ready.reduce(
    (acc, a) => ({ passages: acc.passages + (a.evidence.passages ?? 0), cells: acc.cells + a.evidence.cells }),
    { passages: 0, cells: 0 },
  );

  const sufficient = levers.length > 0;
  const needs = sufficient
    ? null
    : ready.length > 0
      ? "No analysis has promoted a lever yet."
      : `No analysis has enough evidence to rank levers yet. ${analyses
        .filter((a) => a.status === "insufficient" && a.needs !== null)
        .map((a) => `${a.code} needs: ${a.needs}`)
        .join(" ")}`.trim();

  return { sufficient, needs, levers, evidence, analyses };
}
