import type { ClientBase } from "pg";
import {
  type EntityScoredNode,
  type GeoAnalysisWrite,
  type GeoEntityDetail,
  type GeoFinding,
} from "../../../contracts/analytics/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { SCORING_VERSION } from "../scoring/index.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-060 — A2 entity readiness (scoring-models.md §10 "Entity Authority (A2)"). Free and unmetered: it reads
// `entity_nodes`, `mention_facts` and `corpus_passages`, and touches no engine, embedding provider or crawl target.
//
// THE DEFAULT IS TO WITHHOLD. The authority figure is published only when every scored node has been checked, and is
// withheld outright when the brand's name collides with common words (`high` disambiguation risk): a figure computed
// over false positives is worse than none. The risk itself is reported next to the score and never folded into it.
//
// WHAT THIS FILE DOES NOT DO: probe Wikidata, Wikipedia, Crunchbase, LinkedIn, GitHub, G2/Capterra or a category
// directory. That is network I/O and belongs to a job behind a port, outside any transaction (ADR-0003); the sources
// and their access terms are an owner decision. `writeEntityNodes` is the one place a check result becomes an
// `entity_nodes` row, so that job has a single, tested write path to call.

/** The stored `entity_nodes.node` vocabulary. */
export type StoredEntityNode = "wikidata" | "wikipedia" | "g2" | "capterra" | "crunchbase" | "linkedin" | "github" | "category_directory";

/** scoring-models.md §10 `NODES`, in display order. They sum to 1. */
export const ENTITY_NODE_WEIGHTS: Readonly<Record<EntityScoredNode, number>> = {
  wikidata: 0.22,
  wikipedia: 0.14,
  g2_or_capterra: 0.18,
  crunchbase: 0.1,
  linkedin: 0.08,
  github: 0.08,
  category_directory: 0.2,
};
const SCORED_ORDER = Object.keys(ENTITY_NODE_WEIGHTS) as EntityScoredNode[];

/** scoring-models.md §15 `entity_node_missing`: "a NODES entry with weight >= 0.18 absent". */
export const ENTITY_ALERT_MIN_WEIGHT = 0.18;
/** §10: present but incomplete (missing >= 2 core fields) = 0.6. */
export const ENTITY_THIN_MISSING_FIELDS = 2;
export const ENTITY_THIN_PRESENCE = 0.6;
/** §10 disambiguation bands: low < 0.05, medium 0.05..0.20, high > 0.20. */
export const DISAMBIGUATION_MEDIUM_FROM = 0.05;
export const DISAMBIGUATION_HIGH_ABOVE = 0.2;
/**
 * BUILDER READING, not in the reference: the fewest brand-name matches a risk ratio is computed over (the same 30 the
 * other analyses and the §15 alert floor use). Below it the risk is "unmeasured", never low.
 */
export const ENTITY_MIN_NAME_MATCHES = 30;
/** BUILDER READING: A1's "8 cited passages" is the only passage minimum the reference states; co-occurrence reuses it. */
export const ENTITY_MIN_CATEGORY_PASSAGES = 8;

export const ENTITY_NODE_TASK_RULE = "TG-ENTITY-NODE";
/** BUILDER PROPOSAL: the reference names the alias-tuning task but gives it no rule code. Not yet a `task_generation_rules` row. */
export const ENTITY_ALIAS_TASK_RULE = "TG-ENTITY-ALIAS";

const NODE_LABEL: Readonly<Record<EntityScoredNode, string>> = {
  wikidata: "Wikidata",
  wikipedia: "Wikipedia",
  g2_or_capterra: "G2 or Capterra",
  crunchbase: "Crunchbase",
  linkedin: "LinkedIn",
  github: "GitHub",
  category_directory: "category directory",
};

export interface EntityNodeRecord {
  node: StoredEntityNode;
  present: boolean;
  complete: boolean;
  url: string | null;
  missingFields: string[];
  inBrandSameas: boolean;
}

export interface EntityInput {
  windowStart: string;
  windowDays: 7 | 30 | 90;
  rootDomain: string;
  nodes: EntityNodeRecord[];
  /** Brand-name matches in the window (mention rows). */
  nameMatches: number;
  /** Of those, the matches judged not to be about this brand. */
  notAboutBrand: number;
  cooccurrence: { terms: string[]; categoryPassages: number; entities: { name: string; isBrand: boolean; passages: number }[] };
}

const round3 = (x: number): number => Math.round(x * 1_000) / 1_000;
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const pct = (x: number): string => `${String(Math.round(x * 100))}%`;

export function disambiguationLevel(risk: number): "low" | "medium" | "high" {
  if (risk < DISAMBIGUATION_MEDIUM_FROM) return "low";
  return risk <= DISAMBIGUATION_HIGH_ABOVE ? "medium" : "high";
}

interface ScoredNode {
  node: EntityScoredNode;
  checked: boolean;
  present: boolean;
  complete: boolean;
  url: string | null;
  missingFields: string[];
  inBrandSameas: boolean;
}

/** `g2` and `capterra` are one scored node: the better-presented profile speaks for it, and a link to either covers it. */
function scoredNodes(records: readonly EntityNodeRecord[]): ScoredNode[] {
  return SCORED_ORDER.map((node) => {
    const rows = records.filter((r) => (node === "g2_or_capterra" ? r.node === "g2" || r.node === "capterra" : r.node === node));
    if (rows.length === 0) return { node, checked: false, present: false, complete: false, url: null, missingFields: [], inBrandSameas: false };
    const present = rows.filter((r) => r.present);
    // Complete beats thin; then the stored order (g2 before capterra) keeps the pick independent of input order.
    const best = present.find((r) => r.complete) ?? present[0] ?? rows[0]!;
    return {
      node,
      checked: true,
      present: present.length > 0,
      complete: best.present && best.complete,
      url: best.present ? best.url : null,
      missingFields: best.present ? best.missingFields : [],
      inBrandSameas: present.some((r) => r.inBrandSameas),
    };
  });
}

const presenceOf = (n: ScoredNode): number => (!n.present ? 0 : n.complete ? 1 : ENTITY_THIN_PRESENCE);

function fixPath(n: ScoredNode, linkGap: boolean): string | null {
  const label = NODE_LABEL[n.node];
  if (!n.present) return `Create the ${label} profile, then link it from the brand's sameAs.`;
  const parts: string[] = [];
  if (!n.complete) parts.push(`Complete the ${label} profile${n.missingFields.length > 0 ? `: add ${n.missingFields.join(", ")}` : ""}.`);
  if (linkGap) parts.push(`Add ${n.url ?? "its URL"} to the brand's Organization sameAs.`);
  return parts.length === 0 ? null : parts.join(" ");
}

/** Pure: the persisted row and the read detail from one aggregate, so they cannot disagree. */
export function buildEntity(input: EntityInput): { write: GeoAnalysisWrite; detail: GeoEntityDetail | null } {
  const base = { analysis: "entity" as const, window_start: input.windowStart, window_days: input.windowDays, score_label: "Entity Authority" };
  const nodes = scoredNodes(input.nodes);
  const unchecked = nodes.filter((n) => !n.checked);

  if (unchecked.length > 0) {
    return {
      write: {
        ...base,
        score: null,
        evidence_cells: input.nameMatches,
        evidence_passages: input.cooccurrence.categoryPassages,
        sufficient: false,
        suppression_reason:
          unchecked.length === nodes.length
            ? "Authoritative profiles have not been checked for this project yet; the Entity Authority score needs all seven nodes checked."
            : `These authoritative nodes have not been checked yet: ${unchecked.map((n) => n.node).join(", ")}. The score needs all seven.`,
        findings: [],
        lever_rank: null,
      },
      detail: null,
    };
  }

  // ---- authority: exactly §10 ----
  const presentNodes = nodes.filter((n) => n.present);
  const weighted = nodes.reduce((sum, n) => sum + ENTITY_NODE_WEIGHTS[n.node] * presenceOf(n), 0);
  // null, not 0, when nothing is present: there is no profile to link, so coverage is not "zero percent".
  const sameasCoverage = presentNodes.length === 0 ? null : presentNodes.filter((n) => n.inBrandSameas).length / presentNodes.length;
  const authority = round3(100 * (0.75 * weighted + 0.25 * (sameasCoverage ?? 0)));

  // ---- disambiguation: separate, never folded in ----
  const measured = input.nameMatches >= ENTITY_MIN_NAME_MATCHES;
  const riskRaw = measured ? input.notAboutBrand / input.nameMatches : null;
  const level = riskRaw === null ? ("unmeasured" as const) : disambiguationLevel(riskRaw);
  const suppressed = level === "high";
  const reason = suppressed
    ? `Disambiguation risk is high (${pct(riskRaw!)} of ${String(input.nameMatches)} name matches are not about this brand), so the Entity Authority score would be computed over false positives and is withheld. Tune the brand's aliases first.`
    : null;

  const detailNodes = nodes.map((n) => {
    const linkGap = n.present && !n.inBrandSameas;
    return {
      node: n.node,
      weight: ENTITY_NODE_WEIGHTS[n.node],
      status: !n.present ? ("absent" as const) : n.complete ? ("complete" as const) : ("thin" as const),
      presence: presenceOf(n),
      url: n.url,
      missing_fields: n.missingFields,
      in_brand_sameas: n.present && n.inBrandSameas,
      link_gap: linkGap,
      fix_path: fixPath(n, linkGap),
    };
  });

  const entities = input.cooccurrence.entities.map((e) => ({
    name: e.name,
    is_brand: e.isBrand,
    passages: e.passages,
    rate: input.cooccurrence.categoryPassages >= ENTITY_MIN_CATEGORY_PASSAGES ? round4(e.passages / input.cooccurrence.categoryPassages) : null,
  }));
  const coSufficient = input.cooccurrence.terms.length > 0 && input.cooccurrence.categoryPassages >= ENTITY_MIN_CATEGORY_PASSAGES;

  const detail: GeoEntityDetail = {
    slug: "entity",
    nodes: detailNodes,
    sameas_coverage: sameasCoverage === null ? null : round4(sameasCoverage),
    authority: { score: suppressed ? null : authority, suppressed, reason },
    disambiguation: {
      risk: riskRaw === null ? null : round4(riskRaw),
      level,
      name_matches: input.nameMatches,
      not_about_brand: input.notAboutBrand,
      minimum_matches: ENTITY_MIN_NAME_MATCHES,
    },
    cooccurrence: {
      sufficient: coSufficient,
      reason: coSufficient
        ? null
        : input.cooccurrence.terms.length === 0
          ? "No category terms are known for this project (no category or verticals set), so co-occurrence cannot be measured."
          : `Needs ${String(ENTITY_MIN_CATEGORY_PASSAGES)} cited passages that contain a category term; the corpus has ${String(input.cooccurrence.categoryPassages)}.`,
      terms: input.cooccurrence.terms,
      category_passages: input.cooccurrence.categoryPassages,
      entities,
    },
  };

  // ---- findings: each evidenced, each ending in a task rule or a no-action verdict ----
  const home = `https://${input.rootDomain}/`;
  const findings: GeoFinding[] = [];

  if (suppressed) {
    findings.push({
      id: "entity-alias-tuning",
      severity: "high",
      headline: `${pct(riskRaw!)} of the mentions matching the brand's name are not about it. Tune the brand's aliases and negative aliases before trusting any mention-based figure.`,
      detail: reason!,
      evidence: [{ url: home, snippet: `${String(input.notAboutBrand)} of ${String(input.nameMatches)} name matches were judged not to be about this brand.` }],
      metric: { name: "disambiguation_risk", value: round4(riskRaw!), target: DISAMBIGUATION_HIGH_ABOVE },
      task_rule_code: ENTITY_ALIAS_TASK_RULE,
    });
  }

  for (const n of nodes) {
    if (n.present || ENTITY_NODE_WEIGHTS[n.node] < ENTITY_ALERT_MIN_WEIGHT) continue;
    findings.push({
      id: `entity-node-missing-${n.node}`,
      severity: "medium",
      headline: `No ${NODE_LABEL[n.node]} profile was found (weight ${String(ENTITY_NODE_WEIGHTS[n.node])} of the Entity Authority score).`,
      detail: fixPath(n, false)!,
      evidence: [{ url: home, snippet: `${NODE_LABEL[n.node]} was checked for this brand and no profile was found.` }],
      metric: { name: "node_weight", value: ENTITY_NODE_WEIGHTS[n.node], target: ENTITY_ALERT_MIN_WEIGHT },
      task_rule_code: ENTITY_NODE_TASK_RULE,
    });
  }

  const linkGaps = detailNodes.filter((n) => n.link_gap);
  if (linkGaps.length > 0) {
    findings.push({
      id: "entity-link-gap",
      severity: "low",
      headline: `${String(linkGaps.length)} ${linkGaps.length === 1 ? "profile exists" : "profiles exist"} that the brand's own structured data does not link to (${linkGaps.map((n) => NODE_LABEL[n.node]).join(", ")}). Adding the sameAs links is minutes of work.`,
      evidence: linkGaps.map((n) => ({ url: n.url ?? home, snippet: `${NODE_LABEL[n.node]} profile is not in the brand's sameAs.` })),
      metric: { name: "link_gap_nodes", value: linkGaps.length },
      // The fix is a sameAs patch, produced by the AUX audit (AUX-R-034 / the sameAs patch) and not by a task of its own.
      no_action: true,
    });
  }

  const brand = entities.find((e) => e.is_brand);
  const rivals = entities.filter((e) => !e.is_brand && e.rate !== null);
  const topRival = rivals.reduce<(typeof rivals)[number] | undefined>((best, e) => (best === undefined || e.rate! > best.rate! ? e : best), undefined);
  if (coSufficient && brand?.rate != null && topRival !== undefined && topRival.rate! > brand.rate) {
    findings.push({
      id: "entity-category-cooccurrence",
      severity: "info",
      headline: `The brand appears in ${pct(brand.rate)} of the cited passages about the category; ${topRival.name} appears in ${pct(topRival.rate!)}. Engines may know the brand without associating it with the category.`,
      detail: "Reported to explain the gap; it generates no task of its own.",
      evidence: [{ url: home, snippet: `${String(brand.passages)} of ${String(input.cooccurrence.categoryPassages)} category passages name the brand.` }],
      metric: { name: "brand_cooccurrence_rate", value: brand.rate },
      no_action: true,
    });
  }

  // The detail rides on the first finding, so a row with none would drop it: a ready brand gets an explicit no-action verdict.
  if (findings.length === 0) {
    findings.push({
      id: "entity-ready",
      severity: "info",
      headline: `Entity Authority is ${String(authority)}: no high-weight profile is missing, no profile is unlinked, and disambiguation risk is not high.`,
      detail: "Reported so the analysis states its verdict; it generates no task.",
      evidence: [{ url: home, snippet: `${String(presentNodes.length)} of ${String(nodes.length)} scored nodes are present.` }],
      metric: { name: "authority_score", value: authority },
      no_action: true,
    });
  }

  return {
    write: {
      ...base,
      score: suppressed ? null : authority,
      evidence_cells: input.nameMatches,
      evidence_passages: input.cooccurrence.categoryPassages,
      sufficient: true,
      suppression_reason: reason,
      findings: findings.map((f, i) => (i === 0 ? { ...f, entity: detail } : f)),
      lever_rank: null,
    },
    detail,
  };
}

// ------------------------------------------------------------ node records

/** What a profile check found. `url` null means no profile exists. */
export interface EntityCheck {
  node: StoredEntityNode;
  url: string | null;
  missingFields: string[];
}

/** Host without `www.`, path without a trailing slash, no fragment or query: the identity of a profile URL. */
function normaliseProfileUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.hostname.toLowerCase().replace(/^www\./u, "")}${u.pathname.replace(/\/+$/u, "").toLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * Pure: a check result as an `entity_nodes` row. Presence and completeness are recorded separately; a profile missing
 * `ENTITY_THIN_MISSING_FIELDS` or more core fields is incomplete. `in_brand_sameas` is true only for a profile that
 * exists and whose normalised URL is one of the brand's own `sameAs` links.
 */
export function deriveNodeRecord(check: EntityCheck, brandSameAs: readonly string[]): EntityNodeRecord {
  if (check.url === null) return { node: check.node, present: false, complete: false, url: null, missingFields: [], inBrandSameas: false };
  const own = normaliseProfileUrl(check.url);
  return {
    node: check.node,
    present: true,
    complete: check.missingFields.length < ENTITY_THIN_MISSING_FIELDS,
    url: check.url,
    missingFields: check.missingFields,
    inBrandSameas: own !== null && brandSameAs.some((s) => normaliseProfileUrl(s) === own),
  };
}

/**
 * The one write path into `entity_nodes`: upserts each check on the composite key so a re-check REPLACES. Runs in the
 * caller's tenant transaction; the checks were made BEFORE it opened (no network call is made here).
 */
export async function writeEntityNodes(tx: ClientBase, projectId: string, checks: readonly EntityCheck[], brandSameAs: readonly string[]): Promise<EntityNodeRecord[]> {
  const records = checks.map((c) => deriveNodeRecord(c, brandSameAs));
  for (const r of records) {
    const res = await tx.query(
      `INSERT INTO entity_nodes (workspace_id, project_id, node, present, complete, url, missing_fields, in_brand_sameas, last_checked_at)
       SELECT p.workspace_id, p.id, $2, $3, $4, $5, $6::text[], $7, clock_timestamp()
         FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL
       ON CONFLICT (project_id, node) DO UPDATE SET
         present = EXCLUDED.present, complete = EXCLUDED.complete, url = EXCLUDED.url,
         missing_fields = EXCLUDED.missing_fields, in_brand_sameas = EXCLUDED.in_brand_sameas, last_checked_at = clock_timestamp()`,
      [projectId, r.node, r.present, r.complete, r.url, r.missingFields, r.inBrandSameas],
    );
    if (res.rowCount === 0) throw new NotFoundError({ message: "no such project" });
    incrementCounter("nominara_geo_entity_node_checked_total", { node: r.node, present: String(r.present) });
  }
  return records;
}

// ------------------------------------------------------ name-match judging

/**
 * BUILDER READING (v1): the reference defines the risk as the share of name matches "NOT about this brand" without
 * saying how a match is judged. The only signal the stored facts carry for free is case: the parser folds case when it
 * matches, so a lowercase span of a capitalised name ("notion" for "Notion") is the common word, not the brand. An
 * alias with no uppercase letter carries no such signal and is never guessed to be a false positive. A model-assisted
 * judge would sit behind this same signature, run outside the transaction, and is not built.
 */
export function judgeNameMatch(match: { alias: string; span: string }): "about_brand" | "not_about_brand" {
  const aliasIsCased = match.alias !== match.alias.toLowerCase();
  const spanIsLower = match.span !== "" && match.span === match.span.toLowerCase() && match.span !== match.span.toUpperCase();
  return aliasIsCased && spanIsLower ? "not_about_brand" : "about_brand";
}

// ------------------------------------------------------------------ loader

interface NodeRow {
  node: StoredEntityNode;
  present: boolean;
  complete: boolean;
  url: string | null;
  missing_fields: string[];
  in_brand_sameas: boolean;
}

/** A word-bounded, case-insensitive POSIX pattern for a literal term. Bound as a parameter, never concatenated into SQL. */
const termPattern = (term: string): string => `\\m${term.replace(/[^A-Za-z0-9\s]/gu, "\\$&")}\\M`;

/** Category terms from the project's own category and verticals; empty when it set neither. */
export function categoryTerms(categorySlug: string | null, verticals: readonly string[]): string[] {
  const fromSlug = categorySlug === null ? [] : [categorySlug.replace(/[-_]+/gu, " ").trim()];
  return [...new Set([...fromSlug, ...verticals].map((t) => t.trim().toLowerCase()).filter((t) => t !== ""))];
}

/** Reads the window's facts. Must run inside the ambient tenant transaction: RLS is the guarantee, `project_id` is for the planner. */
export async function loadEntityInput(tx: ClientBase, projectId: string, windowStart: string, windowDays: 7 | 30 | 90): Promise<EntityInput> {
  const project = await tx.query<{ root_domain: string; name: string; brand_aliases: string[]; category_slug: string | null; verticals: string[] }>(
    "SELECT root_domain, name, brand_aliases, category_slug, verticals FROM projects WHERE id = $1 AND deleted_at IS NULL",
    [projectId],
  );
  const p = project.rows[0];
  if (p === undefined) throw new NotFoundError({ message: "no such project" });

  const nodes = await tx.query<NodeRow>(
    "SELECT node, present, complete, url, missing_fields, in_brand_sameas FROM entity_nodes WHERE project_id = $1 ORDER BY node",
    [projectId],
  );

  // Only the matched span is pulled out of the answer text, grouped: the text itself never leaves the database.
  const matches = await tx.query<{ matched_alias: string; span: string | null; n: number }>(
    `SELECT mf.matched_alias,
            substr(ac.payload ->> 'text', mf.char_start + 1, mf.char_end - mf.char_start) AS span,
            count(*)::int AS n
       FROM mention_facts mf
       JOIN answer_captures ac ON ac.id = mf.result_id AND ac.captured_at = mf.captured_at
      WHERE mf.project_id = $1 AND mf.entity_type = 'brand' AND mf.scoring_version = $4
        AND mf.captured_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
        AND mf.captured_at <  ($2::date::timestamp AT TIME ZONE 'UTC') + make_interval(days => $3)
      GROUP BY mf.matched_alias, span`,
    [projectId, windowStart, windowDays, SCORING_VERSION],
  );
  // The parser may store the folded alias; judge against the cased spelling the project actually holds.
  const cased = new Map([p.name, ...p.brand_aliases].map((a) => [a.toLowerCase(), a]));
  let nameMatches = 0;
  let notAboutBrand = 0;
  for (const m of matches.rows) {
    nameMatches += m.n;
    // A span that cannot be read (answer text no longer held) is counted as a match and never as a false positive.
    if (m.span !== null && judgeNameMatch({ alias: cased.get(m.matched_alias.toLowerCase()) ?? m.matched_alias, span: m.span }) === "not_about_brand") notAboutBrand += m.n;
  }

  const terms = categoryTerms(p.category_slug, p.verticals);
  const termPatterns = terms.map(termPattern);
  const passagesNaming = async (aliases: readonly string[]): Promise<number> => {
    const patterns = aliases.filter((a) => a.trim() !== "").map(termPattern);
    if (termPatterns.length === 0 || patterns.length === 0) return 0;
    const res = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM corpus_passages cp
        WHERE cp.project_id = $1 AND cp.expires_at > clock_timestamp()
          AND cp.text ~* ANY($2::text[]) AND cp.text ~* ANY($3::text[])`,
      [projectId, termPatterns, patterns],
    );
    return res.rows[0]!.n;
  };
  let categoryPassages = 0;
  if (termPatterns.length > 0) {
    categoryPassages = (
      await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM corpus_passages cp WHERE cp.project_id = $1 AND cp.expires_at > clock_timestamp() AND cp.text ~* ANY($2::text[])",
        [projectId, termPatterns],
      )
    ).rows[0]!.n;
  }
  const competitors = await tx.query<{ name: string; aliases: string[] }>(
    "SELECT name, aliases FROM competitors WHERE project_id = $1 AND deleted_at IS NULL ORDER BY lower(name), id",
    [projectId],
  );
  const entities = [{ name: p.name, isBrand: true, aliases: [p.name, ...p.brand_aliases] }, ...competitors.rows.map((c) => ({ name: c.name, isBrand: false, aliases: [c.name, ...c.aliases] }))];

  const counted: { name: string; isBrand: boolean; passages: number }[] = [];
  for (const e of entities) counted.push({ name: e.name, isBrand: e.isBrand, passages: await passagesNaming(e.aliases) });

  return {
    windowStart,
    windowDays,
    rootDomain: p.root_domain,
    nodes: nodes.rows.map((r) => ({ node: r.node, present: r.present, complete: r.complete, url: r.url, missingFields: r.missing_fields, inBrandSameas: r.in_brand_sameas })),
    nameMatches,
    notAboutBrand,
    cooccurrence: {
      terms,
      categoryPassages,
      entities: counted,
    },
  };
}
