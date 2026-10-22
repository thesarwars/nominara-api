import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import type { Job } from "bullmq";
import {
  auxErrorSummarySchema,
  crawlAuditJobPayloadSchema,
  crawlManifestSchema,
  siteFileFindingSchema,
  type AuxErrorSummary,
  type CrawlManifest,
  type SiteFileFinding,
} from "../../../../contracts/aux/index.js";
import { loadAuxCatalog, type AuxCatalog } from "../../aux/catalog.js";
import {
  findingFingerprint,
  reconcileFindings,
  type AuxSeverityBand,
  type DetectedFinding,
  type ExistingFinding,
  type FindingStatus,
  type LifecycleAction,
} from "../../aux/lifecycle.js";
import { crawlPages, NOMINARA_USER_AGENT, type PageRecord } from "../../aux/page-crawl.js";
import { pageCapForPlan, selectPages, type SelectionScope } from "../../aux/page-selection.js";
import { PolitenessBudget, PolitenessCapReached, PolitenessDeadlineReached } from "../../aux/politeness.js";
import { unavailableRenderer, type Renderer } from "../../aux/renderer.js";
import { CRAWL_AGENT, crawlDelayFor, isAllowed, parseRobots, sitemapUrlsOf, type ParsedRobots } from "../../aux/robots.js";
import { sanitiseText } from "../../aux/sanitise.js";
import { AI_CRAWLER_AGENTS, evaluateSiteFiles, type SiteFile } from "../../aux/site-files.js";
import { collectSitemap, MAX_SITEMAP_FILES, SitemapFetchSkipped, type SitemapResult } from "../../aux/sitemap.js";
import { guardedFetch, type GuardedFetchInit, type GuardedResponse } from "../../net/guarded-fetch.js";
import { uuidV7 } from "../../ids/uuidv7.js";
import { toRegistrableDomain } from "../../net/registrable-domain.js";
import { auxScore, type AuxCountedFinding } from "../../scoring/aux.js";
import { S3Adapter } from "../../storage/s3.adapter.js";
import { resolveStorageConfig } from "../../storage/storage-config.js";
import type { ObjectStoragePort } from "../../storage/storage.port.js";
import { TenantObjectStore } from "../../storage/tenant-object-store.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import type { QueueHandlerContext } from "../handlers.js";
import { PHASES_DONE, phasedProcessor, type JobProcessor } from "../worker-factory.js";

// NEW-C-9 / STORY-049 — `crawl.audit`: authorisation by verification state, the site files, page selection, two fetches
// per page, and the finding lifecycle (STORY-052, aux-and-geo-analysis.md §3).
//
// Runs inside withTenantJob: `tx` is already in the job's tenant context, so
// there is no workspace_id predicate in any query below — RLS is the filter.
// (The one workspace_id that appears is the VALUE on an INSERT, from the
// signature-verified payload.)
//
// WHAT RUNS. Site files always. Pages are what the VERIFICATION STATE authorises: a domain with a
// verified_at row in `domain_verifications` gets the scope the job asked for (key_pages by default); anything else is
// `public_surface` — the supplied URL and the site files, no sitemap pages — whatever the payload says, so a job
// can never ask for more than the domain's owner proved they own (STORY-048 AC6's consumer). The mirror column
// `projects.domain_verified_at` is NOT consulted: the table is the authority, and a stale mirror must not widen a crawl.
//
// WHAT IS STILL NOT EVALUATED. Pages are fetched and stored, but the page-level rules are STORY-051, and AUX-R-005 (bot-hostile
// edge rules) CANNOT be evaluated at all: OWNER DECISION 2026-10-22, Nominara sends every request as NominaraBot and never under
// another crawler's name, so a firewall or CDN rule that blocks by user agent is not observable here. AI-bot access is judged
// from what robots.txt publishes for each AI crawler token (`ai_bot_access` in the manifest; AUX-R-001/002 as findings).
// `excluded_rules` names all of this and `aux_score` stays null: one category
// is not an AUX score. The `crawler_access` subscore is published in `score_breakdown`, and `score_capped` is set whenever
// a critical crawler_access finding is open.
//
// THE TRANSACTIONS (KAD-06, ADR-0003). This is a PHASED job (`phasedProcessor`): `prepare` and `commit` are each ONE SHORT tenant
// transaction, and `run`, where every request to the target, every render and every object-store write happens, holds NO
// transaction and NO pooled connection. `run` therefore cannot read tenant data (it has no client); it works from what `prepare`
// loaded up front (the project's domain and plan, the verification verdict, the evidence URLs, the object store BOUND to the job's
// workspace) and hands a plain result to `commit`, which writes the audit and the findings atomically. Idempotency under
// at-least-once delivery moved with the write: `prepare` skips an audit that already finished (no request is made for it), and
// `commit` claims the audit row with `INSERT ... ON CONFLICT (id) DO NOTHING`, then locks it and writes nothing when another
// delivery finished it first, so two deliveries racing through `run` leave one audit and each finding counted once. A job that
// fails in `run` leaves no row at all (it never inserted one). Every DELIVERY mints its own run id in `prepare` and stores everything
// under crawl/{env}/{workspace_id}/{audit_id}/{run_id}/, so a duplicate delivery cannot overwrite the winner's stored copies or
// manifest: the winning `commit` records ITS prefix in `dom_object_prefix`, and every other prefix (a losing duplicate, a retry's
// earlier attempt, a run that outlived a project's deletion) is an orphan with no row pointing at it. There is NO sweep for orphans:
// the bound is the crawl/ lifecycle rule in system-architecture.md's retention table (nominara-infra, STORY-003, not built), and until
// that lands orphans are unbounded (ADR-0003). `commit` first re-checks and locks the project, writing nothing for one that was
// soft-deleted during `run`, and serialising the reconciliation of two audits of one project.
// The wall-clock budget (CRAWL_WALL_CLOCK_BUDGET_MS) still bounds how long a worker SLOT is held, and the declared Crawl-delay is
// honoured up to MAX_HONOURED_CRAWL_DELAY_MS (politeness.ts); both numbers are NOT FROM THE REFERENCE.

export const RULE_VERSION = "2026.10.1";
export const FETCH_TIMEOUT_MS = 10_000;
/**
 * NOT FROM THE REFERENCE. The wall-clock budget for one audit's requests to the target. An honest crawl is ~80 requests at
 * 500 ms plus response time, i.e. about a minute; 10 minutes leaves an order of magnitude of slack and still ends a crawl
 * that a slow or hostile target would stretch. Provisional until the architect names a number.
 */
export const CRAWL_WALL_CLOCK_BUDGET_MS = 10 * 60 * 1000;
/** aux-and-geo-analysis.md §1: a 500 ms minimum interval between requests to one host. */
export { MIN_INTERVAL_MS as POLITENESS_INTERVAL_MS } from "../../aux/politeness.js";
const TOKENIZER = "none"; // aux_audits.tokenizer is NOT NULL; no text is tokenised in this stage.
const RAN_RULES = ["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-004", "AUX-R-007"] as const;
const TERMINAL_STATUSES = ["completed", "partial", "failed"];
const OPEN_STATUSES = ["open", "acknowledged", "in_progress", "regressed"];
/** Owned citations from the last 90 days name pages a key_pages audit must look at (aux-and-geo-analysis.md §1 step 3). */
const CITATION_WINDOW_DAYS = 90;
/** A bound on what one project's evidence can add to the candidate list; the page cap does the real limiting. */
const EVIDENCE_URL_LIMIT = 500;

const tracer = trace.getTracer("nominara.crawl-audit");

type StoreFn = (relative: string, body: Buffer, contentType: string) => Promise<string>;

export interface CrawlAuditDeps {
  /** The SSRF-guarded fetcher by default; injectable so tests touch no network. */
  readonly fetch?: (url: string, init?: GuardedFetchInit) => Promise<GuardedResponse>;
  readonly now?: () => Date;
  /** Milliseconds, for the politeness budget; injectable so a test can run on a virtual clock. */
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  /** The rendered fetch. Default: none installed, which records `renderer_unavailable` per page (see renderer.ts). */
  readonly renderer?: Renderer;
  /** Writes under crawl/{env}/{workspace_id}/ and returns the full key. Default: the tenant object store; unconfigured fails closed. */
  readonly store?: StoreFn;
  /** The object-storage port the DEFAULT store writes through (S3 when absent). Injectable so a test sees the real key and the real tenant binding. */
  readonly storagePort?: ObjectStoragePort;
  /** Overrides the plan's page cap. */
  readonly pageCap?: number;
  /** Overrides CRAWL_WALL_CLOCK_BUDGET_MS; for tests. */
  readonly wallClockBudgetMs?: number;
}

/** `raw` is the body exactly as fetched: `file.body` is a utf8 decode, which is lossy for a body that is not valid utf8. */
type Fetched =
  | { readonly responded: true; readonly status: number; readonly file: SiteFile; readonly raw: Buffer }
  /** `skipped`: NO request was sent because the wall-clock budget cannot cover it. That is not a failure of the site or of our fetch. */
  | { readonly responded: false; readonly skipped?: "crawl_delay_budget" };

/** All 34 rule codes, from the reference (§2). */
const ALL_RULE_CODES: readonly string[] = Array.from({ length: 34 }, (_, i) => `AUX-R-${String(i + 1).padStart(3, "0")}`);
const RULES_NOT_RUN: readonly string[] = ALL_RULE_CODES.filter((c) => !(RAN_RULES as readonly string[]).includes(c));
/** `page_crawl` is named only when no page was crawled: naming it after one was would be false. */
export const EXCLUDED_RULES: readonly string[] = [...RULES_NOT_RUN, "page_crawl"];

/**
 * The tenant object store over the configured bucket, BOUND to the current tenant context's workspace. Call it INSIDE the tenant
 * context (in `prepare`): `bind()` only reads the workspace id, does no I/O, and the returned writer works afterwards with no
 * context and no transaction (tenant-object-store.ts, "THE INTENDED PATTERN"). Unconfigured is a refusal, never a quiet write
 * somewhere else.
 */
function bindDefaultStore(context: QueueHandlerContext, port: ObjectStoragePort | undefined): StoreFn {
  const config = resolveStorageConfig(context.env);
  if (config === null) return () => Promise.reject(new Error("object storage is not configured"));
  const bound = new TenantObjectStore(port ?? new S3Adapter(config), config.keyEnv).bind();
  return (relative, body, contentType) => bound.put("crawl", relative, body, { contentType });
}

function sameSite(a: string, b: string): boolean {
  try {
    return toRegistrableDomain(a) === toRegistrableDomain(b);
  } catch {
    return false;
  }
}

export function createCrawlAuditHandler(context: QueueHandlerContext, deps: CrawlAuditDeps = {}): JobProcessor {
  const logger = new Logger("crawl.audit");
  const fetchOne = deps.fetch ?? ((url: string, init?: GuardedFetchInit) => guardedFetch(url, init));
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const renderer = deps.renderer ?? unavailableRenderer;
  const identified: GuardedFetchInit = { headers: { "user-agent": NOMINARA_USER_AGENT } };
  // Site files and sitemaps stay on the verified site: a redirect off it is not followed, so no request is sent to a
  // third party and no foreign body is parsed. (A refused redirect returns the 3xx, recorded like any non-2xx.)
  const onSite = (origin: string): GuardedFetchInit => ({ ...identified, followRedirect: (next) => sameSite(next, origin) });

  /** One bounded, identified request. A refusal, a DNS failure and a timeout are all `null`: OUR fetch failed. */
  async function bounded(url: string, init: GuardedFetchInit = identified): Promise<GuardedResponse | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("crawl.audit: fetch timeout")), timeoutMs);
      });
      return await Promise.race([fetchOne(url, init), timeout]);
    } catch {
      // That is not evidence about the site, so it is recorded as a failure and never as a finding or a resolution.
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** The same timeout, but the failure is THROWN so the page stage can record its reason (a refusal names its check, a timeout says so). */
  async function boundedThrowing(url: string, init: GuardedFetchInit): Promise<GuardedResponse> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("crawl.audit: fetch timeout")), timeoutMs);
      });
      return await Promise.race([fetchOne(url, init), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  const toFetched = (res: GuardedResponse | null): Fetched =>
    res === null
      ? { responded: false }
      : { responded: true, status: res.status, file: { status: res.status, body: res.body.toString("utf8"), byteLength: res.body.length }, raw: res.body };

  // What `prepare` loads up front and `run` works from. Plain data plus the bound object-store writer: nothing here can reach the
  // database, so the fetch phase cannot read tenant data it was not given.
  interface Prepared {
    readonly payload: ReturnType<typeof crawlAuditJobPayloadSchema.parse>;
    readonly rootDomain: string;
    readonly rootUrl: string;
    readonly origin: string;
    readonly verified: boolean;
    readonly scope: SelectionScope;
    readonly pageCap: number;
    readonly startedAt: Date;
    readonly startedMs: number;
    /** Minted per DELIVERY: every object this delivery stores lies under {audit_id}/{run_id}/, so a duplicate cannot overwrite the winner's. */
    readonly runId: string;
    readonly evidence: { readonly citations: string[]; readonly tasks: string[] };
    readonly store: StoreFn;
  }

  /** The unreachable case is decided in `run` and written by `commit`: not one of the four site files answered. */
  type Outcome = { readonly kind: "unreachable"; readonly failed: number; readonly finishedAt: Date } | ({ readonly kind: "crawled" } & Crawled);

  /** Everything `commit` needs that `run` produced. */
  interface Crawled {
    readonly urls: Readonly<Record<"robots" | "llms" | "llmsWellKnown" | "sitemap", string>>;
    readonly robots: Fetched;
    readonly llms: Fetched;
    readonly llmsWellKnown: Fetched;
    readonly sitemap: Fetched;
    readonly sitemapUrl: string;
    readonly allSiteFileUrls: string[];
    readonly detected: (DetectedFinding & { readonly source: SiteFileFinding })[];
    readonly covered: ReadonlySet<string>;
    readonly pagesToCrawl: readonly string[];
    readonly pagesCrawled: number;
    readonly pagesFailed: number;
    readonly partialPages: number;
    readonly skippedPages: number;
    readonly siteFilesFailed: number;
    readonly manifestStored: boolean | null;
    readonly domObjectPrefix: string | null;
    readonly errorSummary: string | null;
    readonly llmsPresent: boolean | null;
    readonly sitemapCount: number | null;
    readonly robotsSnapshot: string | null;
    readonly robotsHash: Buffer | null;
    readonly requests: number;
    readonly finishedAt: Date;
  }

  async function prepare(tx: ClientBase, job: Job): Promise<Prepared | typeof PHASES_DONE> {
    const startedMs = Date.now();
    const payload = crawlAuditJobPayloadSchema.parse((job.data as { payload: unknown }).payload);

    const project = await tx.query<{ root_domain: string; root_url: string; plan_key: string }>(
      `SELECT p.root_domain, p.root_url, w.plan_key
         FROM projects p JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [payload.projectId],
    );
    if (project.rows.length === 0) {
      logger.log(`project ${payload.projectId} is gone; skipping audit`);
      return PHASES_DONE;
    }
    const { root_domain: rootDomain, root_url: rootUrl, plan_key: planKey } = project.rows[0]!;

    // A redelivery of an audit that already finished makes no request at all. (A concurrent duplicate that has not finished is
    // caught in `commit`, which is the only place that can tell.)
    const prior = await tx.query<{ status: string }>("SELECT status FROM aux_audits WHERE id = $1", [payload.auditId]);
    if (prior.rows.length > 0 && TERMINAL_STATUSES.includes(prior.rows[0]!.status)) {
      logger.log(`audit ${payload.auditId} already ran; skipping redelivery`);
      return PHASES_DONE;
    }

    // AUTHORIZE (step 1). Fails closed: no verified row, no full scope.
    const verifiedRow = await tx.query(
      "SELECT 1 FROM domain_verifications WHERE project_id = $1 AND domain = $2 AND verified_at IS NOT NULL LIMIT 1",
      [payload.projectId, rootDomain],
    );
    const verified = verifiedRow.rows.length > 0;
    const scope: SelectionScope = verified ? (payload.scope ?? "key_pages") : "public_surface";
    const startedAt = now();

    // What a key_pages audit must look at: owned citations and open-task URLs. Read HERE because `run` has no client.
    let evidence = { citations: [] as string[], tasks: [] as string[] };
    if (scope === "key_pages") {
      const cited = await tx.query<{ url: string }>(
        `SELECT DISTINCT normalized_url AS url FROM citation_facts
          WHERE project_id = $1 AND is_owned AND captured_at >= $2::timestamptz - make_interval(days => $3) LIMIT $4`,
        [payload.projectId, startedAt, CITATION_WINDOW_DAYS, EVIDENCE_URL_LIMIT],
      );
      const tasked = await tx.query<{ url: string }>(
        `SELECT DISTINCT affected_url AS url FROM tasks
          WHERE project_id = $1 AND affected_url IS NOT NULL AND status IN ('todo','in_progress') AND deleted_at IS NULL LIMIT $2`,
        [payload.projectId, EVIDENCE_URL_LIMIT],
      );
      evidence = { citations: cited.rows.map((r) => r.url), tasks: tasked.rows.map((r) => r.url) };
    }

    return {
      payload,
      rootDomain,
      rootUrl,
      origin: `https://${rootDomain}`,
      verified,
      scope,
      pageCap: deps.pageCap ?? pageCapForPlan(planKey),
      startedAt,
      startedMs,
      runId: uuidV7(),
      evidence,
      // Bound to THIS workspace here, inside the tenant context; the writer works later with no context and no transaction.
      store: deps.store ?? bindDefaultStore(context, deps.storagePort),
    };
  }

  /** THE FETCH PHASE. No transaction, no client: site files, sitemap, pages (both copies), object-store writes. */
  async function run(prepared: Prepared): Promise<Outcome> {
    return tracer.startActiveSpan("crawl.audit.fetch", async (span) => {
      try {
        const outcome = await fetchPhase(prepared);
        span.setAttribute("nominara.crawl.kind", outcome.kind);
        span.setAttribute("nominara.crawl.pages_crawled", outcome.kind === "crawled" ? outcome.pagesCrawled : 0);
        span.setAttribute("nominara.crawl.requests", outcome.kind === "crawled" ? outcome.requests : 0);
        return outcome;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async function fetchPhase(prepared: Prepared): Promise<Outcome> {
    const { payload, rootUrl, origin, scope, pageCap, evidence, store, runId } = prepared;
    const siteFileInit = onSite(origin);
    const urls = {
      robots: new URL("/robots.txt", origin).href,
      llms: new URL("/llms.txt", origin).href,
      llmsWellKnown: new URL("/.well-known/llms.txt", origin).href,
      sitemap: new URL("/sitemap.xml", origin).href,
    };

    // ONE budget for every request this audit makes to the host: site files and pages (both fetches).
    // The hard cap is the arithmetic of what the audit may legitimately need: robots, two llms files, the sitemap files,
    // and two fetches per page.
    const wallClockBudgetMs = deps.wallClockBudgetMs ?? CRAWL_WALL_CLOCK_BUDGET_MS;
    // A page costs two requests (plain and rendered), or one when no renderer is installed: nothing is sent for the second.
    const requestsPerPage = renderer.available === false ? 1 : 2;
    const budget = new PolitenessBudget({
      hardCap: 3 + MAX_SITEMAP_FILES + requestsPerPage * pageCap,
      wallClockBudgetMs,
      ...(deps.nowMs === undefined ? {} : { now: deps.nowMs }),
      sleep,
    });

    // SITE FILES (step 2). Sequential, each charged to the budget.
    const siteFile = async (url: string): Promise<Fetched> => {
      try {
        await budget.acquire("site_file");
      } catch (error) {
        // The wall-clock budget is spent: we did not ask, so there is no answer, and that is a SKIP (recorded as
        // `crawl_delay_budget`), never a failure of the site or of our fetch. A spent request cap is a plain no-answer.
        if (error instanceof PolitenessDeadlineReached) return { responded: false, skipped: "crawl_delay_budget" };
        if (error instanceof PolitenessCapReached) return { responded: false };
        throw error;
      }
      return toFetched(await bounded(url, siteFileInit));
    };
    const robots = await siteFile(urls.robots);
    const robotsOk = robots.responded && robots.status >= 200 && robots.status < 300;
    const robotsBody = robotsOk ? robots.file.body : "";
    const parsedRobots: ParsedRobots | null = robotsOk ? parseRobots(robotsBody) : null;
    // robots.txt is the FIRST request, so its Crawl-delay only binds the ones after it.
    if (parsedRobots !== null) budget.setCrawlDelay(crawlDelayFor(parsedRobots, CRAWL_AGENT));
    const llms = await siteFile(urls.llms);
    const llmsWellKnown = await siteFile(urls.llmsWellKnown);

    // The sitemap: from the robots `Sitemap:` lines when there are any on this site, else /sitemap.xml. The FIRST file
    // fetched is the one AUX-R-007 judges, so it is captured here rather than fetched twice.
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
            // Nothing was sent: a skip, which `collectSitemap` records as `crawl_delay_budget` without counting a file fetched.
            first.value ??= { url, fetched: { responded: false, skipped: "crawl_delay_budget" } };
            throw new SitemapFetchSkipped();
          }
          throw error;
        }
        const res = await bounded(url, siteFileInit);
        first.value ??= { url, fetched: toFetched(res) };
        if (res === null) throw new Error("sitemap fetch failed");
        return { status: res.status, body: res.body };
      },
    });
    const sitemap: Fetched = first.value?.fetched ?? { responded: false };
    const sitemapUrl = first.value?.url ?? urls.sitemap;
    const sitemapProblems = [
      ...declared.filter((u) => !sameSite(u, origin)).map((u) => ({ url: sanitiseText(u, 2048), reason: "foreign_site" as const })),
      ...sitemapResult.problems.map((p) => ({ url: sanitiseText(p.url, 2048), reason: p.reason as string })),
    ];

    const siteFiles: [string, string, Fetched][] = [
      ["robots.txt", urls.robots, robots],
      ["llms.txt", urls.llms, llms],
      ["/.well-known/llms.txt", urls.llmsWellKnown, llmsWellKnown],
      ["sitemap", sitemapUrl, sitemap],
    ];
    // Failed (no answer, and it was asked for) and skipped (never asked: the budget could not cover it) are reported apart.
    const siteFilesFailed = siteFiles.filter(([, , f]) => !f.responded && f.skipped === undefined).map(([name]) => name);
    const siteFilesSkipped = siteFiles.filter(([, , f]) => !f.responded && f.skipped !== undefined).map(([, url]) => ({ url: sanitiseText(url, 2048), reason: "crawl_delay_budget" }));
    const failed = siteFilesFailed.length;

    if (failed === siteFiles.length) return { kind: "unreachable", failed, finishedAt: now() };

    // SELECT PAGES (step 3) and FETCH TWICE (step 4).
    const selection = selectPages({
      scope,
      rootUrl,
      cap: pageCap,
      sitemap: sitemapResult.urls,
      ownedCitationUrls: evidence.citations,
      openTaskUrls: evidence.tasks,
      targetUrls: payload.targetUrls ?? [],
    });

    // THE WALL-CLOCK BUDGET, UP FRONT. Each page costs two requests (plain and rendered; one with no renderer installed) at the interval now in force, which a
    // declared Crawl-delay has already stretched. Shrink the list to what fits, and record what was not attempted.
    const affordablePages = Math.max(0, Math.floor(budget.affordableRequests() / requestsPerPage));
    const delaySkipped = selection.urls.length > affordablePages ? selection.urls.slice(affordablePages) : [];
    const pagesToCrawl = delaySkipped.length > 0 ? selection.urls.slice(0, affordablePages) : selection.urls;
    const delaySkippedRecords = delaySkipped.map((u) => ({ url: sanitiseText(u, 2048), reason: "crawl_delay_budget" }));

    // RFC 9309: a robots.txt that errored (5xx, unreachable) means "assume disallow"; a 4xx means "no rules".
    const robotsForCrawl: ParsedRobots | "unavailable" | null =
      parsedRobots !== null ? parsedRobots : robots.responded && robots.status >= 400 && robots.status < 500 ? null : "unavailable";
    // Relative to the storage adapter, which adds {env}/{workspace_id}/ itself; joined, not templated, so ISO-14 does not read it as a full key.
    const keyPrefix = [payload.auditId, runId].join("/");
    const crawl = await crawlPages(pagesToCrawl, {
      rootUrl,
      budget,
      robots: robotsForCrawl,
      renderer,
      // The same bounded timeout as every other fetch: a page that hangs must not hold the worker slot for the guard's 20 s.
      fetch: (url, init) => boundedThrowing(url, init),
      store,
      keyPrefix,
    });

    // AI-bot access, from robots.txt alone: what the site PUBLISHED for each AI crawler token at the crawl's root path.
    // null = robots.txt could not be judged (unreachable or errored): never "allowed" by default.
    const rootPath = (() => {
      const u = new URL(rootUrl);
      return `${u.pathname}${u.search}`;
    })();
    const aiBotAccess =
      robotsForCrawl === "unavailable" ? null : AI_CRAWLER_AGENTS.map((agent) => ({ agent, allowed: robotsForCrawl === null || isAllowed(robotsForCrawl, agent, rootPath) }));
    const finishedAt = now();

    // `failed`: no stored copy at all. `partial`: a copy is stored and something else (usually the rendered half) is not. They are
    // reported apart, so a deployment with no renderer does not read as "every page failed"; both carry their reasons.
    const failedPages = crawl.pages.filter((p) => p.outcome === "failed" || p.outcome === "partial");
    const partialPages = crawl.pages.filter((p) => p.outcome === "partial");
    const skippedPages = crawl.pages.filter((p) => p.outcome === "skipped");
    const pagesCrawled = crawl.pages.filter((p) => p.raw !== undefined).length;
    for (const p of crawl.pages) incrementCounter("nominara_aux_crawl_pages_total", { outcome: p.outcome });

    // The manifest names every stored copy; it is what makes the audit reproducible from storage.
    const manifest: CrawlManifest = crawlManifestSchema.parse({
      version: 1,
      audit_id: payload.auditId,
      scope,
      root_url: sanitiseText(rootUrl, 2048),
      pages: crawl.pages.map(toManifestPage),
      pages_over_cap: selection.overCap,
      stopped_at_cap: crawl.stoppedAtCap,
      selection_skipped: [...selection.skipped.map((x) => ({ url: sanitiseText(x.url, 2048), reason: x.reason })), ...delaySkippedRecords],
      sitemap: { files_fetched: sitemapResult.filesFetched, total_seen: sitemapResult.totalSeen, sampled: sitemapResult.sampled, problems: sitemapProblems },
      ai_bot_access: aiBotAccess,
    });
    let domObjectPrefix: string | null = null;
    let manifestStored: boolean | null = null;
    // Written whenever there is something to reproduce or to explain: a stored page, a failed one, or a page the budget skipped.
    if (crawl.pages.length > 0 || delaySkippedRecords.length > 0) {
      try {
        const key = await store([keyPrefix, "manifest.json"].join("/"), Buffer.from(JSON.stringify(manifest), "utf8"), "application/json");
        domObjectPrefix = key.slice(0, key.length - "manifest.json".length);
        manifestStored = true;
      } catch {
        manifestStored = false;
        const firstKey = crawl.pages.map((p) => p.raw?.object_key ?? p.rendered?.object_key).find((k) => k !== undefined);
        if (firstKey !== undefined) domObjectPrefix = firstKey.slice(0, firstKey.lastIndexOf("/") + 1);
      }
    }

    const pagesFailed = failedPages.length - partialPages.length;
    const pagesSkippedByDelay = delaySkippedRecords.length + skippedPages.filter((p) => p.skipped_reason === "crawl_delay_budget").length;
    // Present whenever the Crawl-delay or the wall-clock budget shaped the crawl: a skip, or a delay that was shortened to the cap.
    const delayLimited =
      budget.declaredCrawlDelayMs !== null || pagesSkippedByDelay > 0 || crawl.stoppedAtDeadline || siteFilesSkipped.length > 0 || sitemapResult.problems.some((p) => p.reason === "crawl_delay_budget");
    const summary: AuxErrorSummary = {
      ...(siteFilesFailed.length > 0 ? { site_files_failed: siteFilesFailed } : {}),
      ...(failedPages.length > 0 ? { failed_pages: failedPages.map((p) => ({ url: p.url, failures: p.failures })) } : {}),
      ...(skippedPages.length > 0 || delaySkippedRecords.length > 0 || siteFilesSkipped.length > 0
        ? { skipped_pages: [...siteFilesSkipped, ...skippedPages.map((p) => ({ url: p.url, reason: p.skipped_reason ?? "skipped" })), ...delaySkippedRecords] }
        : {}),
      ...(partialPages.length > 0 ? { pages_partial: partialPages.length } : {}),
      ...(delayLimited
        ? {
            crawl_delay_limited: {
              crawl_delay_ms: budget.intervalMs,
              ...(budget.declaredCrawlDelayMs === null ? {} : { declared_crawl_delay_ms: budget.declaredCrawlDelayMs }),
              pages_skipped: pagesSkippedByDelay,
            },
          }
        : {}),
      ...(selection.overCap > 0 ? { pages_over_cap: selection.overCap } : {}),
      ...(crawl.stoppedAtCap ? { stopped_at_cap: true } : {}),
      ...(manifestStored === false ? { manifest_stored: false as const } : {}),
    };
    const errorSummary = Object.keys(summary).length > 0 ? JSON.stringify(auxErrorSummarySchema.parse(summary)) : null;

    const asFile = (f: Fetched): SiteFile | null => (f.responded ? f.file : null);
    const evaluated = evaluateSiteFiles({
      robots: asFile(robots),
      llmsTxt: asFile(llms),
      llmsTxtWellKnown: asFile(llmsWellKnown),
      sitemap: asFile(sitemap),
      sitemapDeclaredInRobots: declaredOnSite.length > 0,
      // The one path every audit can speak for is the root.
      trackedPaths: ["/"],
      now: finishedAt,
    });

    // A rule is "covered" only when its input file got an HTTP answer. A
    // finding from a file we failed to fetch (or never asked for) is not evidence, and a missing
    // finding from one is not a resolution.
    const covered = new Set<string>();
    if (robots.responded) ["AUX-R-001", "AUX-R-002", "AUX-R-003"].forEach((c) => covered.add(c));
    if (llms.responded && llmsWellKnown.responded) covered.add("AUX-R-004");
    if (sitemap.responded) covered.add("AUX-R-007");

    const urlFor = (f: SiteFileFinding): string => (f.evidence.file === "robots.txt" ? urls.robots : f.evidence.file === "llms.txt" ? urls.llms : sitemapUrl);
    const detected = evaluated
      .map((f) => siteFileFindingSchema.parse(f))
      .filter((f) => covered.has(f.rule_code))
      .map((f) => ({ f, url: urlFor(f) }))
      .map(({ f, url }): DetectedFinding & { readonly source: SiteFileFinding } => ({
        fingerprint: findingFingerprint(f.rule_code, url, f.evidence),
        ruleCode: f.rule_code,
        url,
        severity: f.severity,
        source: f,
      }));

    const llmsPresent = [llms, llmsWellKnown].some((f) => f.responded && f.status >= 200 && f.status < 300)
      ? true
      : llms.responded && llmsWellKnown.responded
        ? false
        : null;
    const sitemapCount = sitemap.responded && sitemap.status >= 200 && sitemap.status < 300 ? sitemapResult.totalSeen : null;

    return {
      kind: "crawled",
      urls,
      robots,
      llms,
      llmsWellKnown,
      sitemap,
      sitemapUrl,
      allSiteFileUrls: [...Object.values(urls), sitemapUrl, ...pagesToCrawl],
      detected,
      covered,
      pagesToCrawl,
      pagesCrawled,
      pagesFailed,
      partialPages: partialPages.length,
      skippedPages: skippedPages.length,
      siteFilesFailed: failed,
      manifestStored,
      domObjectPrefix,
      errorSummary,
      llmsPresent,
      sitemapCount,
      robotsSnapshot: robotsOk ? sanitiseText(robotsBody) : null,
      robotsHash: robotsOk && robots.responded ? createHash("sha256").update(robots.raw).digest() : null,
      requests: budget.used,
      finishedAt,
    };
  }

  /**
   * THE WRITE PHASE: one short tenant transaction. Claims the audit row (idempotent), then writes the findings and the final
   * audit row atomically. A delivery that lost the race to another one that already finished writes NOTHING.
   */
  async function commit(tx: ClientBase, prepared: Prepared, outcome: Outcome): Promise<void> {
    const { payload, origin, scope, startedAt, startedMs } = prepared;
    // Re-check and LOCK the project first. `run` held no transaction, so the project may have been soft-deleted since `prepare`: write
    // nothing for it. FOR NO KEY UPDATE also serialises the reconciliation of two audits of one project (the second waits here, then
    // reads the first's findings) and does not block the foreign-key share locks other writers take on the project.
    const project = await tx.query("SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE", [payload.projectId]);
    if (project.rows.length === 0) {
      incrementCounter("nominara_aux_crawl_commit_total", { outcome: "project_gone" });
      logger.log(`project ${payload.projectId} was deleted during audit ${payload.auditId}; writing nothing`);
      return;
    }
    const claimed = await claimAudit(tx, prepared, outcome);
    if (!claimed) {
      incrementCounter("nominara_aux_crawl_commit_total", { outcome: "duplicate" });
      logger.log(`audit ${payload.auditId} already ran; discarding the duplicate delivery's result`);
      return;
    }

    if (outcome.kind === "unreachable") {
      const summary = auxErrorSummarySchema.parse({ reason: "all_site_files_unreachable" });
      await tx.query(
        "UPDATE aux_audits SET status = 'failed', pages_failed = $2, error_summary = $3::jsonb, finished_at = $4, excluded_rules = $5 WHERE id = $1",
        [payload.auditId, outcome.failed, JSON.stringify(summary), outcome.finishedAt, [...EXCLUDED_RULES, ...RAN_RULES]],
      );
      incrementCounter("nominara_aux_audits_total", { status: "failed", trigger: payload.trigger });
      incrementCounter("nominara_aux_crawl_commit_total", { outcome: "written" });
      logger.log(`audit ${payload.auditId} (project ${payload.projectId}): no site file reachable`);
      return;
    }

    // The catalog is versioned data: assert its weights on every load (NFR-AUX-03).
    const catalogRows = await tx.query<{ code: string; category: string; title: string; weight: number; rule_version: string; thresholds: Record<string, unknown> }>(
      "SELECT code, category, title, weight, rule_version, thresholds FROM aux_rule_catalog WHERE category = 'crawler_access'",
    );
    const catalog: AuxCatalog = loadAuxCatalog(
      catalogRows.rows.map((r) => ({ code: r.code, category: r.category, weight: r.weight, ruleVersion: r.rule_version, thresholds: r.thresholds })),
    );
    const titles = new Map(catalogRows.rows.map((r) => [r.code, r.title]));

    const { detected, covered, finishedAt } = outcome;
    // Read HERE, under the lock on this audit row, so a delivery that committed a moment ago is already visible.
    const existingRows = await tx.query<{
      id: string; fp: string; rule_code: string; url: string | null; severity: AuxSeverityBand; status: FindingStatus; occurrence_count: number; resolved_at: Date | null;
    }>(
      `SELECT id, encode(fingerprint, 'hex') AS fp, rule_code, url, severity, status, occurrence_count, resolved_at
         FROM aux_findings WHERE project_id = $1 AND rule_code = ANY($2::text[])`,
      [payload.projectId, [...RAN_RULES]],
    );
    const existing: ExistingFinding[] = existingRows.rows.map((r) => ({
      id: r.id, fingerprint: r.fp, ruleCode: r.rule_code, url: r.url, severity: r.severity, status: r.status, occurrenceCount: r.occurrence_count, resolvedAt: r.resolved_at,
    }));

    const actions = reconcileFindings({
      existing,
      detected,
      inScope: (row) => covered.has(row.ruleCode) && (row.url === null || row.url.startsWith(origin)),
    });
    const byFingerprint = new Map(detected.map((d) => [d.fingerprint, d.source]));
    const sourceFor = (id: string): SiteFileFinding | undefined => {
      const row = existing.find((e) => e.id === id);
      return row === undefined ? undefined : byFingerprint.get(row.fingerprint);
    };

    for (const action of actions) {
      await applyAction(tx, action, { payload, titles, ruleVersion: RULE_VERSION, at: finishedAt, sourceFor });
    }

    // Audit-level counts: what THIS audit detected, by severity.
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const d of detected) if (d.severity in counts) counts[d.severity as keyof typeof counts] += 1;

    // The crawler_access subscore over every finding still open for the
    // project (including ones whose file we could not re-fetch). Site-file
    // findings are domain-wide, so scope is 1 (affected 1 of 1).
    const open = await tx.query<{ rule_code: string; severity: AuxSeverityBand }>(
      "SELECT rule_code, severity FROM aux_findings WHERE project_id = $1 AND status = ANY($2::text[]) AND rule_code = ANY($3::text[])",
      [payload.projectId, OPEN_STATUSES, [...RAN_RULES]],
    );
    const counted: AuxCountedFinding[] = open.rows.map((r) => ({
      category: "crawler_access",
      severity: r.severity,
      ruleWeight: catalog.byCode.get(r.rule_code)?.weight ?? 0,
      affectedPages: 1,
    }));
    const subscore = auxScore({ findings: counted, pagesCrawled: 1 }).subscores.crawler_access;
    const capped = counted.some((c) => c.severity === "critical");

    const status = outcome.siteFilesFailed + outcome.pagesFailed + outcome.partialPages + skippedSiteFileCount(outcome) > 0 || outcome.manifestStored === false ? "partial" : "completed";
    // Every rule that could not run is named: the ones outside this crawl, and any whose input file got no answer
    // (unreachable, or never asked for because the budget could not cover it).
    const excluded = [...new Set([...(outcome.pagesCrawled > 0 ? RULES_NOT_RUN : EXCLUDED_RULES), ...RAN_RULES.filter((code) => !covered.has(code))])];

    await tx.query(
      `UPDATE aux_audits
          SET status = $2, pages_crawled = $3, pages_failed = $4, robots_snapshot = $5, robots_hash = $6, llms_txt_present = $7, sitemap_url_count = $8,
              aux_score = NULL, score_capped = $9, score_breakdown = $10::jsonb,
              findings_critical = $11, findings_high = $12, findings_medium = $13, findings_low = $14, finished_at = $15,
              target_urls = $16, excluded_rules = $17, dom_object_prefix = $18, error_summary = $19::jsonb
        WHERE id = $1`,
      [
        payload.auditId, status, outcome.pagesCrawled, outcome.siteFilesFailed + outcome.pagesFailed,
        // The snapshot is stored verbatim except for what Postgres text cannot hold; the hash is of the bytes as fetched.
        outcome.robotsSnapshot,
        outcome.robotsHash,
        outcome.llmsPresent, outcome.sitemapCount, capped, JSON.stringify({ crawler_access: subscore }),
        counts.critical, counts.high, counts.medium, counts.low, finishedAt,
        [...new Set(outcome.allSiteFileUrls)], excluded, outcome.domObjectPrefix, outcome.errorSummary,
      ],
    );

    incrementCounter("nominara_aux_audits_total", { status, trigger: payload.trigger });
    incrementCounter("nominara_aux_crawl_commit_total", { outcome: "written" });
    logger.log({
      span: "crawl.audit",
      workspace_id: payload.workspaceId,
      audit_id: payload.auditId,
      project_id: payload.projectId,
      scope,
      status,
      pages_crawled: outcome.pagesCrawled,
      pages_failed: outcome.pagesFailed,
      pages_partial: outcome.partialPages,
      pages_skipped: outcome.skippedPages,
      site_files_failed: outcome.siteFilesFailed,
      requests: outcome.requests,
      detected: detected.length,
      resolved: actions.filter((a) => a.kind === "resolve").length,
      regressed: actions.filter((a) => a.kind === "regress").length,
      duration_ms: Date.now() - startedMs,
      started_at: startedAt.toISOString(),
    });
  }

  /**
   * Claims the audit row for this delivery: inserts it, or takes over a `queued`/`running` row left by a producer or a dead attempt.
   * Returns false when the audit already finished (another delivery won), in which case the caller writes nothing. The row lock
   * taken here is what serialises two deliveries: the second `INSERT` waits for the first to commit, then sees a finished audit.
   */
  async function claimAudit(tx: ClientBase, prepared: Prepared, outcome: Outcome): Promise<boolean> {
    const { payload, scope, startedAt } = prepared;
    const urlsForRow =
      outcome.kind === "crawled"
        ? Object.values(outcome.urls)
        : [new URL("/robots.txt", prepared.origin).href, new URL("/llms.txt", prepared.origin).href, new URL("/.well-known/llms.txt", prepared.origin).href, new URL("/sitemap.xml", prepared.origin).href];
    const inserted = await tx.query(
      `INSERT INTO aux_audits (id, workspace_id, project_id, trigger, scope, target_urls, excluded_rules, rule_version, tokenizer, status, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'running', $10)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [payload.auditId, payload.workspaceId, payload.projectId, payload.trigger, scope, urlsForRow, EXCLUDED_RULES, RULE_VERSION, TOKENIZER, startedAt],
    );
    if (inserted.rows.length > 0) return true;
    const prior = await tx.query<{ status: string }>("SELECT status FROM aux_audits WHERE id = $1 FOR UPDATE", [payload.auditId]);
    if (prior.rows.length === 0 || TERMINAL_STATUSES.includes(prior.rows[0]!.status)) return false;
    await tx.query("UPDATE aux_audits SET status = 'running', started_at = $2, excluded_rules = $3, scope = $4 WHERE id = $1", [payload.auditId, startedAt, EXCLUDED_RULES, scope]);
    return true;
  }

  const skippedSiteFileCount = (outcome: Outcome): number =>
    outcome.kind !== "crawled" ? 0 : [outcome.robots, outcome.llms, outcome.llmsWellKnown, outcome.sitemap].filter((f) => !f.responded && f.skipped !== undefined).length;

  return phasedProcessor<Prepared, Outcome>({
    prepare: (tx, job) => prepare(tx, job),
    run: (prepared) => run(prepared),
    commit: (tx, prepared, outcome) => commit(tx, prepared, outcome),
  });
}

function toManifestPage(p: PageRecord): CrawlManifest["pages"][number] {
  return {
    url: p.url,
    outcome: p.outcome,
    ...(p.raw === undefined ? {} : { raw: p.raw }),
    ...(p.rendered === undefined ? {} : { rendered: p.rendered }),
    failures: p.failures,
    ...(p.skipped_reason === undefined ? {} : { skipped_reason: p.skipped_reason }),
  };
}

async function applyAction(
  tx: ClientBase,
  action: LifecycleAction,
  ctx: { payload: { auditId: string; projectId: string; workspaceId: string }; titles: Map<string, string>; ruleVersion: string; at: Date; sourceFor: (id: string) => SiteFileFinding | undefined },
): Promise<void> {
  const { payload, at } = ctx;
  switch (action.kind) {
    case "insert": {
      const src = (action.finding as DetectedFinding & { source: SiteFileFinding }).source;
      await tx.query(
        `INSERT INTO aux_findings
           (workspace_id, project_id, audit_id, rule_code, url, severity, fingerprint, title, evidence, measured_value, threshold_value,
            rule_version, first_detected_at, last_detected_at)
         VALUES ($1,$2,$3,$4,$5,$6,decode($7,'hex'),$8,$9::jsonb,$10,$11,$12,$13,$13)`,
        [
          payload.workspaceId, payload.projectId, payload.auditId, action.finding.ruleCode, action.finding.url, action.finding.severity,
          action.finding.fingerprint, ctx.titles.get(action.finding.ruleCode) ?? action.finding.ruleCode, JSON.stringify(src.evidence),
          src.measured_value, src.threshold_value, ctx.ruleVersion, at,
        ],
      );
      return;
    }
    case "redetect": {
      const src = ctx.sourceFor(action.id);
      await tx.query(
        `UPDATE aux_findings
            SET audit_id = $2, last_detected_at = $3, occurrence_count = occurrence_count + 1,
                status = CASE WHEN $4 THEN 'open' ELSE status END,
                evidence = COALESCE($5::jsonb, evidence), measured_value = $6, threshold_value = $7
          WHERE id = $1`,
        [action.id, payload.auditId, at, action.reopen, src === undefined ? null : JSON.stringify(src.evidence), src?.measured_value ?? null, src?.threshold_value ?? null],
      );
      return;
    }
    case "regress": {
      const src = ctx.sourceFor(action.id);
      await tx.query(
        `UPDATE aux_findings
            SET status = 'regressed', severity = $2, regressed_at = $3, resolved_at = NULL, audit_id = $4,
                last_detected_at = $3, occurrence_count = occurrence_count + 1,
                evidence = COALESCE($5::jsonb, evidence), measured_value = $6, threshold_value = $7
          WHERE id = $1`,
        [action.id, action.severity, at, payload.auditId, src === undefined ? null : JSON.stringify(src.evidence), src?.measured_value ?? null, src?.threshold_value ?? null],
      );
      return;
    }
    case "resolve":
      await tx.query("UPDATE aux_findings SET status = 'resolved', resolved_at = $2 WHERE id = $1", [action.id, at]);
      return;
  }
}
