import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import type { Job } from "bullmq";
import { z } from "zod";
import type { TaskGenerateJobPayload } from "../../../../contracts/tasks/index.js";
import {
  auxErrorSummarySchema,
  crawlAuditJobPayloadSchema,
  crawlManifestSchema,
  siteFileFindingSchema,
  type AuxErrorSummary,
  type AuxRuleFinding,
  type CrawlManifest,
  type SiteFileFinding,
} from "../../../../contracts/aux/index.js";
import { loadAuxCatalog, type AuxCatalog } from "../../aux/catalog.js";
import { generateSiteFilePatch, type SiteInputs } from "../../aux/patches/generate.js";
import { PatchRejectedError, type PatchDraft } from "../../aux/patches/types.js";
import {
  findingFingerprint,
  milestoneKindFor,
  reconcileFindings,
  STALE_AFTER_AUDITS,
  type AuxSeverityBand,
  type DetectedFinding,
  type ExistingFinding,
  type FindingStatus,
  type LifecycleAction,
} from "../../aux/lifecycle.js";
import { crawlPages, NOMINARA_USER_AGENT, type PageRecord } from "../../aux/page-crawl.js";
import { pageFindingFingerprint, runPageRules } from "../../aux/page-rules.js";
import { AUX_RULES, AUX_RULES_NOT_EVALUATED, AUX_RULES_PARTIAL } from "../../aux/rules/index.js";
import { pageCapForPlan, selectPages, type SelectionScope } from "../../aux/page-selection.js";
import { PolitenessBudget, PolitenessCapReached, PolitenessDeadlineReached } from "../../aux/politeness.js";
import { unavailableRenderer, type Renderer } from "../../aux/renderer.js";
import { CRAWL_AGENT, crawlDelayFor, isAllowed, parseRobots, sitemapUrlsOf, type ParsedRobots } from "../../aux/robots.js";
import { AUX_AUDIT_RULE_VERSION, AUX_AUDIT_TOKENIZER } from "../../aux/audit-constants.js";
import { failManualAudit } from "../../aux/fail-manual-audit.js";
import { refundAuxAuditCharge } from "../../credits/aux-audit-refund.js";
import { sanitiseText } from "../../aux/sanitise.js";
import { AI_CRAWLER_AGENTS, evaluateSiteFiles, type SiteFile } from "../../aux/site-files.js";
import { collectSitemap, MAX_SITEMAP_FILES, SitemapFetchSkipped, type SitemapResult } from "../../aux/sitemap.js";
import { guardedFetch, type GuardedFetchInit, type GuardedResponse } from "../../net/guarded-fetch.js";
import { uuidV7 } from "../../ids/uuidv7.js";
import { toRegistrableDomain } from "../../net/registrable-domain.js";
import { AUX_HARD_CAP, auxDecidedBasis, auxScore, type AuxCategory, type AuxCountedFinding } from "../../scoring/aux.js";
import { S3Adapter } from "../../storage/s3.adapter.js";
import { resolveStorageConfig } from "../../storage/storage-config.js";
import type { ObjectStoragePort } from "../../storage/storage.port.js";
import { TenantObjectStore } from "../../storage/tenant-object-store.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import { afterCommit, currentTenantStore } from "../../../tenancy/tenant-context.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../connection.js";
import type { QueueHandlerContext } from "../handlers.js";
import { QueueProducer } from "../queue-producer.js";
import { PHASES_DONE, phasedProcessor, signingKeysFromEnv, type JobProcessor } from "../worker-factory.js";

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
// THE PAGE RULES (STORY-051 AC13). After the pages are stored, `run` reads them back (from the copies it just wrote, held in memory for the
// purpose), models each (loadDocumentSnapshot -> buildAuxDocument with cl100k) and evaluates the 22 document-model rules over every page
// (evaluateDocuments), all in the fetch phase, so no transaction is open while it works. `commit` reconciles those findings in the same
// lifecycle as the site-file ones (STORY-052). A rule is named in `excluded_rules` only when it did not run on ANY page: the codes in
// AUX_RULES_NOT_EVALUATED always (incl. the held AUX-R-013), AUX-R-026/027 when no page had a rendered copy, AUX-R-029 when no page had a
// measured timing. The partly-checked rules that did run (AUX_RULES_PARTIAL) are listed in `error_summary.rules_partial`.
//
// WHAT IS STILL NOT EVALUATED. AUX-R-005 (bot-hostile
// edge rules) CANNOT be evaluated at all: OWNER DECISION 2026-10-22, Nominara sends every request as NominaraBot and never under
// another crawler's name, so a firewall or CDN rule that blocks by user agent is not observable here. AI-bot access is judged
// from what robots.txt publishes for each AI crawler token (`ai_bot_access` in the manifest; AUX-R-001/002 as findings).
// `excluded_rules` names all of this. THE HEADLINE (owner decisions 38, 52 and 55): when pages were judged, `aux_score` is computed over the RULES that were decided: a category is
// scored on the decided rules only (its max_penalty is their weights' sum, so an unmeasured rule does not count as passed), a category with no decided rule is
// dropped, a finding whose rule was not decided in this audit (stale / not re-checked) costs nothing and weighs nothing (decision 55), and the sum is renormalised to 100 and capped at 72 by a critical crawler_access finding; the API serves it with `score_partial` and `unmeasured_categories`, and each category lists the rules that did not run in it. With no page judged
// (site files only) it stays null: one category's subscore is published, but that is not a headline. `score_capped` says whether the cap applies to the number
// (decision 57): it is set when a critical crawler_access finding is open AND crawler_access is in this audit's basis, so a true flag never accompanies a headline above 72.
// When no page is judged the flag can be true while the headline is null (decision 56).
//
// A JOB THAT FAILS (review round 1). A rule that crashes on one page's markup is that page's problem (page-rules.ts: unmodelled, `rule_error:<code>`), so the audit
// ends `partial` instead of never publishing. Anything else that throws walks the retry ladder; on the LAST attempt a MANUAL audit is failed and its charge
// refunded in full (`recover`), and a manual audit whose job never finishes at all is failed and refunded by the 60-minute reaper (aux/stale-audit-reaper.ts).
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

export const RULE_VERSION = AUX_AUDIT_RULE_VERSION;
export const FETCH_TIMEOUT_MS = 10_000;
/**
 * NOT FROM THE REFERENCE. The wall-clock budget for one audit's requests to the target. An honest crawl is ~80 requests at
 * 500 ms plus response time, i.e. about a minute; 10 minutes leaves an order of magnitude of slack and still ends a crawl
 * that a slow or hostile target would stretch. Provisional until the architect names a number.
 */
export const CRAWL_WALL_CLOCK_BUDGET_MS = 10 * 60 * 1000;
/** aux-and-geo-analysis.md §1: a 500 ms minimum interval between requests to one host. */
export { MIN_INTERVAL_MS as POLITENESS_INTERVAL_MS } from "../../aux/politeness.js";
// STORY-050 AC3: the tokenizer the audit's token-count thresholds are measured with (the embedding model's own), so a future change is visible.
const TOKENIZER = AUX_AUDIT_TOKENIZER;
/** The one path every audit can speak for is the root. The same list is judged by evaluateRobotsTxt and used by the robots patch. */
const AUDIT_TRACKED_PATHS: readonly string[] = ["/"];
const RAN_RULES = ["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-004", "AUX-R-007"] as const;
const TERMINAL_STATUSES = ["completed", "partial", "failed"];
const OPEN_STATUSES = ["open", "acknowledged", "in_progress", "regressed"];
/**
 * The statuses the published crawler_access subscore and the critical cap read. A STALE finding is one we could not re-observe, not one
 * that was fixed: it must score exactly as it did while open, or an unreachable file reads as a fix (STORY-052 "stale versus resolved").
 */
const SCORED_STATUSES = [...OPEN_STATUSES, "stale"];
/** Owned citations from the last 90 days name pages a key_pages audit must look at (aux-and-geo-analysis.md §1 step 3). */
const CITATION_WINDOW_DAYS = 90;
/** A bound on what one project's evidence can add to the candidate list; the page cap does the real limiting. */
const EVIDENCE_URL_LIMIT = 500;

const tracer = trace.getTracer("nominara.crawl-audit");

type StoreFn = (relative: string, body: Buffer, contentType: string) => Promise<string>;

/** STORY-052 AC10 — enqueues one `task.generate` job for a project, narrowed to the AUX finding rules. Injected in tests. */
export type EnqueueTaskGenerate = (workspaceId: string, payload: Omit<TaskGenerateJobPayload, "workspaceId" | "kid">, idempotencyKey: string) => Promise<unknown>;

/** Severity bands in order, for "at or above the rule's task threshold" (aux-and-geo-analysis.md section 2, the `Task` column). */
const SEVERITY_ORDER: Readonly<Record<string, number>> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

export interface CrawlAuditDeps {
  /** Default: a producer built from env on first use. A failed enqueue is logged and counted, never thrown. */
  readonly enqueueTaskGenerate?: EnqueueTaskGenerate;
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

/** The page rules the engine runs (STORY-051): everything outside the site-file rules and AUX_RULES_NOT_EVALUATED. */
const PAGE_RULE_CODES: readonly string[] = AUX_RULES.map((r) => r.code);
const NOT_EVALUATED_CODES: readonly string[] = Object.keys(AUX_RULES_NOT_EVALUATED);
/** Every rule that can open a finding: the site-file rules and the page rules. */
const FINDING_RULE_CODES: readonly string[] = [...RAN_RULES, ...PAGE_RULE_CODES];

/** What a lifecycle action needs from a detection: the stored evidence and the two numbers. A site-file finding and a page-rule finding both fit. */
interface FindingSource {
  readonly evidence: object;
  readonly measured_value: number | null;
  readonly threshold_value: number | null;
  /** Page-rule findings carry the catalog's rule version; a site-file finding is stamped with RULE_VERSION. */
  readonly rule_version?: string;
}

/** All 34 rule codes, from the reference (§2). */
const ALL_RULE_CODES: readonly string[] = Array.from({ length: 34 }, (_, i) => `AUX-R-${String(i + 1).padStart(3, "0")}`);
const RULES_NOT_RUN: readonly string[] = ALL_RULE_CODES.filter((c) => !(RAN_RULES as readonly string[]).includes(c));
/**
 * Every rule an audit that modelled NO page did not run: all but the five site-file rules, and `page_crawl` (named only when no page was crawled:
 * naming it after one was would be false). An audit that did model pages names fewer (see `commit`): the page rules that ran are dropped.
 */
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
  // Built on the first job that needs it, inside the promise: constructing a producer at registration would open a connection in every
  // process that merely imports the registry, and a synchronous throw would escape the caller's `.catch`.
  let producer: QueueProducer | undefined;
  const enqueueTaskGenerate: EnqueueTaskGenerate =
    deps.enqueueTaskGenerate ??
    (async (workspaceId, payload, idempotencyKey): Promise<unknown> => {
      producer ??= new QueueProducer(createQueueWorkerConnection(context.env.QUEUE_REDIS_URL), queueKeyPrefix(context.env.NODE_ENV), signingKeysFromEnv(context.env));
      return producer.enqueueTenantJob("task.generate", workspaceId, payload, { idempotencyKey });
    });
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
    /** Owner decision 47: no page at all. */
    readonly siteFilesOnly: boolean;
    readonly pageCap: number;
    readonly startedAt: Date;
    readonly startedMs: number;
    /** Minted per DELIVERY: every object this delivery stores lies under {audit_id}/{run_id}/, so a duplicate cannot overwrite the winner's. */
    readonly runId: string;
    readonly evidence: { readonly citations: string[]; readonly tasks: string[] };
    readonly store: StoreFn;
    /** The rule catalog, read (and its weights asserted) in `prepare`: the page rules need it in `run`, which has no client. */
    readonly catalogRows: readonly CatalogRow[];
    readonly catalog: AuxCatalog;
  }

  interface CatalogRow {
    readonly code: string;
    readonly category: string;
    readonly title: string;
    readonly weight: number;
    readonly rule_version: string;
    readonly thresholds: Record<string, unknown>;
    readonly task_threshold: string;
    readonly auto_fixable: boolean;
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
    /** The site's own page URLs from its sitemap: the only source a generated llms.txt takes links from. */
    readonly sitemapUrls: readonly string[];
    readonly allSiteFileUrls: string[];
    readonly detected: (DetectedFinding & { readonly source: FindingSource })[];
    readonly covered: ReadonlySet<string>;
    /** Per page the page rules looked at: the rules that could be decided on it. */
    readonly pageEvaluated: ReadonlyMap<string, ReadonlySet<string>>;
    /** Pages whose stored copy could not be read back or modelled. */
    readonly unmodelledPages: number;
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
      await failUnrunManualAudit(tx, payload, "project_deleted");
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

    // The catalog is versioned data: assert its weights on every load (NFR-AUX-03) - all six categories and the category weights
    // (STORY-051 AC6), not only crawler_access. Read HERE because the page rules run in `run`, which has no client.
    const catalogResult = await tx.query<CatalogRow>(
      "SELECT code, category, title, weight, rule_version, thresholds, task_threshold, auto_fixable FROM aux_rule_catalog",
    );
    const catalog: AuxCatalog = loadAuxCatalog(
      catalogResult.rows.map((r) => ({ code: r.code, category: r.category, weight: r.weight, ruleVersion: r.rule_version, autoFixable: r.auto_fixable, thresholds: r.thresholds })),
    );

    // AUTHORIZE (step 1). Fails closed: no verified row, no full scope.
    const verifiedRow = await tx.query(
      "SELECT 1 FROM domain_verifications WHERE project_id = $1 AND domain = $2 AND verified_at IS NOT NULL LIMIT 1",
      [payload.projectId, rootDomain],
    );
    const verified = verifiedRow.rows.length > 0;
    // OWNER DECISION 47: a site-files-only job (a Free project's onboarding check) is held to the site files whatever the verification state says: public_surface,
    // and no page is chosen, fetched or judged (see fetchPhase). The flag is on a signed job; a manual job cannot carry it (the payload contract refuses that).
    const siteFilesOnly = payload.siteFilesOnly === true;
    const scope: SelectionScope = verified && !siteFilesOnly ? (payload.scope ?? "key_pages") : "public_surface";
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
      siteFilesOnly,
      pageCap: deps.pageCap ?? pageCapForPlan(planKey),
      startedAt,
      startedMs,
      runId: uuidV7(),
      evidence,
      // Bound to THIS workspace here, inside the tenant context; the writer works later with no context and no transaction.
      store: deps.store ?? bindDefaultStore(context, deps.storagePort),
      catalogRows: catalogResult.rows,
      catalog,
    };
  }

  /** THE FETCH PHASE. No transaction, no client: site files, sitemap, pages (both copies), object-store writes. */
  async function run(prepared: Prepared): Promise<Outcome> {
    return tracer.startActiveSpan("crawl.audit.fetch", async (span) => {
      try {
        const outcome = await fetchPhase(prepared);
        span.setAttribute("nominara.crawl.kind", outcome.kind);
        span.setAttribute("nominara.crawl.pages_crawled", outcome.kind === "crawled" ? outcome.pagesCrawled : 0);
        span.setAttribute("nominara.crawl.pages_evaluated", outcome.kind === "crawled" ? outcome.pageEvaluated.size : 0);
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
    const { payload, rootUrl, origin, scope, pageCap, evidence, store: writeObject, runId, catalog } = prepared;
    // The page copies this audit stores are also what the page rules read back. They are held here, keyed by the stored key, until the rules
    // have run: the gzipped bytes the crawl just wrote, so nothing is fetched again and the recorded hash still proves what is modelled.
    const pageCopies = new Map<string, Buffer>();
    const store: StoreFn = async (relative, body, contentType) => {
      const key = await writeObject(relative, body, contentType);
      if (contentType === "application/gzip") pageCopies.set(key, body);
      return key;
    };
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
    // A site-files-only audit (owner decision 47) selects nothing: the sitemap was READ for its facts, but no page is fetched, rendered or judged.
    const selection = prepared.siteFilesOnly
      ? { urls: [] as string[], overCap: 0, skipped: [] as { url: string; reason: string }[] }
      : selectPages({
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

    // EVALUATE (step 6): the page rules over the stored pages. No transaction is open (this is `run`), and nothing is fetched.
    const pageRules = await tracer.startActiveSpan("crawl.audit.evaluate", async (span) => {
      try {
        const result = await runPageRules(
          manifest.pages,
          async (objectKey) => {
            const copy = pageCopies.get(objectKey);
            if (copy === undefined) throw new Error("page copy not held");
            return copy;
          },
          catalog,
          { projectId: payload.projectId },
        );
        span.setAttribute("nominara.aux.pages_evaluated", result.evaluated.size);
        span.setAttribute("nominara.aux.page_findings", result.findings.length);
        span.setAttribute("nominara.aux.pages_unmodelled", result.unmodelled.length);
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
    pageCopies.clear();
    observeValue("nominara_aux_pages_evaluated_count", pageRules.evaluated.size, { trigger: payload.trigger });
    // The rules that ran on at least one page, and of those the ones that ran on an interim reading (AUX_RULES_PARTIAL): they get their own annotation.
    const decidedAnywhere = new Set<string>();
    for (const rules of pageRules.evaluated.values()) for (const code of rules) decidedAnywhere.add(code);
    const rulesPartial = Object.keys(AUX_RULES_PARTIAL).filter((code) => decidedAnywhere.has(code)).sort();

    const pagesFailed = failedPages.length - partialPages.length;
    const pagesSkippedByDelay = delaySkippedRecords.length + skippedPages.filter((p) => p.skipped_reason === "crawl_delay_budget").length;
    // Present whenever the Crawl-delay or the wall-clock budget shaped the crawl: a skip, or a delay that was shortened to the cap.
    const delayLimited =
      budget.declaredCrawlDelayMs !== null || pagesSkippedByDelay > 0 || crawl.stoppedAtDeadline || siteFilesSkipped.length > 0 || sitemapResult.problems.some((p) => p.reason === "crawl_delay_budget");
    const summary: AuxErrorSummary = {
      ...(siteFilesFailed.length > 0 ? { site_files_failed: siteFilesFailed } : {}),
      ...(failedPages.length > 0 ? { failed_pages: failedPages.map((p) => ({ url: p.url, failures: p.failures })) } : {}),
      ...(skippedPages.length > 0 || delaySkippedRecords.length > 0 || siteFilesSkipped.length > 0 || pageRules.unmodelled.length > 0
        ? {
            skipped_pages: [
              ...siteFilesSkipped,
              ...skippedPages.map((p) => ({ url: p.url, reason: p.skipped_reason ?? "skipped" })),
              ...delaySkippedRecords,
              ...pageRules.unmodelled.map((p) => ({ url: sanitiseText(p.url, 2048), reason: p.reason })),
            ],
          }
        : {}),
      ...(rulesPartial.length > 0 ? { rules_partial: rulesPartial } : {}),
      // Which pages the page rules looked at: what a LATER audit reads to tell "the page was fine" from "nobody looked" (per-URL staleness, STORY-052 AC8).
      ...(pageRules.evaluated.size > 0 ? { pages_modelled: [...pageRules.evaluated.keys()].filter((u) => u.length <= 2048).sort().slice(0, 500) } : {}),
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
      trackedPaths: AUDIT_TRACKED_PATHS,
      now: finishedAt,
    });

    // A rule is "covered" only when its input file got an HTTP answer. A
    // finding from a file we failed to fetch (or never asked for) is not evidence, and a missing
    // finding from one is not a resolution.
    const covered = new Set<string>();
    // AUX-R-003 is about the answer itself, so any answer covers it. AUX-R-001/002 are about the directives, and only a 2xx file or a
    // definitive "no file" (404/410) says what they are: a 5xx or other error is "we could not see it" (RFC 9309 treats an unreachable
    // robots.txt as disallow-all), so it must not resolve a blocking finding.
    if (robots.responded) covered.add("AUX-R-003");
    if (robots.responded && ((robots.status >= 200 && robots.status < 300) || robots.status === 404 || robots.status === 410)) {
      covered.add("AUX-R-001");
      covered.add("AUX-R-002");
    }
    if (llms.responded && llmsWellKnown.responded) covered.add("AUX-R-004");
    if (sitemap.responded) covered.add("AUX-R-007");

    const urlFor = (f: SiteFileFinding): string => (f.evidence.file === "robots.txt" ? urls.robots : f.evidence.file === "llms.txt" ? urls.llms : sitemapUrl);
    const siteDetected = evaluated
      .map((f) => siteFileFindingSchema.parse(f))
      .filter((f) => covered.has(f.rule_code))
      .map((f) => ({ f, url: urlFor(f) }))
      .map(({ f, url }): DetectedFinding & { readonly source: FindingSource } => ({
        fingerprint: findingFingerprint(f.rule_code, url, f.evidence),
        ruleCode: f.rule_code,
        url,
        severity: f.severity,
        source: f,
      }));
    // Page-rule findings: identity over rule, URL and locator (STORY-052 AC4), evidence in the rule-finding shape. Only a finding on a page the
    // rules actually decided counts as a detection; the lifecycle reads `pageEvaluated` for what a later audit may resolve.
    const pageDetected = pageRules.findings.map((f: AuxRuleFinding): DetectedFinding & { readonly source: FindingSource } => ({
      fingerprint: pageFindingFingerprint(f),
      ruleCode: f.rule_code,
      url: f.url,
      severity: f.severity,
      source: { evidence: f.evidence, measured_value: f.measured_value, threshold_value: f.threshold_value, rule_version: f.rule_version },
    }));
    const detected = [...siteDetected, ...pageDetected];

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
      sitemapUrls: sitemapResult.urls.map((e) => e.loc),
      allSiteFileUrls: [...Object.values(urls), sitemapUrl, ...pagesToCrawl],
      detected,
      covered,
      pageEvaluated: pageRules.evaluated,
      unmodelledPages: pageRules.unmodelled.length,
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
    const project = await tx.query<{ name: string }>("SELECT name FROM projects WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE", [payload.projectId]);
    if (project.rows.length === 0) {
      incrementCounter("nominara_aux_crawl_commit_total", { outcome: "project_gone" });
      logger.log(`project ${payload.projectId} was deleted during audit ${payload.auditId}; writing nothing`);
      await failUnrunManualAudit(tx, payload, "project_deleted");
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
      // A manual audit that delivered nothing gives its charge back, in full and in this transaction (a partial audit is charged in full).
      if (payload.trigger === "manual") await refundAuxAuditCharge(tx, { workspaceId: payload.workspaceId, auditId: payload.auditId, reason: "audit_failed" });
      incrementCounter("nominara_aux_audits_total", { status: "failed", trigger: payload.trigger });
      incrementCounter("nominara_aux_crawl_commit_total", { outcome: "written" });
      logger.log(`audit ${payload.auditId} (project ${payload.projectId}): no site file reachable`);
      return;
    }

    // The catalog `prepare` read and asserted (NFR-AUX-03): the same rows the page rules were evaluated with.
    const { catalog, catalogRows } = prepared;
    const titles = new Map(catalogRows.map((r) => [r.code, r.title]));
    const taskThresholds = new Map(catalogRows.map((r) => [r.code, r.task_threshold]));

    const { detected, covered, finishedAt, pageEvaluated } = outcome;
    // Read HERE, under the lock on this audit row, so a delivery that committed a moment ago is already visible.
    const existingRows = await tx.query<{
      id: string; fp: string; rule_code: string; url: string | null; severity: AuxSeverityBand; status: FindingStatus; occurrence_count: number; resolved_at: Date | null; category: string | null;
    }>(
      `SELECT f.id, encode(f.fingerprint, 'hex') AS fp, f.rule_code, f.url, f.severity, f.status, f.occurrence_count, f.resolved_at,
              (SELECT c.category FROM aux_rule_catalog c WHERE c.code = f.rule_code) AS category
         FROM aux_findings f WHERE f.project_id = $1 AND f.rule_code = ANY($2::text[])`,
      [payload.projectId, [...FINDING_RULE_CODES]],
    );
    const existing: ExistingFinding[] = existingRows.rows.map((r) => ({
      id: r.id, fingerprint: r.fp, ruleCode: r.rule_code, url: r.url, severity: r.severity, status: r.status, occurrenceCount: r.occurrence_count, resolvedAt: r.resolved_at,
    }));

    // A site-file finding is in scope when its input file got an answer. A PAGE finding is in scope only when this audit modelled that very page AND
    // the rule could be decided on it: a page that failed to fetch, was skipped or was not selected, or a rule the page had no input for (AUX-R-026/027
    // with no rendered copy, AUX-R-029 with no timing), is "we could not look" - never a resolution.
    const pageRuleCodes = new Set(PAGE_RULE_CODES);
    const inScope = (row: ExistingFinding): boolean =>
      pageRuleCodes.has(row.ruleCode)
        ? row.url !== null && (pageEvaluated.get(row.url)?.has(row.ruleCode) ?? false)
        : covered.has(row.ruleCode) && (row.url === null || row.url.startsWith(origin));

    // STALE (AC8): the audits just before this one that also could not observe the place a finding lives. `excluded_rules` is the record
    // of which rules had no answer from their input file (a site file that did not respond, or an audit that reached nothing), so it
    // is read, not re-derived: no new column. Counted back from the latest and stopping at the first audit that DID observe it, so two
    // CONSECUTIVE audits are required, never two in a window. Only audits that finished count, and only those strictly BEFORE this one: a redelivered older job must not read a newer audit as its predecessor.
    const history = await tx.query<{ excluded_rules: string[]; error_summary: { pages_modelled?: string[] } | null }>(
      `SELECT excluded_rules, error_summary FROM aux_audits
        WHERE project_id = $1 AND id <> $2 AND status = ANY($3::text[])
          AND (created_at, id) < (SELECT created_at, id FROM aux_audits WHERE id = $2)
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [payload.projectId, payload.auditId, TERMINAL_STATUSES, STALE_AFTER_AUDITS - 1],
    );
    // A SITE-FILE finding lives in a file: an audit did not observe it when its rule is in that audit's `excluded_rules`. A PAGE finding lives on a URL, and its rule
    // is excluded only when it ran on NO page, so `excluded_rules` cannot say the page was missed (a 404, a page no longer in the sitemap) while the rule ran
    // elsewhere: an earlier audit did not observe it when that audit did not model the URL. `pages_modelled` is that record. An audit with no record (one that
    // failed before it ran) is NOT counted as a miss: nobody looked, but nobody could have seen it gone either, so it breaks the run rather than extending it.
    const observedIn = (audit: (typeof history.rows)[number], row: ExistingFinding): boolean => {
      if (audit.excluded_rules.includes(row.ruleCode)) return false;
      if (!pageRuleCodes.has(row.ruleCode)) return true;
      const modelled = audit.error_summary?.pages_modelled;
      return modelled === undefined || row.url === null ? true : modelled.includes(row.url);
    };
    const unobservedBefore = (row: ExistingFinding): number => {
      let run = 0;
      for (const audit of history.rows) {
        if (observedIn(audit, row)) break;
        run += 1;
      }
      return run;
    };

    const actions = reconcileFindings({ existing, detected, inScope, unobservedBefore });
    const byFingerprint = new Map(detected.map((d) => [d.fingerprint, d.source]));
    const sourceFor = (id: string): FindingSource | undefined => {
      const row = existing.find((e) => e.id === id);
      return row === undefined ? undefined : byFingerprint.get(row.fingerprint);
    };

    const categoryOf = new Map(existingRows.rows.map((r) => [r.id, r.category]));
    const severityOf = new Map(existing.map((e) => [e.id, e.severity]));
    let milestonesPinned = 0;
    await tracer.startActiveSpan("crawl.audit.reconcile", async (span) => {
      try {
        for (const action of actions) {
          const pinned = await applyAction(tx, action, { payload, titles, ruleVersion: RULE_VERSION, at: finishedAt, sourceFor, categoryOf, severityOf });
          if (pinned) milestonesPinned += 1;
        }
        span.setAttribute("nominara.aux.actions", actions.length);
        span.setAttribute("nominara.aux.staled", actions.filter((a) => a.kind === "stale").length);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
    for (const action of actions) {
      if (action.kind === "stale") incrementCounter("nominara_aux_findings_staled_total", {});
      if (action.kind === "resolve") incrementCounter("nominara_aux_findings_resolved_total", {});
    }
    if (milestonesPinned > 0) for (let i = 0; i < milestonesPinned; i += 1) incrementCounter("nominara_aux_milestones_pinned_total", {});

    // COPY-READY PATCHES (STORY-053). Pure CPU over what the crawl already fetched: no request, no model, no charge.
    const isOk = (f: Fetched): f is Extract<Fetched, { responded: true }> => f.responded && f.status >= 200 && f.status < 300;
    const isGone = (f: Fetched): boolean => f.responded && (f.status === 404 || f.status === 410);
    const site: SiteInputs = {
      origin,
      siteName: project.rows[0]!.name,
      projectId: payload.projectId,
      pageUrls: outcome.sitemapUrls,
      robots: isOk(outcome.robots) && outcome.robotsHash !== null ? { body: outcome.robots.file.body, hash: outcome.robotsHash } : null,
      llms: isOk(outcome.llms) ? { body: outcome.llms.file.body } : null,
      // Only /llms.txt is judged. Absent means it answered 404 or 410 AND the well-known location has no file either (llms_txt_present,
      // which page_matches reads, counts both). An error answer says nothing about whether a file exists behind it.
      trackedPaths: AUDIT_TRACKED_PATHS,
      llmsPatchable: isOk(outcome.llms) || (isGone(outcome.llms) && !isOk(outcome.llmsWellKnown)),
    };
    const patchStats = await tracer.startActiveSpan("crawl.audit.patches", async (span) => {
      try {
        const stats = await writePatches(tx, { payload, detected: detected.filter((d) => (RAN_RULES as readonly string[]).includes(d.ruleCode)), site, logger });
        span.setAttribute("nominara.aux.patches_written", stats.written);
        span.setAttribute("nominara.aux.patches_rejected", stats.rejected);
        return stats;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });

    // TASK GENERATION (AC10): a finding that is NEW, or RETURNED (a regression raises its band), and sits at or above its rule's task
    // threshold asks for one `task.generate` evaluation of the project, narrowed to the AUX finding rules. A re-detection of a finding
    // already known asks for nothing: its task, if it earned one, exists or was dismissed. One job per qualifying finding, keyed as the
    // topology row says (`taskgen:{project}:{rule}:{fingerprint}`, system-architecture.md section 4), so a redelivered audit enqueues the
    // same ids. After COMMIT, so the evaluator sees the findings; a failed enqueue is logged and counted, never thrown, because the
    // findings are durable and the daily rollup's un-narrowed `task.generate` is the recovery path.
    const atThreshold = (ruleCode: string, severity: string): boolean =>
      (SEVERITY_ORDER[severity] ?? -1) >= (SEVERITY_ORDER[taskThresholds.get(ruleCode) ?? "high"] ?? SEVERITY_ORDER.high!);
    const wanting: { ruleCode: string; fingerprint: string }[] = [];
    for (const a of actions) {
      if (a.kind === "insert" && atThreshold(a.finding.ruleCode, a.finding.severity)) wanting.push({ ruleCode: a.finding.ruleCode, fingerprint: a.finding.fingerprint });
      else if (a.kind === "regress") {
        const row = existing.find((e) => e.id === a.id)!;
        if (atThreshold(row.ruleCode, a.severity)) wanting.push({ ruleCode: row.ruleCode, fingerprint: row.fingerprint });
      }
    }
    if (wanting.length > 0 && currentTenantStore() !== undefined) {
      const { projectId, workspaceId, auditId } = payload;
      afterCommit(() => {
        for (const { ruleCode, fingerprint } of wanting) {
          void enqueueTaskGenerate(workspaceId, { projectId, triggerKinds: ["aux_finding"] }, `taskgen:${projectId}:${ruleCode}:${fingerprint}`)
            .then(() => {
              incrementCounter("nominara_aux_taskgen_requested_total", {});
              logger.log({ event: "aux.taskgen.requested", workspace_id: workspaceId, project_id: projectId, audit_id: auditId, rule_code: ruleCode });
            })
            .catch((error: unknown) => {
              incrementCounter("nominara_aux_taskgen_request_failed_total", {});
              logger.error({ event: "aux.taskgen.request_failed", workspace_id: workspaceId, project_id: projectId, audit_id: auditId, rule_code: ruleCode, error: error instanceof Error ? error.name : "unknown" });
            });
        }
      });
    }

    // Audit-level counts: what THIS audit detected, by severity.
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const d of detected) if (d.severity in counts) counts[d.severity as keyof typeof counts] += 1;

    // STORY-052 AC9: the pages a page rule's findings are open on are RECORDED on each of its rows (the distinct URLs, across every audit's findings that are still
    // scored). The COLUMN is project-wide - it counts pages this audit did not model too (stale is not fixed) - while the SCORE below counts only the pages this
    // audit modelled (`lookedAt`, floored at the scope floor); the two agree only when every open page was modelled now. A site-file finding keeps its 1.
    await tx.query(
      `UPDATE aux_findings f SET affected_pages = s.n
         FROM (SELECT rule_code, count(DISTINCT url)::int AS n FROM aux_findings
                WHERE project_id = $1 AND status = ANY($2::text[]) AND rule_code = ANY($3::text[]) GROUP BY rule_code) s
        WHERE f.project_id = $1 AND f.rule_code = s.rule_code AND f.status = ANY($2::text[]) AND f.affected_pages IS DISTINCT FROM s.n`,
      [payload.projectId, SCORED_STATUSES, [...PAGE_RULE_CODES]],
    );

    // THE SCORE (scoring-models.md section 7) over every finding still open for the project - including ones whose page or file this audit could not
    // re-observe, and stale ones: stale is not fixed. A site-file finding is domain-wide, so it affects every page crawled (scope 1). A page finding
    // affects the distinct pages it is open on (STORY-052 AC9), never more than the pages this audit crawled; the scope factor is floored at 0.25.
    const open = await tx.query<{ rule_code: string; severity: AuxSeverityBand; url: string | null }>(
      "SELECT rule_code, severity, url FROM aux_findings WHERE project_id = $1 AND status = ANY($2::text[]) AND rule_code = ANY($3::text[]) ORDER BY rule_code, url NULLS FIRST, id",
      [payload.projectId, SCORED_STATUSES, [...FINDING_RULE_CODES]],
    );
    // OWNER DECISIONS 52 and 55. The rules that were DECIDED in this audit: the site-file rules whose file answered, and the page rules that ran on at least one page.
    // This one set is BOTH the score basis and the penalty set. A category is scored ONLY on those rules: max_penalty(cat) is the sum of the decided rules' weights, so a
    // rule nobody could judge (AUX-R-026/027 with no renderer, AUX-R-029 with no timing, the held AUX-R-013, ...) is out of the denominator instead of counting as passed.
    // A category with no decided rule is dropped. An open or stale finding whose rule was NOT decided in this audit (not re-checked) contributes NOTHING - not to the
    // penalty, not to the denominator; it stays in the findings list as stale / not re-checked (the lifecycle, STORY-052, is untouched). Its rule is named in
    // `excluded_rules`, so the headline is partial.
    const decidedAnywhere = new Set<string>();
    for (const rules of pageEvaluated.values()) for (const code of rules) decidedAnywhere.add(code);
    const decidedRules = new Set<string>(covered);
    if (pageEvaluated.size > 0) {
      for (const code of decidedAnywhere) decidedRules.add(code);
    }
    const pagesForScore = Math.max(1, pageEvaluated.size);
    // scoring-models.md section 7 counts a FINDING with the pages it affects: scope(f) = affected_pages(f) / pages_crawled. The page rules open one row per
    // page (and per place on it), so those rows are folded back to one counted finding per rule - its worst severity, over the distinct pages it is open on -
    // or a rule broken on 3 pages would weigh 3 x 3/n instead of 3/n. A site-file finding is domain-wide: it affects every page crawled (scope 1).
    const bands: readonly AuxSeverityBand[] = ["info", "low", "medium", "high", "critical"];
    const perRule = new Map<string, { severity: AuxSeverityBand; urls: Set<string> }>();
    const counted: AuxCountedFinding[] = [];
    const asCategory = (code: string): AuxCategory => (catalog.byCode.get(code)?.category ?? "crawler_access") as AuxCategory;
    // `capped` follows every open critical crawler_access finding, decided or not: the cap is a policy on what is open, not penalty arithmetic. Whether it applies to THIS
    // audit's number is settled below, once the basis is known (decision 57).
    let capped = false;
    for (const r of open.rows) {
      if (asCategory(r.rule_code) === "crawler_access" && r.severity === "critical") capped = true;
      if (!decidedRules.has(r.rule_code)) continue; // decision 55: not decided in this audit, so it neither costs nor weighs
      if (!pageRuleCodes.has(r.rule_code)) {
        counted.push({ category: asCategory(r.rule_code), severity: r.severity, ruleWeight: catalog.byCode.get(r.rule_code)?.weight ?? 0, affectedPages: pagesForScore });
        continue;
      }
      const seen = perRule.get(r.rule_code) ?? { severity: r.severity, urls: new Set<string>() };
      if (bands.indexOf(r.severity) > bands.indexOf(seen.severity)) seen.severity = r.severity;
      seen.urls.add(r.url ?? "");
      perRule.set(r.rule_code, seen);
    }
    for (const [code, { severity, urls }] of perRule) {
      // Only the pages THIS audit modelled: a finding open on a page not looked at now still counts (stale is not fixed), but at the scope floor, never as a
      // page the audit crawled. (Otherwise the ratio would mix two page sets: pages of past audits over the pages of this one.)
      const lookedAt = [...urls].filter((u) => pageEvaluated.has(u)).length;
      counted.push({ category: asCategory(code), severity, ruleWeight: catalog.byCode.get(code)?.weight ?? 0, affectedPages: Math.min(pagesForScore, lookedAt) });
    }

    // Summed in CATALOG order (and as integer basis points inside auxDecidedBasis), so identical inputs give a bit-identical breakdown whatever order the sets were built in.
    const basis = auxDecidedBasis(catalog.rules.filter((rule) => decidedRules.has(rule.code)).map((rule) => ({ category: rule.category as AuxCategory, weight: rule.weight })));
    // A category whose every catalog rule was decided has a max penalty of exactly 1 (the catalog tolerates 1 +- 0.001).
    const categoryMaxPenalty: Partial<Record<AuxCategory, number>> = { ...basis.categoryMaxPenalty };
    for (const category of basis.categories) {
      if (catalog.rules.filter((rule) => rule.category === category).every((rule) => decidedRules.has(rule.code))) categoryMaxPenalty[category] = 1;
    }

    const status = outcome.siteFilesFailed + outcome.pagesFailed + outcome.partialPages + outcome.unmodelledPages + skippedSiteFileCount(outcome) > 0 || outcome.manifestStored === false ? "partial" : "completed";
    // Every rule that could not run is named: the ones outside this crawl, and any whose input file got no answer
    // (unreachable, or never asked for because the budget could not cover it).
    // A page rule is named only when it ran on NO page: AUX-R-026/027 with no rendered copy anywhere, AUX-R-029 with no measured timing anywhere.
    // With no page modelled, every page rule is excluded (and `page_crawl` too when none was crawled at all).
    const notRunOnPages =
      pageEvaluated.size > 0
        ? [...NOT_EVALUATED_CODES, ...PAGE_RULE_CODES.filter((code) => !decidedAnywhere.has(code))]
        : outcome.pagesCrawled > 0
          ? RULES_NOT_RUN
          : EXCLUDED_RULES;
    const excluded = [...new Set([...notRunOnPages, ...RAN_RULES.filter((code) => !covered.has(code))])];

    // The headline (decision 52): over the categories with a decided rule, each scored against its decided rules' weights, and PARTIAL whenever any rule went unmeasured
    // (`excluded` names them). With no category decided there is nothing to score; with no page judged the site files alone are not a headline (it stays null).
    const breakdown: Partial<Record<AuxCategory, number>> = {};
    const capAppliesToBasis = basis.categories.includes("crawler_access");
    const scoreCapped = capped && capAppliesToBasis;
    let headline: number | null = null;
    if (basis.categories.length > 0) {
      const scored = auxScore({
        findings: counted,
        pagesCrawled: pagesForScore,
        evaluatedCategories: basis.categories,
        categoryMaxPenalty,
        unmeasuredRules: excluded.filter((code) => catalog.byCode.has(code)),
      });
      for (const category of basis.categories) breakdown[category] = scored.subscores[category];
      // `basis.categories.includes("crawler_access")` is always true whenever a headline exists: a headline needs a judged page, and a judged page decides AUX-R-006
      // (a crawler_access page rule). It is kept so the cap and the flag below stay one rule that cannot drift apart if that ever stops holding.
      if (pageEvaluated.size > 0) headline = scoreCapped ? Math.min(scored.score, AUX_HARD_CAP) : scored.score;
    }

    await tx.query(
      `UPDATE aux_audits
          SET status = $2, pages_crawled = $3, pages_failed = $4, robots_snapshot = $5, robots_hash = $6, llms_txt_present = $7, sitemap_url_count = $8,
              aux_score = $20, score_capped = $9, score_breakdown = $10::jsonb,
              findings_critical = $11, findings_high = $12, findings_medium = $13, findings_low = $14, finished_at = $15,
              target_urls = $16, excluded_rules = $17, dom_object_prefix = $18, error_summary = $19::jsonb
        WHERE id = $1`,
      [
        payload.auditId, status, outcome.pagesCrawled, outcome.siteFilesFailed + outcome.pagesFailed,
        // The snapshot is stored verbatim except for what Postgres text cannot hold; the hash is of the bytes as fetched.
        outcome.robotsSnapshot,
        outcome.robotsHash,
        outcome.llmsPresent, outcome.sitemapCount, scoreCapped, JSON.stringify(breakdown),
        counts.critical, counts.high, counts.medium, counts.low, finishedAt,
        [...new Set(outcome.allSiteFileUrls)], excluded, outcome.domObjectPrefix, outcome.errorSummary,
        // null = no page was judged, so the site files alone are not a headline score; 0 would be a measured zero. With pages judged it is the partial score of
        // owner decisions 38 and 52 (the API serves `score_partial` and `unmeasured_categories`, derived from this breakdown and the excluded rules).
        headline,
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
      pages_evaluated: pageEvaluated.size,
      page_findings: detected.filter((d) => pageRuleCodes.has(d.ruleCode)).length,
      site_files_failed: outcome.siteFilesFailed,
      requests: outcome.requests,
      detected: detected.length,
      resolved: actions.filter((a) => a.kind === "resolve").length,
      staled: actions.filter((a) => a.kind === "stale").length,
      milestones: milestonesPinned,
      patches: patchStats.written,
      patches_rejected: patchStats.rejected,
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

  /**
   * A manual audit that will never run (its project is gone): fail the row the producer queued and give the charge back. Any other trigger has no row and no charge.
   * The refund FOLLOWS the row (aux/fail-manual-audit.ts): an audit that already finished is not touched and not refunded, however late this redelivery is.
   */
  async function failUnrunManualAudit(tx: ClientBase, payload: { auditId: string; workspaceId: string; trigger: string }, reason: "project_deleted"): Promise<void> {
    if (payload.trigger !== "manual") return;
    await failManualAudit(tx, { workspaceId: payload.workspaceId, auditId: payload.auditId, reason });
  }

  return phasedProcessor<Prepared, Outcome>({
    prepare: (tx, job) => prepare(tx, job),
    run: (prepared) => run(prepared),
    commit: (tx, prepared, outcome) => commit(tx, prepared, outcome),
    // A job that throws walks the retry ladder into the DLQ, and a MANUAL audit's row is `queued` (it is claimed only in `commit`) with the credits taken. On the LAST
    // attempt only (an earlier one is the queue's retry ladder), fail the audit and refund it in full, in a fresh tenant transaction after signature verification.
    // Only a row that is still queued or running moves, so an audit another delivery finished keeps its charge and the original error reaches the queue. An
    // onboarding or scheduled job has no charge and no row: nothing to settle, so the failure stays visible in the DLQ.
    async recover(tx: ClientBase, job: Job, failure) {
      if (!isFinalAttempt(job) && !isUnretryable(job, failure.error)) return false;
      // A payload this build can no longer parse (a newer producer's field, a schema drift) is exactly the job that fails every attempt, so it must not be the one
      // that is left unrefunded: read just the three fields a refund needs, each validated, from the signature-verified envelope. The write is still confined to the
      // job's tenant (failManualAudit's workspace predicate), so a wrong id settles nothing. A payload with no readable audit id is left to the 60-minute reaper
      // (aux/stale-audit-reaper.ts), which finds the row by status and age and needs no payload at all.
      const raw = (job.data as { payload: unknown }).payload;
      const parsed = crawlAuditJobPayloadSchema.safeParse(raw);
      const settleable = parsed.success ? parsed.data : refundFieldsSchema.safeParse(raw).data;
      if (settleable === undefined || settleable.trigger !== "manual") return false;
      const settled = await failManualAudit(tx, { workspaceId: settleable.workspaceId, auditId: settleable.auditId, reason: "job_failed" });
      if (settled) {
        incrementCounter("nominara_aux_audit_job_recovered_total", { phase: failure.phase });
        logger.warn({ event: "aux.audit.job_failed", workspace_id: settleable.workspaceId, audit_id: settleable.auditId, phase: failure.phase, error: failure.error instanceof Error ? failure.error.name : "unknown" });
      }
      return settled;
    },
  });
}

/** The three fields a refund needs, for a payload the full schema rejects. Unknown keys are ignored here on purpose: this is the fallback for a payload we cannot parse. */
const refundFieldsSchema = z.object({ auditId: z.string().uuid(), workspaceId: z.string().uuid(), trigger: z.string() });

/** True when BullMQ will not retry this job whatever the attempt count says: an `UnrecoverableError` (by name, as dead-letter.ts does), or a job with no retry ladder at all. */
function isUnretryable(job: Pick<Job, "opts">, error: unknown): boolean {
  return (error instanceof Error && error.name === "UnrecoverableError") || job.opts?.attempts === undefined;
}

/** True on the job's last attempt: the queue has no ladder left, so whatever this job owes has to be settled now. */
function isFinalAttempt(job: Pick<Job, "attemptsMade" | "opts">): boolean {
  const attempts = job.opts?.attempts;
  if (attempts === undefined) return false;
  return (job.attemptsMade ?? 0) + 1 >= attempts;
}

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

async function applyAction(
  tx: ClientBase,
  action: LifecycleAction,
  ctx: {
    payload: { auditId: string; projectId: string; workspaceId: string };
    titles: Map<string, string>;
    ruleVersion: string;
    at: Date;
    sourceFor: (id: string) => FindingSource | undefined;
    categoryOf: Map<string, string | null>;
    severityOf: Map<string, AuxSeverityBand>;
  },
): Promise<boolean> {
  const { payload, at } = ctx;
  switch (action.kind) {
    case "insert": {
      const src = (action.finding as DetectedFinding & { source: FindingSource }).source;
      await tx.query(
        `INSERT INTO aux_findings
           (workspace_id, project_id, audit_id, rule_code, url, severity, fingerprint, title, evidence, measured_value, threshold_value,
            rule_version, first_detected_at, last_detected_at)
         VALUES ($1,$2,$3,$4,$5,$6,decode($7,'hex'),$8,$9::jsonb,$10,$11,$12,$13,$13)`,
        [
          payload.workspaceId, payload.projectId, payload.auditId, action.finding.ruleCode, action.finding.url, action.finding.severity,
          action.finding.fingerprint, ctx.titles.get(action.finding.ruleCode) ?? action.finding.ruleCode, JSON.stringify(src.evidence),
          src.measured_value, src.threshold_value, src.rule_version ?? ctx.ruleVersion, at,
        ],
      );
      return false;
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
      return false;
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
      return false;
    }
    case "stale":
      // Not resolved: nobody could look. `resolved_at` stays NULL, and a later audit that sees the finding again reopens it.
      await tx.query("UPDATE aux_findings SET status = 'stale' WHERE id = $1", [action.id]);
      return false;
    case "resolve": {
      await tx.query("UPDATE aux_findings SET status = 'resolved', resolved_at = $2 WHERE id = $1", [action.id, at]);
      // AC11: closing a critical or high finding (or any structured_data one) pins a milestone to the Growth Map. ONE pin per finding for
      // ever (`ux_milestones_source` on (source_type, source_id)): a redelivery cannot double-pin, and a finding that resolves, regresses
      // and resolves again keeps its first pin, because the regression is already visible on the finding itself. `ON CONFLICT DO
      // NOTHING` is what makes that a quiet no-op rather than an error that would fail the whole audit.
      const kind = milestoneKindFor(ctx.severityOf.get(action.id) ?? "info", ctx.categoryOf.get(action.id) ?? null);
      if (kind === null) return false;
      const pinned = await tx.query(
        `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, severity, source_type, source_id)
         SELECT f.workspace_id, f.project_id, $2, $3, 'Resolved: ' || f.title, 'positive', 'aux_finding', f.id
           FROM aux_findings f WHERE f.id = $1
         ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
        [action.id, at, kind],
      );
      return (pinned.rowCount ?? 0) > 0;
    }
  }
}

/**
 * Writes the copy-ready patch for each finding this audit DETECTED and that is still live (open, acknowledged, in progress,
 * regressed; a will-not-fix finding is excluded from the score and from the work, so no patch is offered for it).
 *
 * A patch is IMMUTABLE: a finding re-detected with the same content and the same precondition writes nothing, and one whose
 * content or precondition changed gets a NEW row, so the artifact the customer already copied stays retrievable. A generator whose
 * own output fails a gate (it would block an agent, the markup is prohibited) is recorded and counted and offers NO patch: the audit
 * and its findings are unaffected. Anything else a generator throws is a bug and fails the job.
 */
async function writePatches(
  tx: ClientBase,
  args: { payload: { projectId: string; workspaceId: string }; detected: readonly DetectedFinding[]; site: SiteInputs; logger: Logger },
): Promise<{ written: number; rejected: number }> {
  const { payload, detected, site, logger } = args;
  if (detected.length === 0) return { written: 0, rejected: 0 };
  const live = await tx.query<{ id: string; fp: string; rule_code: string; url: string | null }>(
    `SELECT id, encode(fingerprint, 'hex') AS fp, rule_code, url FROM aux_findings
      WHERE project_id = $1 AND fingerprint = ANY($2::bytea[]) AND status = ANY($3::text[])`,
    [payload.projectId, detected.map((d) => Buffer.from(d.fingerprint, "hex")), OPEN_STATUSES],
  );
  let written = 0;
  let rejected = 0;
  for (const row of live.rows) {
    let draft: PatchDraft | null = null;
    try {
      const generated = generateSiteFilePatch({ ruleCode: row.rule_code, targetUrl: row.url ?? site.origin, url: row.url, site });
      if (generated.outcome === "patch") draft = generated.draft;
    } catch (error) {
      if (!(error instanceof PatchRejectedError)) throw error;
      rejected += 1;
      incrementCounter("nominara_aux_patch_rejected_total", { reason: error.reason });
      // IDs and the reason code only: never the file's text.
      logger.warn({ event: "aux.patch.rejected", workspace_id: payload.workspaceId, project_id: payload.projectId, finding_id: row.id, rule_code: row.rule_code, reason: error.reason });
      continue;
    }
    if (draft === null) continue;

    const latest = await tx.query<{ kind: string; target_url: string; content_before_hash: Buffer; content_after: string }>(
      "SELECT kind, target_url, content_before_hash, content_after FROM patches WHERE finding_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
      [row.id],
    );
    const prior = latest.rows[0];
    if (
      prior !== undefined &&
      prior.kind === draft.kind &&
      prior.target_url === draft.targetUrl &&
      prior.content_after === draft.contentAfter &&
      prior.content_before_hash.equals(draft.contentBeforeHash)
    ) {
      continue;
    }
    await tx.query(
      `INSERT INTO patches
         (workspace_id, project_id, finding_id, rule_code, target_url, kind, unified_diff, content_before_hash, content_after, jsonld_blocks,
          reversal, preconditions, explanation, derivation, requires_human_review, review_reason, risk_flags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17::jsonb)`,
      [
        payload.workspaceId, payload.projectId, row.id, draft.ruleCode, draft.targetUrl, draft.kind, draft.unifiedDiff, draft.contentBeforeHash,
        draft.contentAfter, draft.jsonldBlocks === null ? null : JSON.stringify(draft.jsonldBlocks), JSON.stringify(draft.reversal),
        JSON.stringify(draft.preconditions), draft.explanation, draft.derivation, draft.requiresHumanReview, draft.reviewReason, JSON.stringify(draft.riskFlags),
      ],
    );
    written += 1;
    incrementCounter("nominara_aux_patches_generated_total", { kind: draft.kind, rule_code: draft.ruleCode });
  }
  return { written, rejected };
}
