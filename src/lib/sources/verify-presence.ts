import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { GuardedFetchRefusal, type GuardedResponse } from "../net/guarded-fetch.js";
import { normalize } from "../parser/normalize.js";
import { matchEntities, type AliasEntry } from "../parser/entity-matcher.js";
import { refreshProjectSourceIndex } from "../rollup/refresh-project-source-index.js";
import { incrementCounter } from "../telemetry/metrics.js";

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
//      them would stamp fabricated data with a real `verified_at`.

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

/** A demo domain: the reserved `.example` TLD (RFC 2606), as the demo seed uses. Never verified. */
export function isDemoDomain(domain: string): boolean {
  const host = domain.trim().toLowerCase().replace(/\.$/u, "");
  return host === "example" || host.endsWith(".example");
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
 * Verifies brand presence for one project's cited domains, inside the caller's
 * tenant transaction. Returns null when the project is not visible (gone, or in
 * another tenant) — nothing is fetched then.
 *
 * Writes `brand_present_on_domain` + `verified_at` on every index row of a
 * verified domain, then recomputes the index so `gap_severity` and
 * `source_coverage` follow from the now-known presence through the one code
 * path that computes them (the recompute carries verified presence across).
 */
export async function verifyProjectSourcePresence(tx: ClientBase, projectId: string, deps: PresenceRunDeps): Promise<PresenceRunSummary | null> {
  const now = deps.now ?? new Date();
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
      ORDER BY psi.source_domain_id, psi.window_days DESC, psi.citation_count DESC`,
    [projectId, [...LIVE_CITATION_ENGINES]],
  );
  const byInfluence = [...candidates.rows].sort((a, b) => b.context_weight - a.context_weight || a.domain.localeCompare(b.domain));
  const { check, skipped } = selectPresenceChecks(
    byInfluence.map((c) => ({ sourceDomainId: c.source_domain_id, domain: c.domain, topUrl: c.top_url, verifiedAt: c.verified_at })),
    now,
  );

  const summary: PresenceRunSummary = { checked: 0, present: 0, absent: 0, failed: 0, skipped };
  let wrote = false;
  for (const candidate of check.slice(0, MAX_DOMAINS_PER_RUN)) {
    summary.checked += 1;
    const outcome = await verifyUrlPresence(candidate.topUrl!, brand, deps.fetch);
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
  for (const [reason, count] of Object.entries(skipped)) {
    for (let i = 0; i < count; i++) incrementCounter("nominara_sources_presence_checks_total", { outcome: `skipped_${reason}` });
  }

  if (wrote) await refreshProjectSourceIndex(tx, projectId, deps.today);

  // IDs and counts only — never a brand name, a URL or page text.
  logger.log({
    event: "source_presence_verified",
    workspaceId: row.workspace_id,
    projectId,
    checked: summary.checked,
    present: summary.present,
    absent: summary.absent,
    failed: summary.failed,
    skipped,
  });
  return summary;
}
