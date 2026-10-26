import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { GuardedFetchRefusal, type GuardedResponse } from "../net/guarded-fetch.js";
import { normalize } from "../parser/normalize.js";
import { matchEntities, type AliasEntry } from "../parser/entity-matcher.js";
import { refreshProjectSourceIndex } from "../rollup/refresh-project-source-index.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { DEMO_SEED_MARKER } from "../../db/seed/demo/constants.js";
import { nameUuid } from "../ids/name-uuid.js";
import { withProjectQueueLock } from "../queue/locks.js";

// NEW-C-15 / STORY-054 AC4 + AC11 (scenarios 5, 6, 7) — brand presence on a cited
// domain is VERIFIED BY FETCHING the cited URL and matching it against the
// brand's alias automaton (scoring-models.md §5: "verified by fetching and
// matching, cached 30 days"). It is never assumed from the domain alone.
//
// Three rules carry the whole story:
//
//   1. THE FETCH GOES THROUGH THE GUARDED FETCHER. The cited URL is a third
//      party's, chosen by an answer engine; fetching it unguarded is a free SSRF
//      primitive. `fetch` is injected so the caller passes `guardedFetch` and a
//      test passes a fake — this file never opens a socket itself.
//   2. A FAILED FETCH STAYS NULL. A 404, a timeout, a refusal or a PDF says
//      nothing about the brand. Writing `false` would turn an outage into an
//      accusation ("you are absent on this domain") — the exact failure the
//      story exists to prevent. A failure writes nothing, and an earlier
//      verified value survives it.
//   3. ONLY A REAL CITATION VERIFIES. A demo `.example` domain is never fetched,
//      and a domain is a candidate only through an engine that has a real
//      adapter (today: gemini). Demo engines cite invented domains; verifying
//      them would stamp fabricated data with a real `verified_at`. A capture the
//      demo seed marked (`normalizer_version = 'demo-seed'`) never counts, whatever
//      engine key it carries.

const logger = new Logger("verify-presence");

export const PRESENCE_CACHE_DAYS = 30;
const PRESENCE_CACHE_MS = PRESENCE_CACHE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Engines whose citations are real (they have a real adapter). Every other
 * engine is fixture-backed demo data. Add an engine here in the same change
 * that binds its real adapter (registry.ts `captureReady`).
 */
export const LIVE_CITATION_ENGINES: readonly string[] = ["gemini"];

/** One run fetches at most this many domains, highest influence first — a handler holds its transaction while it fetches, so the run is bounded. The rest wait for the next run. */
export const MAX_DOMAINS_PER_RUN = 25;

/** RFC 2606 reserved top-level names (plus `localhost`): nothing real lives there. */
const RESERVED_TLDS: ReadonlySet<string> = new Set(["example", "test", "invalid", "localhost"]);
/** RFC 2606 reserved second-level names, and every subdomain of them. */
const RESERVED_SECOND_LEVEL: ReadonlySet<string> = new Set(["example.com", "example.net", "example.org"]);

/**
 * A demo domain: an RFC 2606 reserved name, never a real citation. The demo seed
 * writes `<name>.example.com` and `*.example` domains, so both are matched, along
 * with `example.net`/`example.org`, their subdomains, and the reserved TLDs
 * (`.example`, `.test`, `.invalid`, `.localhost`). Never verified.
 */
export function isDemoDomain(domain: string): boolean {
  const labels = domain.trim().toLowerCase().replace(/\.$/u, "").split(".");
  const tld = labels[labels.length - 1] ?? "";
  if (RESERVED_TLDS.has(tld)) return true;
  return RESERVED_SECOND_LEVEL.has(labels.slice(-2).join("."));
}

export interface PresenceCandidate {
  readonly sourceDomainId: string;
  readonly domain: string;
  /** The most-cited URL on the domain, or null when none is recorded. */
  readonly topUrl: string | null;
  /** Latest `verified_at` for the domain on this project, or null if never verified. */
  readonly verifiedAt: Date | null;
}

export interface PresenceSkips {
  demo: number;
  cached: number;
  no_url: number;
}

/** Decides which candidates need a fetch now. Pure: the clock is an argument. */
export function selectPresenceChecks(
  candidates: readonly PresenceCandidate[],
  now: Date,
): { check: PresenceCandidate[]; skipped: PresenceSkips } {
  const check: PresenceCandidate[] = [];
  const skipped: PresenceSkips = { demo: 0, cached: 0, no_url: 0 };
  for (const candidate of candidates) {
    if (isDemoDomain(candidate.domain)) {
      skipped.demo += 1;
    } else if (candidate.verifiedAt !== null && now.getTime() - candidate.verifiedAt.getTime() < PRESENCE_CACHE_MS) {
      skipped.cached += 1;
    } else if (candidate.topUrl === null || candidate.topUrl.length === 0) {
      skipped.no_url += 1;
    } else {
      check.push(candidate);
    }
  }
  return { check, skipped };
}

export interface BrandForMatching {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly negativeAliases: readonly string[];
}

export type PresenceFailure = "http_status" | "fetch_error" | "refused" | "not_text" | "no_aliases";
export type PresenceOutcome = { readonly status: "present" } | { readonly status: "absent" } | { readonly status: "failed"; readonly reason: PresenceFailure };

export type PresenceFetcher = (url: string) => Promise<GuardedResponse>;

/** Visible text of an HTML page: scripts, styles, comments and tags (and so link targets) removed. */
export function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function isTextual(response: GuardedResponse): boolean {
  const raw = response.headers["content-type"];
  const type = (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase();
  if (type === undefined || type.length === 0) return true; // no header: try it as text
  return type.startsWith("text/") || type.includes("xml") || type.includes("json");
}

/**
 * Fetches `url` (via the injected guarded fetcher) and reports whether the brand
 * is on the page. Never throws: every failure is a `failed` outcome, which the
 * caller must leave NULL.
 */
export async function verifyUrlPresence(url: string, brand: BrandForMatching, fetch: PresenceFetcher): Promise<PresenceOutcome> {
  const labels = [brand.name, ...brand.aliases].map((value) => value.trim()).filter((value) => value.length > 0);
  const unique = [...new Set(labels)];
  if (unique.length === 0) return { status: "failed", reason: "no_aliases" };

  let response: GuardedResponse;
  try {
    response = await fetch(url);
  } catch (error) {
    return { status: "failed", reason: error instanceof GuardedFetchRefusal ? "refused" : "fetch_error" };
  }
  if (response.status < 200 || response.status >= 300) return { status: "failed", reason: "http_status" };
  if (!isTextual(response)) return { status: "failed", reason: "not_text" };

  const aliases: AliasEntry[] = unique.map((alias) => ({ entityType: "brand", entityId: null, label: brand.name, alias }));
  const text = normalize(visibleText(response.body.toString("utf8")));
  const mentions = matchEntities({ text, aliases, negativeAliases: brand.negativeAliases }).filter(
    (mention) => mention.entityType === "brand" && !mention.inLink,
  );
  return { status: mentions.length > 0 ? "present" : "absent" };
}

export interface PresenceRunDeps {
  readonly fetch: PresenceFetcher;
  readonly now?: Date;
  /** `YYYY-MM-DD`, the workspace-local day the index is recomputed as of. Defaults to the database's current date. */
  readonly today?: string;
}

export interface PresenceRunSummary {
  checked: number;
  present: number;
  absent: number;
  failed: number;
  skipped: PresenceSkips;
}

interface CandidateRow {
  source_domain_id: string;
  domain: string;
  top_url: string | null;
  verified_at: Date | null;
  context_weight: number;
}

/**
 * STORY-066 review round 2 — LOST UPDATE. `refreshProjectSourceIndex` reads the presence it carries over, then DELETEs and
 * re-inserts the project's whole index; `rollup.metric_daily` runs it under ITS per-project advisory lock. A presence write outside
 * that lock can UPDATE rows a concurrent rollup has already deleted (0 rows once the rollup commits) and then carry the rollup's
 * stale value across in its own refresh — the verification is lost and, for a seeded task, the pin commits while the gap stays
 * open. So every presence commit takes the ROLLUP'S lock, and takes it FIRST: the rollup holds that lock before it updates the
 * `projects` row (denormalisation) and a task row lock is never held by it, so lock-then-rows here is the same order and the two
 * cannot deadlock. Transaction-scoped: released at COMMIT/ROLLBACK.
 */
const PRESENCE_WRITE_LOCK = "rollup.metric_daily";

// ADR-0003 — THE RUN IS THREE PHASES, so the `source.verify_presence` job holds no transaction (and no pooled connection) across
// a fetch: `preparePresenceRun` reads in one short transaction, `fetchPresence` fetches with no client at all, and
// `commitPresenceRun` writes in a second short one. `verifyProjectSourcePresence` composes the three on ONE client, which is the
// shape for a test or a tool and must not be a production path.

/** What `preparePresenceRun` read: everything `fetchPresence` and `commitPresenceRun` need, and nothing else. */
export interface PresenceRunPlan {
  readonly workspaceId: string;
  readonly brand: BrandForMatching;
  readonly check: readonly PresenceCandidate[];
  readonly skipped: PresenceSkips;
}

export interface PresenceResult {
  readonly candidate: PresenceCandidate;
  readonly outcome: PresenceOutcome;
}

/**
 * The one demo exclusion both candidate picks share (the periodic run's and the completion's): the index row `psi` on domain `sd`
 * counts only through a live engine's citation that is not demo-marked. The seed marks its captures
 * (`answer_captures.normalizer_version`) and writes them under live engines' keys too. `engines` and `marker` are the statement's
 * placeholders for the live engine keys and `DEMO_SEED_MARKER`.
 */
function liveCitationExists(engines: string, marker: string): string {
  return `EXISTS (
          SELECT 1 FROM citation_facts cf
           WHERE cf.project_id = psi.project_id AND cf.domain = sd.domain AND cf.engine_key = ANY(${engines}::text[])
             AND NOT EXISTS (SELECT 1 FROM answer_captures ac WHERE ac.id = cf.result_id AND ac.normalizer_version = ${marker}))`;
}

/**
 * Phase 1 (one short tenant transaction): the project's brand and the domains due a fetch. Null when the project is not visible
 * (gone, or in another tenant) — nothing is fetched then.
 */
export async function preparePresenceRun(tx: ClientBase, projectId: string, now: Date): Promise<PresenceRunPlan | null> {
  const project = await tx.query<{ workspace_id: string; name: string; brand_aliases: string[]; negative_aliases: string[] }>(
    `SELECT workspace_id, name, brand_aliases, negative_aliases FROM projects WHERE id = $1 AND deleted_at IS NULL`,
    [projectId],
  );
  const row = project.rows[0];
  if (row === undefined) return null;
  const brand: BrandForMatching = { name: row.name, aliases: row.brand_aliases, negativeAliases: row.negative_aliases };

  // One candidate per domain: its most-cited URL as seen by a LIVE engine, and
  // the freshest verification across all the domain's index rows.
  const candidates = await tx.query<CandidateRow>(
    `SELECT DISTINCT ON (psi.source_domain_id)
            psi.source_domain_id, sd.domain, psi.top_urls->0->>'url' AS top_url, psi.context_weight,
            (SELECT max(v.verified_at) FROM project_source_index v
              WHERE v.project_id = psi.project_id AND v.source_domain_id = psi.source_domain_id
                AND v.brand_present_on_domain IS NOT NULL) AS verified_at
       FROM project_source_index psi JOIN source_domains sd ON sd.id = psi.source_domain_id
      WHERE psi.project_id = $1 AND psi.engine_key = ANY($2::text[])
        AND ${liveCitationExists("$2", "$3")}
      ORDER BY psi.source_domain_id, psi.window_days DESC, psi.citation_count DESC`,
    [projectId, [...LIVE_CITATION_ENGINES], DEMO_SEED_MARKER],
  );
  const byInfluence = [...candidates.rows].sort((a, b) => b.context_weight - a.context_weight || a.domain.localeCompare(b.domain));
  const { check, skipped } = selectPresenceChecks(
    byInfluence.map((c) => ({ sourceDomainId: c.source_domain_id, domain: c.domain, topUrl: c.top_url, verifiedAt: c.verified_at })),
    now,
  );
  return { workspaceId: row.workspace_id, brand, check: check.slice(0, MAX_DOMAINS_PER_RUN), skipped };
}

/** Phase 2 (NO transaction, no client): fetch each due domain's most-cited URL through the injected guarded fetcher. */
export async function fetchPresence(plan: PresenceRunPlan, fetch: PresenceFetcher): Promise<PresenceResult[]> {
  const results: PresenceResult[] = [];
  for (const candidate of plan.check) {
    results.push({ candidate, outcome: await verifyUrlPresence(candidate.topUrl!, plan.brand, fetch) });
  }
  return results;
}

/**
 * Phase 3 (a second short tenant transaction): writes `brand_present_on_domain` + `verified_at` on every index row of a verified
 * domain, then recomputes the index so `gap_severity` and `source_coverage` follow from the now-known presence through the one
 * code path that computes them (the recompute carries verified presence across). Writes nothing for a project deleted while the
 * fetches ran (returns null). A redelivery that raced this one writes the same values again, which is harmless.
 *
 * It pins NO milestone: `source_seeded` is the completion's (`verifySeededTask`), because this run fetches the domain's
 * most-cited page, not the page the task's work was done on.
 */
export async function commitPresenceRun(
  tx: ClientBase,
  projectId: string,
  plan: PresenceRunPlan,
  results: readonly PresenceResult[],
  now: Date,
  today?: string,
): Promise<PresenceRunSummary | null> {
  return withProjectQueueLock(tx, PRESENCE_WRITE_LOCK, projectId, () => commitPresenceRunLocked(tx, projectId, plan, results, now, today));
}


async function commitPresenceRunLocked(
  tx: ClientBase,
  projectId: string,
  plan: PresenceRunPlan,
  results: readonly PresenceResult[],
  now: Date,
  today?: string,
): Promise<PresenceRunSummary | null> {
  const live = await tx.query(`SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE`, [projectId]);
  if (live.rows.length === 0) return null;

  const summary: PresenceRunSummary = { checked: 0, present: 0, absent: 0, failed: 0, skipped: plan.skipped };
  let wrote = false;
  for (const { candidate, outcome } of results) {
    summary.checked += 1;
    if (outcome.status === "failed") {
      summary.failed += 1;
      incrementCounter("nominara_sources_presence_checks_total", { outcome: "failed", reason: outcome.reason });
      continue; // stays null (or keeps its earlier verified value)
    }
    await tx.query(
      `UPDATE project_source_index SET brand_present_on_domain = $3, verified_at = $4 WHERE project_id = $1 AND source_domain_id = $2`,
      [projectId, candidate.sourceDomainId, outcome.status === "present", now],
    );
    wrote = true;
    if (outcome.status === "present") summary.present += 1;
    else summary.absent += 1;
    incrementCounter("nominara_sources_presence_checks_total", { outcome: outcome.status });
  }
  for (const [reason, count] of Object.entries(plan.skipped)) {
    for (let i = 0; i < count; i++) incrementCounter("nominara_sources_presence_checks_total", { outcome: `skipped_${reason}` });
  }

  if (wrote) await refreshProjectSourceIndex(tx, projectId, today);

  // IDs and counts only — never a brand name, a URL or page text.
  logger.log({
    event: "source_presence_verified",
    workspaceId: plan.workspaceId,
    projectId,
    checked: summary.checked,
    present: summary.present,
    absent: summary.absent,
    failed: summary.failed,
    skipped: plan.skipped,
  });
  return summary;
}

/**
 * Verifies brand presence for one project's cited domains — the three phases composed on the caller's ONE transaction. For tests
 * and tools only: the `source.verify_presence` job runs the phases in two transactions with the fetches between them (ADR-0003).
 * Returns null when the project is not visible (gone, or in another tenant) — nothing is fetched then.
 */
export async function verifyProjectSourcePresence(tx: ClientBase, projectId: string, deps: PresenceRunDeps): Promise<PresenceRunSummary | null> {
  const now = deps.now ?? new Date();
  const plan = await preparePresenceRun(tx, projectId, now);
  if (plan === null) return null;
  const results = await fetchPresence(plan, deps.fetch);
  return commitPresenceRun(tx, projectId, plan, results, now, deps.today);
}

// ───────────────────────── STORY-066 AC8 — `source_seeded`, at the completion of an authority task ─────────────────────────
//
// `scoring-models.md` §13: `source_seeded` fires on "completion of an authority task with a verified target URL";
// `aux-and-geo-analysis.md` ("Verification closes the loop"): worker-crawl fetches the URL, confirms a brand mention, and records
// the milestone. So the TRIGGER IS THE COMPLETION: `TasksService.completeTask` enqueues this verification after its commit, the
// job fetches THE TASK'S target URL (`tasks.affected_url`, the page the playbook pointed the work at), and the pin is dated at
// `completed_at` — the date STORY-067's T±14 d impact window is computed around. The 30-day presence cache does not apply: the
// cache exists because the domain was recently verified ABSENT, which is exactly why the task exists.
//
// ⚠ Reference gap, recorded rather than invented: the reference says completing an authority task "requires a URL" (the
// contribution the user made). `POST /tasks/{id}/complete` takes no body today, so the task's own target URL is the URL verified.
// Accepting a contribution URL is a contract change the owner has not decided (plans-7day followups, STORY-066 round 2).
//
// THE URL, recorded choice (review round 2, option a): the task's `affected_url` when it is a page on the task's domain — a
// displacement-recovery task carries the cited page — and otherwise the domain's MOST-CITED page in the project's index (by a live
// engine, as the periodic run picks it). The source-gap rule, the ordinary producer of authority tasks, writes `affected_url`
// NULL (its playbook has no page), so without the fallback AC8 never fired for it. The fallback is still fetched PAST the cache
// and pinned at completion: the completion is the trigger, and the most-cited page is where the engines look.

/** The task's target, when it is an http(s) page on the task's own domain (or a subdomain of it); otherwise null. */
export function seededTargetUrl(affectedUrl: string | null, domain: string): string | null {
  if (affectedUrl === null || affectedUrl.length === 0) return null;
  let url: URL;
  try {
    url = new URL(affectedUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  const target = domain.trim().toLowerCase().replace(/\.$/u, "");
  return host === target || host.endsWith(`.${target}`) ? affectedUrl : null;
}

/**
 * The page a completed authority task is verified against: its own on-domain target, else the index's most-cited page on the
 * domain, else nothing (nothing is fetched and nothing pins).
 */
export function seededVerificationUrl(affectedUrl: string | null, indexTopUrl: string | null, domain: string): string | null {
  return seededTargetUrl(affectedUrl, domain) ?? seededTargetUrl(indexTopUrl, domain);
}

/** The stable source id of one task's `source_seeded` pin: one pin per task, for ever. */
export function sourceSeededSourceId(projectId: string, taskId: string): string {
  return nameUuid("source_seeded", projectId, taskId);
}

export interface SeededVerificationPlan {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sourceDomainId: string;
  readonly domain: string;
  readonly url: string;
  readonly completedAt: Date;
  readonly today: string;
  readonly brand: BrandForMatching;
}

/**
 * Phase 1: the completed authority task and what verifying it needs. Null — nothing to fetch — when the task is not a completed,
 * live authority task of this (visible) project, has no target on its domain, is on a demo domain, or is already pinned (a
 * redelivery).
 */
export async function prepareSeededVerification(tx: ClientBase, projectId: string, taskId: string): Promise<SeededVerificationPlan | null> {
  const found = await tx.query<{
    task_id: string;
    source_domain_id: string;
    domain: string;
    affected_url: string | null;
    index_top_url: string | null;
    completed_at: Date;
    workspace_id: string;
    name: string;
    brand_aliases: string[];
    negative_aliases: string[];
    pinned: boolean;
    today: string;
  }>(
    `SELECT t.id::text AS task_id, t.source_domain_id::text AS source_domain_id, sd.domain, t.affected_url, t.completed_at,
            -- The domain's most-cited page by a live engine: the same pick as the periodic run's candidate, through the same
            -- demo exclusion (review round 3), so a domain indexed only from demo-seeded captures offers no URL to fetch.
            (SELECT psi.top_urls->0->>'url' FROM project_source_index psi
              WHERE psi.project_id = t.project_id AND psi.source_domain_id = t.source_domain_id AND psi.engine_key = ANY($4::text[])
                AND ${liveCitationExists("$4", "$5")}
              ORDER BY psi.window_days DESC, psi.citation_count DESC LIMIT 1) AS index_top_url,
            p.workspace_id::text AS workspace_id, p.name, p.brand_aliases, p.negative_aliases,
            EXISTS (SELECT 1 FROM milestones m WHERE m.source_type = 'system' AND m.source_id = $3) AS pinned,
            to_char((now() AT TIME ZONE w.timezone)::date, 'YYYY-MM-DD') AS today
       FROM tasks t
       JOIN projects p       ON p.id = t.project_id AND p.deleted_at IS NULL
       JOIN workspaces w     ON w.id = p.workspace_id
       JOIN source_domains sd ON sd.id = t.source_domain_id
      WHERE t.id = $2 AND t.project_id = $1
        AND t.kind = 'authority' AND t.status = 'done' AND t.deleted_at IS NULL AND t.completed_at IS NOT NULL`,
    [projectId, taskId, sourceSeededSourceId(projectId, taskId), [...LIVE_CITATION_ENGINES], DEMO_SEED_MARKER],
  );
  const row = found.rows[0];
  if (row === undefined || row.pinned || isDemoDomain(row.domain)) return null;
  const url = seededVerificationUrl(row.affected_url, row.index_top_url, row.domain);
  if (url === null) return null;
  return {
    workspaceId: row.workspace_id,
    projectId,
    taskId: row.task_id,
    sourceDomainId: row.source_domain_id,
    domain: row.domain,
    url,
    completedAt: row.completed_at,
    today: row.today,
    brand: { name: row.name, aliases: row.brand_aliases, negativeAliases: row.negative_aliases },
  };
}

/**
 * Phase 2 (NO transaction): fetch the target. A fetch that ERRORS throws, so the queue retries it — an outage is neither a pin nor
 * a final "no". Any other outcome (present, absent, a refusal, a 404, a non-text page) is final.
 */
export async function fetchSeededTarget(plan: SeededVerificationPlan, fetch: PresenceFetcher): Promise<PresenceOutcome> {
  const outcome = await verifyUrlPresence(plan.url, plan.brand, fetch);
  if (outcome.status === "failed" && outcome.reason === "fetch_error") {
    incrementCounter("nominara_sources_seeded_checks_total", { outcome: "retry" });
    throw new SeededFetchError();
  }
  return outcome;
}

/** A transient fetch failure of a seeded verification; the job fails so the queue retries it. Carries no URL. */
export class SeededFetchError extends Error {
  constructor() {
    super("the seeded target could not be fetched; the job will be retried");
    this.name = "SeededFetchError";
  }
}

/**
 * Phase 3 (a second short transaction): when the target carries the brand, record the domain as present (the gap closes at the
 * recompute) and pin `source_seeded` AT THE COMPLETION. Re-checks — under a row lock — that the task is still done, so a task
 * deleted while the fetch ran pins nothing. Idempotent: the pin's source id is the task's, so a racing delivery hits
 * `ux_milestones_source` and pins nothing more. Titled by the DOMAIN, never the task: a task born of a displacement names a
 * competitor in its title, and the portal's competitor exclusion recognises that only on a `task`-sourced pin.
 */
export async function commitSeededVerification(tx: ClientBase, plan: SeededVerificationPlan, outcome: PresenceOutcome, now: Date): Promise<boolean> {
  incrementCounter("nominara_sources_seeded_checks_total", { outcome: outcome.status === "failed" ? `failed_${outcome.reason}` : outcome.status });
  if (outcome.status !== "present") {
    logger.log({ event: "source_seeded_not_verified", workspaceId: plan.workspaceId, projectId: plan.projectId, taskId: plan.taskId, outcome: outcome.status });
    return false;
  }
  // The rollup's lock FIRST, before the task row lock (see PRESENCE_WRITE_LOCK): the presence written below must not be lost to a
  // concurrent rollup's index rebuild.
  return withProjectQueueLock(tx, PRESENCE_WRITE_LOCK, plan.projectId, () => commitSeededPresent(tx, plan, now));
}

async function commitSeededPresent(tx: ClientBase, plan: SeededVerificationPlan, now: Date): Promise<boolean> {
  const still = await tx.query(
    `SELECT id FROM tasks
      WHERE id = $1 AND project_id = $2 AND status = 'done' AND deleted_at IS NULL
      FOR NO KEY UPDATE`,
    [plan.taskId, plan.projectId],
  );
  if (still.rows.length === 0) return false;

  await tx.query(
    `UPDATE project_source_index SET brand_present_on_domain = true, verified_at = $3 WHERE project_id = $1 AND source_domain_id = $2`,
    [plan.projectId, plan.sourceDomainId, now],
  );
  const pinned = await tx.query(
    `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, severity, source_type, source_id, visible_in_portal)
     VALUES ($1, $2, $3, 'source_seeded', $4, 'positive', 'system', $5, true)
     ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
    [plan.workspaceId, plan.projectId, plan.completedAt, `Source seeded: ${plan.domain}`, sourceSeededSourceId(plan.projectId, plan.taskId)],
  );
  await refreshProjectSourceIndex(tx, plan.projectId, plan.today);
  // IDs only — never the URL, the domain or page text.
  logger.log({ event: "source_seeded_pinned", workspaceId: plan.workspaceId, projectId: plan.projectId, taskId: plan.taskId, pinned: (pinned.rowCount ?? 0) > 0 });
  return (pinned.rowCount ?? 0) > 0;
}
