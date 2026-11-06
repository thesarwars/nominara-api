import { createHash } from "node:crypto";
import type { AuxRuleFinding, CrawlManifest, SiteFileFinding } from "../../../contracts/aux/index.js";
import {
  auxAuditToolResultSchema,
  type AuxAuditToolResult,
  type AuxSiteFilesAccess,
  type AuxToolFinding,
  type AuxToolPatch,
} from "../../../contracts/tools/index.js";
import { guardedFetch, type GuardedFetchInit, type GuardedResponse } from "../net/guarded-fetch.js";
import { toRegistrableDomain } from "../net/registrable-domain.js";
import { AUX_CATEGORY_WEIGHTS, AUX_HARD_CAP, auxDecidedBasis, auxScore, type AuxCategory, type AuxCountedFinding } from "../scoring/aux.js";
import { auxAuditEstimate } from "../aux/audit-band.js";
import { loadAuxCatalog } from "../aux/catalog.js";
import { findingView } from "../aux/finding-view.js";
import { crawlPages, NOMINARA_USER_AGENT, type PageRecord } from "../aux/page-crawl.js";
import { runPageRules } from "../aux/page-rules.js";
import { generateSiteFilePatch } from "../aux/patches/generate.js";
import { PatchRejectedError, type PatchDraft } from "../aux/patches/types.js";
import { pageCapForPlan, selectPages, type SelectionScope } from "../aux/page-selection.js";
import { PolitenessBudget, PolitenessCapReached, PolitenessDeadlineReached } from "../aux/politeness.js";
import { unavailableRenderer, type Renderer } from "../aux/renderer.js";
import { CRAWL_AGENT, crawlDelayFor, isAllowed, parseRobots, sitemapUrlsOf, type ParsedRobots } from "../aux/robots.js";
import { sanitiseText } from "../aux/sanitise.js";
import { AUX_RULES, AUX_RULES_NOT_EVALUATED } from "../aux/rules/index.js";
import { AI_CRAWLER_AGENTS, evaluateSiteFiles, type SiteFile } from "../aux/site-files.js";
import { collectSitemap, MAX_SITEMAP_FILES, SitemapFetchSkipped, type SitemapResult } from "../aux/sitemap.js";

// STORY-082 - the AUX audit tool's fetch-and-judge core, in the worker's `run` phase (no transaction, no client).
//
// IT IS THE EXISTING AUDIT ENGINE, WITHOUT A PROJECT. Every request goes through the SSRF-guarded fetcher (src/lib/net) via the same politeness budget, the same
// site-file evaluators, the same page crawl (raw AND rendered), the same 22 document-model rules, the same score function and the same patch generators the
// in-project `crawl.audit` uses; the findings are shaped by the same renderer (finding-view.ts). There is NO second fetch path: this file imports `guardedFetch`
// and no socket module, and the unit test asserts it. What it does not do is persist anything of its own - no `aux_audits` row, no `aux_findings`, no `patches`,
// no object-store copy (the pages are held in memory for the rules and dropped) - because a tool run is not tracked (FR-TL-11): the result lives in `tool_runs`.
//
// VERIFICATION CONTROLS SCOPE, NOT PRICE. The caller says whether the domain is verified; that selects `key_pages` or `public_surface` and nothing else. The
// score is computed over the rules that were DECIDED (owner decisions 38, 52, 55), so it is labelled partial whenever any rule went unmeasured, and the points
// the unmeasured rules carry are stated.
//
// THE RESULT FITS A 24 KB COLUMN (app.assert_jsonb_size, 24576 bytes of jsonb text). Findings are kept in severity order until the budget is spent; the rest are
// counted in `findings_omitted`, never dropped silently.

const FETCH_TIMEOUT_MS = 10_000;
/** NOT FROM THE REFERENCE - the same provisional wall-clock budget the in-project audit uses (crawl-audit.handler.ts). */
const WALL_CLOCK_BUDGET_MS = 10 * 60 * 1000;
/** jsonb text is a little longer than JSON.stringify (a space after each colon and comma), so the stringified result is held well under 24576. */
const RESULT_BUDGET_BYTES = 20_000;
const SITE_FILE_RULES = ["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-004", "AUX-R-007"] as const;
const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

export interface ToolCatalogRow {
  readonly code: string;
  readonly category: string;
  readonly title: string;
  readonly weight: number;
  readonly rule_version: string;
  readonly thresholds: Record<string, unknown>;
  readonly task_threshold: string;
  readonly auto_fixable: boolean;
  /** The AI consequence, in customer language. */
  readonly rationale: string | null;
}

export interface ToolAuditInput {
  readonly url: string;
  readonly mode: "site_files" | "full";
  /** The requested page count (full mode). */
  readonly pages: number;
  readonly verified: boolean;
  /** What the run was charged; stated in the result, never decided here. */
  readonly credits: number;
  readonly catalog: readonly ToolCatalogRow[];
}

export interface ToolAuditDeps {
  readonly fetch?: (url: string, init?: GuardedFetchInit) => Promise<GuardedResponse>;
  readonly renderer?: Renderer;
  readonly now?: () => Date;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly wallClockBudgetMs?: number;
}

export type ToolAuditOutcome =
  /** Not one site file answered: nothing was audited, nothing delivered. */
  | { readonly kind: "unreachable" }
  | { readonly kind: "done"; readonly result: AuxAuditToolResult; readonly delivered: boolean; readonly auxScore: number | null; readonly pagesScanned: number; readonly requests: number };

type Fetched = { readonly responded: true; readonly status: number; readonly file: SiteFile; readonly raw: Buffer } | { readonly responded: false };

function sameSite(a: string, b: string): boolean {
  try {
    return toRegistrableDomain(a) === toRegistrableDomain(b);
  } catch {
    return false;
  }
}

const reasonFor = (code: string, notEvaluated: Readonly<Record<string, string>>): string | undefined => notEvaluated[code];

export async function runToolAudit(input: ToolAuditInput, deps: ToolAuditDeps = {}): Promise<ToolAuditOutcome> {
  const fetchOne = deps.fetch ?? ((url: string, init?: GuardedFetchInit) => guardedFetch(url, init));
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const renderer = deps.renderer ?? unavailableRenderer;
  const full = input.mode === "full";
  const target = new URL(input.url);
  const origin = target.origin;
  const rootUrl = target.href;
  const host = target.hostname.toLowerCase();
  const identified: GuardedFetchInit = { headers: { "user-agent": NOMINARA_USER_AGENT } };
  // Site files and sitemaps stay on the site: a redirect off it is not followed.
  const siteInit: GuardedFetchInit = { ...identified, followRedirect: (next) => sameSite(next, origin) };

  const bounded = async (url: string, init: GuardedFetchInit): Promise<GuardedResponse> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("aux audit tool: fetch timeout")), timeoutMs);
      });
      return await Promise.race([fetchOne(url, init), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const boundedOrNull = async (url: string, init: GuardedFetchInit): Promise<GuardedResponse | null> => {
    try {
      return await bounded(url, init);
    } catch {
      // A refusal, DNS failure or timeout is OUR fetch failing: not evidence about the site.
      return null;
    }
  };
  const toFetched = (res: GuardedResponse | null): Fetched =>
    res === null ? { responded: false } : { responded: true, status: res.status, file: { status: res.status, body: res.body.toString("utf8"), byteLength: res.body.length }, raw: res.body };

  const requestsPerPage = renderer.available === false ? 1 : 2;
  const pageCap = full ? input.pages : 0;
  const budget = new PolitenessBudget({
    hardCap: 3 + MAX_SITEMAP_FILES + requestsPerPage * pageCap,
    wallClockBudgetMs: deps.wallClockBudgetMs ?? WALL_CLOCK_BUDGET_MS,
    ...(deps.nowMs === undefined ? {} : { now: deps.nowMs }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });

  // SITE FILES - always, sequentially, each charged to the one budget.
  const siteFile = async (url: string): Promise<Fetched> => {
    try {
      await budget.acquire("site_file");
    } catch (error) {
      if (error instanceof PolitenessDeadlineReached || error instanceof PolitenessCapReached) return { responded: false };
      throw error;
    }
    return toFetched(await boundedOrNull(url, siteInit));
  };
  const urls = { robots: new URL("/robots.txt", origin).href, llms: new URL("/llms.txt", origin).href, llmsWellKnown: new URL("/.well-known/llms.txt", origin).href, sitemap: new URL("/sitemap.xml", origin).href };
  const robots = await siteFile(urls.robots);
  const robotsOk = robots.responded && robots.status >= 200 && robots.status < 300;
  const parsedRobots: ParsedRobots | null = robotsOk ? parseRobots(robots.file.body) : null;
  if (parsedRobots !== null) budget.setCrawlDelay(crawlDelayFor(parsedRobots, CRAWL_AGENT));
  const llms = await siteFile(urls.llms);
  const llmsWellKnown = await siteFile(urls.llmsWellKnown);
  const declared = parsedRobots === null ? [] : sitemapUrlsOf(parsedRobots);
  const declaredOnSite = declared.filter((u) => sameSite(u, origin));
  const first: { value: { url: string; fetched: Fetched } | null } = { value: null };
  const sitemapResult: SitemapResult = await collectSitemap({
    origin,
    declared: declaredOnSite,
    fetch: async (url) => {
      try {
        await budget.acquire("site_file");
      } catch (error) {
        if (error instanceof PolitenessDeadlineReached) {
          first.value ??= { url, fetched: { responded: false } };
          throw new SitemapFetchSkipped();
        }
        throw error;
      }
      const res = await boundedOrNull(url, siteInit);
      first.value ??= { url, fetched: toFetched(res) };
      if (res === null) throw new Error("sitemap fetch failed");
      return { status: res.status, body: res.body };
    },
  });
  const sitemap: Fetched = first.value?.fetched ?? { responded: false };
  const sitemapUrl = first.value?.url ?? urls.sitemap;

  if ([robots, llms, llmsWellKnown, sitemap].every((f) => !f.responded)) return { kind: "unreachable" };

  const checkedAt = now();
  const siteFiles = siteFilesAccess({ robots, llms, llmsWellKnown, sitemap, parsedRobots, rootUrl, sitemapCount: sitemapResult.totalSeen, checkedAt });
  // Site-files mode audits no page, so it has no wider scope to be authorised for: the verification state is reported, the scope is the public surface.
  const scope: SelectionScope = full && input.verified ? "key_pages" : "public_surface";
  const base = { schema_version: 1 as const, mode: input.mode, url: input.url, host, domain_verified: input.verified, scope: scope === "key_pages" ? ("key_pages" as const) : ("public_surface" as const), site_files: siteFiles };

  if (!full) {
    const result = auxAuditToolResultSchema.parse({ ...base, audit: null });
    return { kind: "done", result, delivered: true, auxScore: null, pagesScanned: 0, requests: budget.used };
  }

  // THE CATALOG is versioned data: its weights are asserted on every load (NFR-AUX-03).
  const catalog = loadAuxCatalog(input.catalog.map((r) => ({ code: r.code, category: r.category, weight: r.weight, ruleVersion: r.rule_version, autoFixable: r.auto_fixable, thresholds: r.thresholds })));
  const rows = new Map(input.catalog.map((r) => [r.code, r]));

  // SELECT PAGES and FETCH TWICE (raw and rendered), through the existing page crawl.
  const selection = selectPages({ scope, rootUrl, cap: input.pages, sitemap: sitemapResult.urls, ownedCitationUrls: [], openTaskUrls: [], targetUrls: [] });
  const affordable = Math.max(0, Math.floor(budget.affordableRequests() / requestsPerPage));
  const pagesToCrawl = selection.urls.slice(0, affordable);
  const robotsForCrawl: ParsedRobots | "unavailable" | null = parsedRobots !== null ? parsedRobots : robots.responded && robots.status >= 400 && robots.status < 500 ? null : "unavailable";
  const copies = new Map<string, Buffer>();
  const crawl = await crawlPages(pagesToCrawl, {
    rootUrl,
    budget,
    robots: robotsForCrawl,
    renderer,
    fetch: (url, init) => bounded(url, init),
    store: async (relative, body, contentType) => {
      const key = ["tool-audit", relative].join("/");
      if (contentType === "application/gzip") copies.set(key, body);
      return key;
    },
    keyPrefix: createHash("sha256").update(input.url).digest("hex").slice(0, 16),
  });
  const manifestPages: CrawlManifest["pages"] = crawl.pages.map(toManifestPage);
  const pageRules = await runPageRules(
    manifestPages,
    async (key) => {
      const copy = copies.get(key);
      if (copy === undefined) throw new Error("page copy not held");
      return copy;
    },
    catalog,
    { projectId: "tool-audit" },
  );
  copies.clear();

  // FINDINGS: the site-file evaluators and the page rules.
  const asFile = (f: Fetched): SiteFile | null => (f.responded ? f.file : null);
  const siteFound = evaluateSiteFiles({ robots: asFile(robots), llmsTxt: asFile(llms), llmsTxtWellKnown: asFile(llmsWellKnown), sitemap: asFile(sitemap), sitemapDeclaredInRobots: declaredOnSite.length > 0, trackedPaths: ["/"], now: checkedAt });
  const covered = new Set<string>();
  if (robots.responded) covered.add("AUX-R-003");
  if (robots.responded && ((robots.status >= 200 && robots.status < 300) || robots.status === 404 || robots.status === 410)) {
    covered.add("AUX-R-001");
    covered.add("AUX-R-002");
  }
  if (llms.responded && llmsWellKnown.responded) covered.add("AUX-R-004");
  if (sitemap.responded) covered.add("AUX-R-007");
  const siteDetected = siteFound.filter((f) => covered.has(f.rule_code));

  const pagesJudged = pageRules.evaluated.size;
  const decidedAnywhere = new Set<string>();
  for (const decided of pageRules.evaluated.values()) for (const code of decided) decidedAnywhere.add(code);
  const decidedRules = new Set<string>(covered);
  if (pagesJudged > 0) for (const code of decidedAnywhere) decidedRules.add(code);

  // THE SCORE (owner decisions 38, 52, 55; scoring-models.md section 7): a category is scored on the rules that were decided, and the headline is partial whenever any rule went unmeasured.
  const pageCodes = new Set(AUX_RULES.map((r) => r.code));
  const asCategory = (code: string): AuxCategory => (catalog.byCode.get(code)?.category ?? "crawler_access") as AuxCategory;
  const pagesForScore = Math.max(1, pagesJudged);
  const counted: AuxCountedFinding[] = [];
  let anyCriticalAccess = false;
  for (const f of siteDetected) {
    if (asCategory(f.rule_code) === "crawler_access" && f.severity === "critical") anyCriticalAccess = true;
    counted.push({ category: asCategory(f.rule_code), severity: f.severity, ruleWeight: catalog.byCode.get(f.rule_code)?.weight ?? 0, affectedPages: pagesForScore });
  }
  const perRule = new Map<string, { severity: AuxCountedFinding["severity"]; urls: Set<string> }>();
  for (const f of pageRules.findings) {
    if (asCategory(f.rule_code) === "crawler_access" && f.severity === "critical") anyCriticalAccess = true;
    const seen = perRule.get(f.rule_code) ?? { severity: f.severity, urls: new Set<string>() };
    if (SEVERITY_ORDER.indexOf(f.severity) < SEVERITY_ORDER.indexOf(seen.severity)) seen.severity = f.severity;
    seen.urls.add(f.url);
    perRule.set(f.rule_code, seen);
  }
  for (const [code, { severity, urls: affected }] of perRule) counted.push({ category: asCategory(code), severity, ruleWeight: catalog.byCode.get(code)?.weight ?? 0, affectedPages: Math.min(pagesForScore, [...affected].filter((u) => pageRules.evaluated.has(u)).length) });
  const basis = auxDecidedBasis(catalog.rules.filter((rule) => decidedRules.has(rule.code)).map((rule) => ({ category: rule.category as AuxCategory, weight: rule.weight })));
  const categoryMaxPenalty = { ...basis.categoryMaxPenalty };
  for (const category of basis.categories) if (catalog.rules.filter((r) => r.category === category).every((r) => decidedRules.has(r.code))) categoryMaxPenalty[category] = 1;

  const excludedCodes = catalog.rules.map((r) => r.code).filter((code) => !decidedRules.has(code));
  let value: number | null = null;
  let capped = false;
  let unmeasuredCategories: AuxCategory[] = [];
  if (basis.categories.length > 0) {
    const scored = auxScore({ findings: counted, pagesCrawled: pagesForScore, evaluatedCategories: basis.categories, categoryMaxPenalty, unmeasuredRules: excludedCodes });
    unmeasuredCategories = [...scored.unmeasured];
    const cappedHere = anyCriticalAccess && basis.categories.includes("crawler_access");
    // Site files alone are not a headline: null means no page was judged, never 0.
    if (pagesJudged > 0) {
      value = cappedHere ? Math.min(scored.score, AUX_HARD_CAP) : scored.score;
      capped = cappedHere && scored.score > AUX_HARD_CAP;
    }
  }
  const notEvaluated = AUX_RULES_NOT_EVALUATED;
  const excluded = excludedCodes.map((code) => {
    const row = rows.get(code)!;
    const category = row.category as AuxCategory;
    const why =
      reasonFor(code, notEvaluated) ??
      (SITE_FILE_RULES.includes(code as (typeof SITE_FILE_RULES)[number]) ? "Its input file did not answer, so it could not be decided." : pageCodes.has(code) ? (pagesJudged === 0 ? "No page could be audited, so no page rule was decided." : "No audited page carried the input this rule needs.") : "This rule did not run in this audit.");
    return { rule_code: code, title: row.title, category, weight_points: round2(AUX_CATEGORY_WEIGHTS[category] * row.weight * 100), reason: sanitiseText(why, 600) };
  });
  const excludedWeight = round2(excluded.reduce((sum, r) => sum + r.weight_points, 0));
  const partial = excluded.length > 0 || unmeasuredCategories.length > 0;
  const label = partial
    ? `Partial score: ${value === null ? "no page could be judged" : String(value)}. ${String(excludedWeight)} of the score's 100 points are carried by rules that did not run, so this is not the site's full AUX score.`
    : "Full score: every rule was decided.";

  // PATCHES: the same generator the in-project audit uses, for the same site-file rules. Free, and attached to the finding that earned it.
  const site = {
    origin,
    siteName: host,
    projectId: "tool-audit",
    pageUrls: sitemapResult.urls.map((e) => e.loc),
    robots: robotsOk && robots.responded ? { body: robots.file.body, hash: createHash("sha256").update(robots.raw).digest() } : null,
    llms: [llms, llmsWellKnown].find((f) => f.responded && f.status >= 200 && f.status < 300)?.responded === true ? { body: ([llms, llmsWellKnown].find((f) => f.responded && f.status >= 200 && f.status < 300) as Extract<Fetched, { responded: true }>).file.body } : null,
    llmsPatchable: llms.responded && llmsWellKnown.responded && (llms.status === 404 || llms.status === 410 || (llms.status >= 200 && llms.status < 300)),
    trackedPaths: ["/"],
  };
  const patchFor = (ruleCode: string, url: string | null): AuxToolPatch | null => {
    let draft: PatchDraft | null = null;
    try {
      const generated = generateSiteFilePatch({ ruleCode, targetUrl: url ?? origin, url, site });
      if (generated.outcome === "patch") draft = generated.draft;
    } catch (error) {
      if (!(error instanceof PatchRejectedError)) throw error;
      // A generator whose own output fails a gate offers no patch; the finding stands.
      return null;
    }
    return draft === null ? null : toToolPatch(draft);
  };
  const toFinding = (f: SiteFileFinding | AuxRuleFinding): AuxToolFinding => {
    const row = rows.get(f.rule_code);
    const url = "url" in f ? f.url : f.evidence.file === "robots.txt" ? urls.robots : f.evidence.file === "llms.txt" ? urls.llms : sitemapUrl;
    const patch = patchFor(f.rule_code, url);
    return {
      ...findingView({
        consequence: row?.rationale ?? null,
        title: row?.title ?? f.rule_code,
        rule_code: f.rule_code,
        category: (row?.category ?? null) as AuxCategory | null,
        severity: f.severity,
        url,
        affected_pages: "url" in f ? 1 : pagesForScore,
        measured_value: f.measured_value,
        threshold_value: f.threshold_value,
        evidence: f.evidence,
        auto_fixable: row?.auto_fixable ?? false,
        requires_human_review: patch?.requires_human_review ?? false,
      }),
      patch,
    };
  };
  const ordered = [...siteDetected, ...pageRules.findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const allFindings = ordered.map(toFinding);

  // PAGES: what could not be reached is named, by reason code only (never an error message).
  const unreachable = crawl.pages
    .filter((p) => p.outcome === "failed" || p.outcome === "skipped" || p.raw === undefined)
    .map((p) => ({ url: sanitiseText(p.url, 2048), failures: p.failures.map((x) => ({ stage: x.stage, reason: sanitiseText(x.reason, 120), http_status: x.http_status })).concat(p.failures.length === 0 && p.skipped_reason !== undefined ? [{ stage: "raw", reason: p.skipped_reason, http_status: null }] : []) }));
  const unattempted = pagesToCrawl.length < selection.urls.length ? selection.urls.slice(pagesToCrawl.length).map((u) => ({ url: sanitiseText(u, 2048), failures: [{ stage: "raw", reason: "crawl_delay_budget", http_status: null }] })) : [];
  const band = auxAuditEstimate(Math.max(1, input.pages), Math.max(input.pages, pageCapForPlan("")));
  const audit = {
    score: { value, partial, label, excluded_weight_points: excludedWeight, unmeasured_categories: unmeasuredCategories, capped },
    excluded_rules: excluded,
    scope_note: input.verified ? null : "This domain is not verified, so only the URL you supplied and its site files were audited. Verifying the domain audits its key pages too, at the same price.",
    findings: [] as AuxToolFinding[],
    findings_total: allFindings.length,
    findings_omitted: 0,
    patches_included: 0,
    pages: {
      requested: input.pages,
      raw_fetched: crawl.pages.filter((p) => p.raw !== undefined).length,
      rendered_fetched: crawl.pages.filter((p) => p.rendered !== undefined).length,
      judged: pagesJudged,
      unreachable: [...unreachable, ...unattempted],
    },
    charge: { credits: input.credits, band_label: band.band.label, site_files_included: true as const, patches_credits: 0 as const },
  };
  const draft = { ...base, audit };
  const kept: AuxToolFinding[] = [];
  let size = Buffer.byteLength(JSON.stringify(draft));
  for (const finding of allFindings) {
    const add = Buffer.byteLength(JSON.stringify(finding)) + 1;
    if (size + add > RESULT_BUDGET_BYTES) break;
    kept.push(finding);
    size += add;
  }
  audit.findings = kept;
  audit.findings_omitted = allFindings.length - kept.length;
  audit.patches_included = kept.filter((f) => f.patch !== null).length;
  const result = auxAuditToolResultSchema.parse({ ...base, audit });
  const delivered = pagesJudged > 0;
  return { kind: "done", result, delivered, auxScore: value, pagesScanned: crawl.pages.filter((p) => p.raw !== undefined).length, requests: budget.used };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function toManifestPage(p: PageRecord): CrawlManifest["pages"][number] {
  return {
    url: p.url,
    outcome: p.outcome,
    ...(p.raw === undefined ? {} : { raw: p.raw }),
    ...(p.rendered === undefined ? {} : { rendered: p.rendered }),
    ...(p.fetch === undefined ? {} : { fetch: p.fetch }),
    failures: p.failures,
    ...(p.skipped_reason === undefined ? {} : { skipped_reason: p.skipped_reason }),
  };
}

function toToolPatch(draft: PatchDraft): AuxToolPatch {
  return {
    kind: draft.kind,
    target_url: draft.targetUrl,
    content_after: draft.contentAfter,
    unified_diff: draft.unifiedDiff,
    jsonld_blocks: draft.jsonldBlocks,
    reversal: draft.reversal,
    preconditions: draft.preconditions,
    explanation: draft.explanation,
    derivation: draft.derivation,
    requires_human_review: draft.requiresHumanReview,
    review_reason: draft.reviewReason,
    risk_flags: draft.riskFlags,
    free: true,
    credits_charged: 0,
  };
}

/** The site-files check, in terms of what each AI agent can do - the headline of site-files mode - not a dump of the files. */
export function siteFilesAccess(args: {
  robots: Fetched;
  llms: Fetched;
  llmsWellKnown: Fetched;
  sitemap: Fetched;
  parsedRobots: ParsedRobots | null;
  rootUrl: string;
  sitemapCount: number;
  checkedAt: Date;
}): AuxSiteFilesAccess {
  const rootPath = (() => {
    const u = new URL(args.rootUrl);
    return `${u.pathname}${u.search}`;
  })();
  const robotsStatus = args.robots.responded ? args.robots.status : null;
  // No file (404/410) means no rules: everything is allowed. A file we could not read (unreachable, 5xx) is NOT "allowed by default".
  const rulesKnown = args.parsedRobots !== null || (robotsStatus !== null && robotsStatus >= 400 && robotsStatus < 500);
  const agents = AI_CRAWLER_AGENTS.map((agent) => {
    if (!rulesKnown) return { agent, access: "unknown" as const, meaning: `robots.txt could not be read, so whether ${agent} may fetch your pages is unknown. Nominara does not assume it is allowed.` };
    const allowed = args.parsedRobots === null || isAllowed(args.parsedRobots, agent, rootPath);
    return allowed
      ? { agent, access: "allowed" as const, meaning: `${agent} may fetch your pages, so its answers can draw on them.` }
      : { agent, access: "blocked" as const, meaning: `${agent} is told not to fetch your pages, so its answers cannot draw on them.` };
  });
  const blocked = agents.filter((a) => a.access === "blocked").length;
  const unknown = agents.filter((a) => a.access === "unknown").length;
  const present = (f: Fetched): "present" | "absent" | "unreachable" => (!f.responded ? "unreachable" : f.status >= 200 && f.status < 300 ? "present" : f.status === 404 || f.status === 410 ? "absent" : "unreachable");
  const llmsState = [args.llms, args.llmsWellKnown].some((f) => present(f) === "present") ? "present" : [args.llms, args.llmsWellKnown].every((f) => present(f) === "absent") ? "absent" : "unreachable";
  const robotsState = present(args.robots);
  const sitemapState = present(args.sitemap);
  const summary =
    unknown === agents.length
      ? "Whether AI agents can read your site is unknown: robots.txt could not be read."
      : blocked === 0
        ? `All ${String(agents.length)} AI agents checked are allowed to fetch your pages.`
        : `${String(blocked)} of ${String(agents.length)} AI agents checked are blocked from your pages: ${agents.filter((a) => a.access === "blocked").map((a) => a.agent).join(", ")}.`;
  return {
    summary,
    agents,
    files: [
      { file: "robots.txt", state: robotsState, meaning: robotsState === "present" ? "robots.txt tells each AI agent which parts of the site it may fetch." : robotsState === "absent" ? "There is no robots.txt, so no AI agent is told to stay away." : "robots.txt could not be read." },
      { file: "llms.txt", state: llmsState, meaning: llmsState === "present" ? "llms.txt gives AI agents a curated summary of the site to read first." : llmsState === "absent" ? "There is no llms.txt, so AI agents get no curated summary of the site." : "llms.txt could not be checked." },
      { file: "sitemap", state: sitemapState, meaning: sitemapState === "present" ? `The sitemap lets AI agents discover ${String(args.sitemapCount)} pages.` : sitemapState === "absent" ? "There is no sitemap, so AI agents must find pages by following links." : "The sitemap could not be read." },
    ],
    checked_at: args.checkedAt.toISOString(),
  };
}
