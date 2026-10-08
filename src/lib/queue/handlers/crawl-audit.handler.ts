import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { Job } from "bullmq";
import { crawlAuditJobPayloadSchema, siteFileFindingSchema, type SiteFileFinding } from "../../../../contracts/aux/index.js";
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
import { evaluateSiteFiles, type SiteFile } from "../../aux/site-files.js";
import { guardedFetch, type GuardedResponse } from "../../net/guarded-fetch.js";
import { auxScore, type AuxCountedFinding } from "../../scoring/aux.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// NEW-C-9 — `crawl.audit`, the SITE-FILE stage only (STORY-049 step 2) plus
// the finding lifecycle (STORY-052, aux-and-geo-analysis.md §3).
//
// Runs inside withTenantJob: `tx` is already in the job's tenant context, so
// there is no workspace_id predicate in any query below — RLS is the filter.
// (The one workspace_id that appears is the VALUE on an INSERT, from the
// signature-verified payload.)
//
// What this stage does NOT do, and says so in `excluded_rules`: it crawls no
// page and sends no differential probe (AUX-R-005), so the 27 rules outside
// `crawler_access`, plus AUX-R-005 and AUX-R-006, did not run. The score is
// therefore NOT published: one category is not an AUX score. `aux_score` stays
// null; the `crawler_access` subscore is published in `score_breakdown`, and
// `score_capped` is set whenever a critical crawler_access finding is open.

export const RULE_VERSION = "2026.10.1";
export const FETCH_TIMEOUT_MS = 10_000;
/** aux-and-geo-analysis.md §1: a 500 ms minimum interval between requests to one host. */
export const POLITENESS_INTERVAL_MS = 500;
const TOKENIZER = "none"; // aux_audits.tokenizer is NOT NULL; no text is tokenised in this stage.
const RAN_RULES = ["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-004", "AUX-R-007"] as const;
const OPEN_STATUSES = ["open", "acknowledged", "in_progress", "regressed"];

export interface CrawlAuditDeps {
  /** The SSRF-guarded fetcher by default; injectable so tests touch no network. */
  readonly fetch?: (url: string) => Promise<GuardedResponse>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
}

type Fetched = { readonly responded: true; readonly status: number; readonly file: SiteFile } | { readonly responded: false };

/** All 34 rule codes, from the reference (§2). */
const ALL_RULE_CODES: readonly string[] = Array.from({ length: 34 }, (_, i) => `AUX-R-${String(i + 1).padStart(3, "0")}`);
export const EXCLUDED_RULES: readonly string[] = [...ALL_RULE_CODES.filter((c) => !(RAN_RULES as readonly string[]).includes(c)), "page_crawl"];

export function createCrawlAuditHandler(_context: QueueHandlerContext, deps: CrawlAuditDeps = {}): JobProcessor {
  const logger = new Logger("crawl.audit");
  const fetchOne = deps.fetch ?? ((url: string) => guardedFetch(url));
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;

  async function fetchBounded(url: string): Promise<Fetched> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("crawl.audit: fetch timeout")), timeoutMs);
      });
      const res = await Promise.race([fetchOne(url), timeout]);
      return { responded: true, status: res.status, file: { status: res.status, body: res.body.toString("utf8"), byteLength: res.body.length } };
    } catch {
      // A refusal, a DNS failure, a timeout: OUR fetch failed. That is not
      // evidence about the site, so it is recorded as a failure and never as
      // a finding or a resolution.
      return { responded: false };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return async (tx: ClientBase, job: Job): Promise<void> => {
    const payload = crawlAuditJobPayloadSchema.parse((job.data as { payload: unknown }).payload);

    const project = await tx.query<{ root_domain: string }>(
      "SELECT root_domain FROM projects WHERE id = $1 AND deleted_at IS NULL",
      [payload.projectId],
    );
    if (project.rows.length === 0) {
      logger.log(`project ${payload.projectId} is gone; skipping audit`);
      return;
    }
    const origin = `https://${project.rows[0]!.root_domain}`;
    const urls = {
      robots: new URL("/robots.txt", origin).href,
      llms: new URL("/llms.txt", origin).href,
      llmsWellKnown: new URL("/.well-known/llms.txt", origin).href,
      sitemap: new URL("/sitemap.xml", origin).href,
    };

    // The catalog is versioned data: assert its weights on every load (NFR-AUX-03).
    const catalogRows = await tx.query<{ code: string; category: string; title: string; weight: number; rule_version: string; thresholds: Record<string, unknown> }>(
      "SELECT code, category, title, weight, rule_version, thresholds FROM aux_rule_catalog WHERE category = 'crawler_access'",
    );
    const catalog: AuxCatalog = loadAuxCatalog(
      catalogRows.rows.map((r) => ({ code: r.code, category: r.category, weight: r.weight, ruleVersion: r.rule_version, thresholds: r.thresholds })),
    );
    const titles = new Map(catalogRows.rows.map((r) => [r.code, r.title]));

    // Idempotent under at-least-once delivery: the audit id is the producer's.
    const startedAt = now();
    const inserted = await tx.query(
      `INSERT INTO aux_audits (id, workspace_id, project_id, trigger, scope, target_urls, excluded_rules, rule_version, tokenizer, status, started_at)
       VALUES ($1, $2, $3, $4, 'domain_root', $5, $6, $7, $8, 'running', $9)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [payload.auditId, payload.workspaceId, payload.projectId, payload.trigger, Object.values(urls), EXCLUDED_RULES, RULE_VERSION, TOKENIZER, startedAt],
    );
    if (inserted.rows.length === 0) {
      const prior = await tx.query<{ status: string }>("SELECT status FROM aux_audits WHERE id = $1", [payload.auditId]);
      if (prior.rows.length === 0 || ["completed", "partial", "failed"].includes(prior.rows[0]!.status)) {
        logger.log(`audit ${payload.auditId} already ran; skipping redelivery`);
        return;
      }
      await tx.query("UPDATE aux_audits SET status = 'running', started_at = $2, excluded_rules = $3 WHERE id = $1", [payload.auditId, startedAt, EXCLUDED_RULES]);
    }

    // Sequential, with the politeness interval between requests to the one host.
    const robots = await fetchBounded(urls.robots);
    await sleep(POLITENESS_INTERVAL_MS);
    const llms = await fetchBounded(urls.llms);
    await sleep(POLITENESS_INTERVAL_MS);
    const llmsWellKnown = await fetchBounded(urls.llmsWellKnown);
    await sleep(POLITENESS_INTERVAL_MS);
    const sitemap = await fetchBounded(urls.sitemap);

    const all = [robots, llms, llmsWellKnown, sitemap];
    const failed = all.filter((f) => !f.responded).length;
    const finishedAt = now();

    if (failed === all.length) {
      await tx.query(
        "UPDATE aux_audits SET status = 'failed', pages_failed = $2, error_summary = $3::jsonb, finished_at = $4 WHERE id = $1",
        [payload.auditId, failed, JSON.stringify({ reason: "all_site_files_unreachable" }), finishedAt],
      );
      incrementCounter("nominara_aux_audits_total", { status: "failed", trigger: payload.trigger });
      logger.log(`audit ${payload.auditId} (project ${payload.projectId}): no site file reachable`);
      return;
    }

    const asFile = (f: Fetched): SiteFile | null => (f.responded ? f.file : null);
    const robotsBody = robots.responded && robots.status >= 200 && robots.status < 300 ? robots.file.body : "";
    const sitemapDeclaredInRobots = /^\s*sitemap\s*:\s*\S*\/sitemap\.xml\s*$/im.test(robotsBody);

    const evaluated = evaluateSiteFiles({
      robots: asFile(robots),
      llmsTxt: asFile(llms),
      llmsTxtWellKnown: asFile(llmsWellKnown),
      sitemap: asFile(sitemap),
      sitemapDeclaredInRobots,
      // No page crawl: the one path every audit can speak for is the root.
      trackedPaths: ["/"],
      now: finishedAt,
    });

    // A rule is "covered" only when its input file got an HTTP answer. A
    // finding from a file we failed to fetch is not evidence, and a missing
    // finding from one is not a resolution.
    const covered = new Set<string>();
    if (robots.responded) ["AUX-R-001", "AUX-R-002", "AUX-R-003"].forEach((c) => covered.add(c));
    if (llms.responded && llmsWellKnown.responded) covered.add("AUX-R-004");
    if (sitemap.responded) covered.add("AUX-R-007");

    const urlFor = (f: SiteFileFinding): string => (f.evidence.file === "robots.txt" ? urls.robots : f.evidence.file === "llms.txt" ? urls.llms : urls.sitemap);
    const persisted = evaluated
      .map((f) => siteFileFindingSchema.parse(f))
      .filter((f) => covered.has(f.rule_code))
      .map((f) => ({ f, url: urlFor(f) }));
    const detected: (DetectedFinding & { readonly source: SiteFileFinding })[] = persisted.map(({ f, url }) => ({
      fingerprint: findingFingerprint(f.rule_code, url, f.evidence),
      ruleCode: f.rule_code,
      url,
      severity: f.severity,
      source: f,
    }));

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

    const llmsPresent = [llms, llmsWellKnown].some((f) => f.responded && f.status >= 200 && f.status < 300)
      ? true
      : llms.responded && llmsWellKnown.responded
        ? false
        : null;
    const sitemapCount = sitemap.responded && sitemap.status >= 200 && sitemap.status < 300 ? (sitemap.file.body.match(/<(url|sitemap)\b/g) ?? []).length : null;
    const status = failed > 0 ? "partial" : "completed";

    await tx.query(
      `UPDATE aux_audits
          SET status = $2, pages_failed = $3, robots_snapshot = $4, robots_hash = $5, llms_txt_present = $6, sitemap_url_count = $7,
              aux_score = NULL, score_capped = $8, score_breakdown = $9::jsonb,
              findings_critical = $10, findings_high = $11, findings_medium = $12, findings_low = $13, finished_at = $14
        WHERE id = $1`,
      [
        payload.auditId, status, failed,
        robotsBody === "" && !(robots.responded && robots.status >= 200 && robots.status < 300) ? null : robotsBody,
        robots.responded && robots.status >= 200 && robots.status < 300 ? createHash("sha256").update(robots.file.body).digest() : null,
        llmsPresent, sitemapCount, capped, JSON.stringify({ crawler_access: subscore }),
        counts.critical, counts.high, counts.medium, counts.low, finishedAt,
      ],
    );

    incrementCounter("nominara_aux_audits_total", { status, trigger: payload.trigger });
    logger.log(
      `audit ${payload.auditId} (project ${payload.projectId}): ${status}, ${String(detected.length)} detected, ` +
        `${String(actions.filter((a) => a.kind === "resolve").length)} resolved, ${String(actions.filter((a) => a.kind === "regress").length)} regressed, ${String(failed)} fetch(es) failed`,
    );
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
