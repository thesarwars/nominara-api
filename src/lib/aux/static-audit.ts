import type { AuxRuleFinding, SiteFileFinding } from "../../../contracts/aux/index.js";
import { AUX_HARD_CAP, auxDecidedBasis, auxScore, type AuxCategory, type AuxCountedFinding } from "../scoring/aux.js";
import type { AuxCatalog } from "./catalog.js";
import { buildAuxDocument, type AuxDocument } from "./document-model.js";
import { evaluablePageRules } from "./page-rules.js";
import { AuxRuleEvaluationError, evaluateDocument } from "./rules/engine.js";
import { AUX_RULES, AUX_RULES_NOT_EVALUATED, AUX_RULES_PARTIAL } from "./rules/index.js";
import { byCodePoint } from "./rules/helpers.js";
import { evaluateSiteFiles, type SiteFile } from "./site-files.js";
import { robotsHeaderKey, robotsTagsFor, type HostHeaderRule } from "./static-host-headers.js";
import { cl100kTokenizer } from "./tokenizer-cl100k.js";

// STORY-102 AC10 / owner decision 68(j) - the AUX audit over a directory of BUILT STATIC HTML, with the real rule engine and document model.
//
// PURE: the file contents go in, the report comes out. No fetch, no database, no clock of its own (`now` is passed), no model call. The directory
// walk and the argument handling are in static-audit-cli.ts; nothing here touches a file.
//
// WHAT IS EVALUATED AND WHAT IS NOT. The 22 document-model rules run over every page, and the five site-file rules (AUX-R-001, 002, 003, 004, 007)
// run over robots.txt, llms.txt and the sitemap as the directory holds them; a file the directory does not hold is judged as the deployed site
// would answer for it, a 404, which is what the real crawl does. A rule that needs something a static directory cannot give is reported as NOT EVALUATED
// with its reason, never as passed, and it is out of the score's basis, so it neither costs nor earns points:
//   - AUX-R-026 / 027 compare the rendered copy with the plain one: there is no rendered copy (no browser runs here);
//   - AUX-R-029 judges the response (time to first byte, size): a file on disk has no response;
//   - the rules in AUX_RULES_NOT_EVALUATED need inputs no single page holds (the cited corpus, brand aliases, the whole domain) or are an owner decision.
// Response HEADERS are not in a directory either, EXCEPT the ones a static host declares in a file that ships with the build (`_headers`,
// or `headers` in `vercel.json`; static-host-headers.ts). When one is present its X-Robots-Tag lines are applied to the pages they cover and AUX-R-006
// sees them; when none is, a noai directive delivered by header is not seen, AUX-R-006 is listed in `rules_partial` with that reason, and
// `limitations` says so in the output. The score is therefore PARTIAL by the reference's own definition (`partial: true`): it is the same arithmetic
// as the audit the platform runs (scoring-models.md section 7, owner decisions 38, 52, 55, 57), over the rules that could be decided here.

/** What the directory walk found. Paths are URL paths from the site root, e.g. `/`, `/about/`, `/pricing.html`. */
export interface StaticAuditInput {
  readonly pages: ReadonlyArray<{ readonly path: string; readonly html: string }>;
  /** The text of each site file, or null when the directory does not hold it. */
  readonly siteFiles: { readonly robots: string | null; readonly llms: string | null; readonly llmsWellKnown: string | null; readonly sitemap: string | null };
  /** The origin the pages will be served from, no trailing slash. It sets each page's URL (same-site tests, canonical comparison). */
  readonly baseUrl: string;
  readonly now: Date;
  readonly catalog: AuxCatalog;
  /**
   * The X-Robots-Tag rules of the host's headers file, or null/absent when the directory has none. Null is NOT "no headers": it means headers were not
   * seen, which is what `rules_partial` and `limitations` then say.
   */
  readonly hostHeaders?: readonly HostHeaderRule[] | null;
}

export interface StaticAuditFinding {
  readonly rule_code: string;
  readonly category: string;
  readonly severity: string;
  readonly url: string;
  readonly measured_value: number | null;
  readonly threshold_value: number | null;
  readonly reason: string;
  readonly locator: string;
  readonly snippet: string | null;
}

export interface StaticAuditReport {
  readonly score: number;
  /** True whenever any rule went unmeasured, which is always the case for a static directory (see the header). */
  readonly partial: boolean;
  readonly score_capped: boolean;
  readonly breakdown: Readonly<Partial<Record<AuxCategory, number>>>;
  readonly unmeasured_categories: readonly string[];
  readonly pages_audited: number;
  /** Pages the rules could not model (a rule crashed on that page's markup): reported, never silently dropped. Reason codes only. */
  readonly pages_unmodelled: ReadonlyArray<{ readonly url: string; readonly reason: string }>;
  readonly site_files: Readonly<Record<"robots.txt" | "llms.txt" | "sitemap.xml", "present" | "absent">>;
  readonly findings: readonly StaticAuditFinding[];
  readonly rules_evaluated: readonly string[];
  readonly rules_not_evaluated: ReadonlyArray<{ readonly rule_code: string; readonly reason: string }>;
  /** Rules that ran on an interim reading (they cover part of their reference row). */
  readonly rules_partial: ReadonlyArray<{ readonly rule_code: string; readonly reason: string }>;
  readonly limitations: readonly string[];
}

export class StaticAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaticAuditError";
  }
}

const SITE_FILE_RULES: readonly string[] = ["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-004", "AUX-R-007"];
const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
type Severity = (typeof SEVERITIES)[number];
/** Findings carry a project id only to build the guidance text this report does not print. */
const NO_PROJECT = "00000000-0000-7000-8000-000000000000";

const NO_HEADERS_LIMITATION = "No response headers: a directive delivered by header (X-Robots-Tag) is not seen. A host headers file (_headers or vercel.json) in the directory would be read.";
const HEADERS_FILE_LIMITATION =
  "Response headers come only from the host headers file in the directory (X-Robots-Tag is read from it); a header the host adds any other way is not seen.";
const limitationsFor = (hostHeaders: readonly HostHeaderRule[] | null): readonly string[] => [
  "No rendered copy: a browser does not run, so AUX-R-026 and AUX-R-027 are not evaluated.",
  "No response: a file on disk has no time to first byte, so AUX-R-029 is not evaluated.",
  hostHeaders === null ? NO_HEADERS_LIMITATION : HEADERS_FILE_LIMITATION,
  "The score is partial by definition: it is computed over the rules that could be decided here, and rules that could not are listed, not passed.",
];

/** AUX-R-006's reason when no host headers file was read: the header half of the rule is blind, whatever else is true of it. */
const AUX_R_006_HEADER_REASON =
  "X-Robots-Tag is a response header and this directory holds no response, so a noai directive delivered by header is not seen; only the robots meta tag is read. A host headers file (_headers or vercel.json) in the directory would be read.";

const siteFile = (text: string | null): SiteFile => (text === null ? { status: 404, body: "" } : { status: 200, body: text });

export async function runStaticAudit(input: StaticAuditInput): Promise<StaticAuditReport> {
  if (input.pages.length === 0) throw new StaticAuditError("no HTML pages to audit");
  const { catalog } = input;
  const hostHeaders = input.hostHeaders ?? null;

  // --- the pages -----------------------------------------------------------------------------------------------------------------------
  const pageFindings: AuxRuleFinding[] = [];
  const evaluated = new Map<string, ReadonlySet<string>>();
  const unmodelled: Array<{ url: string; reason: string }> = [];
  for (const page of input.pages) {
    const url = `${input.baseUrl}${page.path}`;
    // One header-record entry per X-Robots-Tag line (the model reads every key that is `x-robots-tag` in any case), so a scope one line opens cannot
    // swallow the next.
    const headers: Record<string, string> = {};
    if (hostHeaders !== null) robotsTagsFor(hostHeaders, page.path).forEach((value, i) => (headers[robotsHeaderKey(i)] = value));
    let document: AuxDocument;
    try {
      document = buildAuxDocument(
        { url, finalUrl: url, httpStatus: 200, redirectChain: [], headers, rawHtml: page.html, renderedHtml: null, timing: { ttfbMs: null, loadMs: null } },
        cl100kTokenizer,
      );
    } catch {
      unmodelled.push({ url, reason: "model_failed" });
      continue;
    }
    try {
      pageFindings.push(...(await evaluateDocument(document, catalog, AUX_RULES, { projectId: NO_PROJECT })));
      evaluated.set(url, evaluablePageRules(document));
    } catch (error) {
      // A rule that cannot RUN (no catalog row, a threshold that does not parse) is a configuration fault: fail closed. A rule that crashes on
      // one page's markup is that page's problem, as in the platform audit: reported, and the others are still audited.
      if (!(error instanceof AuxRuleEvaluationError)) throw error;
      unmodelled.push({ url, reason: `rule_error:${error.ruleCode}` });
    }
  }
  if (evaluated.size === 0) throw new StaticAuditError("no page could be modelled");

  // --- the site files ------------------------------------------------------------------------------------------------------------------
  const robotsText = input.siteFiles.robots;
  const siteFindings: SiteFileFinding[] = evaluateSiteFiles({
    robots: siteFile(robotsText),
    llmsTxt: siteFile(input.siteFiles.llms),
    llmsTxtWellKnown: siteFile(input.siteFiles.llmsWellKnown),
    sitemap: siteFile(input.siteFiles.sitemap),
    sitemapDeclaredInRobots: robotsText !== null && /^\s*sitemap\s*:/im.test(robotsText),
    trackedPaths: input.pages.map((p) => p.path),
    now: input.now,
  });

  // --- the rules that were decided, and the ones that were not --------------------------------------------------------------------------
  const decidedAnywhere = new Set<string>();
  for (const rules of evaluated.values()) for (const code of rules) decidedAnywhere.add(code);
  const decided = new Set<string>([...SITE_FILE_RULES, ...decidedAnywhere]);
  const categoryOf = (code: string): AuxCategory => (catalog.byCode.get(code)?.category ?? "crawler_access") as AuxCategory;

  const notEvaluatedReason = (code: string): string => {
    if (code in AUX_RULES_NOT_EVALUATED) return AUX_RULES_NOT_EVALUATED[code]!;
    if (code === "AUX-R-026" || code === "AUX-R-027") return "Needs a rendered copy of the page; a static directory has none.";
    if (code === "AUX-R-029") return "Judges the response (time to first byte, size); a file on disk has no response.";
    return "Not evaluated by this audit.";
  };
  const notEvaluated = catalog.rules
    .filter((rule) => !decided.has(rule.code))
    .map((rule) => ({ rule_code: rule.code, reason: notEvaluatedReason(rule.code) }))
    .sort((a, b) => byCodePoint(a.rule_code, b.rule_code));
  const partialRules = Object.entries(AUX_RULES_PARTIAL)
    .filter(([code]) => decided.has(code))
    .map(([rule_code, reason]) => ({ rule_code, reason: rule_code === "AUX-R-006" && hostHeaders === null ? `${AUX_R_006_HEADER_REASON} ${reason}` : reason }))
    .sort((a, b) => byCodePoint(a.rule_code, b.rule_code));

  // --- the score: the platform audit's own arithmetic (crawl-audit.handler.ts `commit`), over what was decided -------------------------------
  const pagesForScore = Math.max(1, evaluated.size);
  const counted: AuxCountedFinding[] = [];
  let capped = false;
  for (const f of siteFindings) {
    if (categoryOf(f.rule_code) === "crawler_access" && f.severity === "critical") capped = true;
    // A site-file finding is domain-wide: it affects every page audited (scope 1).
    counted.push({ category: categoryOf(f.rule_code), severity: f.severity, ruleWeight: catalog.byCode.get(f.rule_code)?.weight ?? 0, affectedPages: pagesForScore });
  }
  // A page rule opens one finding per place on a page; they fold back to ONE counted finding per rule - its worst severity over the distinct pages it
  // affects - or a rule broken on three pages would weigh three times its share.
  const perRule = new Map<string, { severity: Severity; urls: Set<string> }>();
  for (const f of pageFindings) {
    if (categoryOf(f.rule_code) === "crawler_access" && f.severity === "critical") capped = true;
    const seen = perRule.get(f.rule_code) ?? { severity: f.severity, urls: new Set<string>() };
    if (SEVERITIES.indexOf(f.severity) > SEVERITIES.indexOf(seen.severity)) seen.severity = f.severity;
    seen.urls.add(f.url);
    perRule.set(f.rule_code, seen);
  }
  for (const [code, { severity, urls }] of perRule) {
    counted.push({ category: categoryOf(code), severity, ruleWeight: catalog.byCode.get(code)?.weight ?? 0, affectedPages: Math.min(pagesForScore, urls.size) });
  }

  // Summed in catalog order (integer basis points inside auxDecidedBasis): identical inputs give a bit-identical score.
  const basis = auxDecidedBasis(catalog.rules.filter((rule) => decided.has(rule.code)).map((rule) => ({ category: rule.category as AuxCategory, weight: rule.weight })));
  const categoryMaxPenalty: Partial<Record<AuxCategory, number>> = { ...basis.categoryMaxPenalty };
  for (const category of basis.categories) {
    if (catalog.rules.filter((rule) => rule.category === category).every((rule) => decided.has(rule.code))) categoryMaxPenalty[category] = 1;
  }
  const scored = auxScore({
    findings: counted,
    pagesCrawled: pagesForScore,
    evaluatedCategories: basis.categories,
    categoryMaxPenalty,
    unmeasuredRules: notEvaluated.map((r) => r.rule_code),
  });
  const scoreCapped = capped && basis.categories.includes("crawler_access");
  const score = scoreCapped ? Math.min(scored.score, AUX_HARD_CAP) : scored.score;
  const breakdown: Partial<Record<AuxCategory, number>> = {};
  for (const category of basis.categories) breakdown[category] = scored.subscores[category];

  // --- the findings, in a fixed order ---------------------------------------------------------------------------------------------------
  const out: StaticAuditFinding[] = [
    ...pageFindings.map((f) => ({
      rule_code: f.rule_code,
      category: categoryOf(f.rule_code),
      severity: f.severity,
      url: f.url,
      measured_value: f.measured_value,
      threshold_value: f.threshold_value,
      reason: f.evidence.reason,
      locator: f.evidence.locator,
      snippet: f.evidence.snippet,
    })),
    ...siteFindings.map((f) => ({
      rule_code: f.rule_code,
      category: categoryOf(f.rule_code),
      severity: f.severity,
      url: [input.baseUrl, f.evidence.file].join("/"),
      measured_value: f.measured_value,
      threshold_value: f.threshold_value,
      reason: f.evidence.reason,
      locator: f.evidence.line === null ? f.evidence.file : `${f.evidence.file}:${String(f.evidence.line)}`,
      snippet: f.evidence.snippet,
    })),
  ].sort((a, b) => byCodePoint(a.url, b.url) || byCodePoint(a.rule_code, b.rule_code) || byCodePoint(a.locator, b.locator));

  return {
    score,
    partial: scored.partial,
    score_capped: scoreCapped,
    breakdown,
    unmeasured_categories: scored.unmeasured,
    pages_audited: evaluated.size,
    pages_unmodelled: unmodelled,
    site_files: {
      "robots.txt": input.siteFiles.robots === null ? "absent" : "present",
      "llms.txt": input.siteFiles.llms === null && input.siteFiles.llmsWellKnown === null ? "absent" : "present",
      "sitemap.xml": input.siteFiles.sitemap === null ? "absent" : "present",
    },
    findings: out,
    rules_evaluated: [...decided].sort(byCodePoint),
    rules_not_evaluated: notEvaluated,
    rules_partial: partialRules,
    limitations: limitationsFor(hostHeaders),
  };
}
