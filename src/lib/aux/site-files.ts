import type { SiteFileEvidence, SiteFileFinding } from "../../../contracts/aux/index.js";
import { SITE_FILE_EVIDENCE_SNIPPET_MAX } from "../../../contracts/aux/index.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { elementsOf, firstElement } from "./xml-scan.js";
import { blockingRule, parseRobots, rulesFor, type RobotsRule } from "../net/robots.js";

// NEW-C-8 (STORY-051 subset) — pure evaluators for the three site files:
// robots.txt (AUX-R-001, 002, 003), llms.txt (AUX-R-004) and the sitemap
// (AUX-R-007). aux-and-geo-analysis.md §2, `crawler_access`.
//
// PURE: the fetched bodies go in, findings come out. No network, no clock (the
// caller passes `now`), no database. Fetching is the crawl worker's job behind
// the queue boundary (KAD-06). AUX-R-005 (bot-hostile edge rules: not observable without impersonating a crawler) and AUX-R-006
// (noai directives) need live responses / page headers and are not here.
//
// Every number is the reference's, exactly; migration 0070 stores the same
// numbers in `aux_rule_catalog.thresholds` and an integration test pins them.

export const AI_CRAWLER_AGENTS = [
  "GPTBot",
  "ClaudeBot",
  "PerplexityBot",
  "Google-Extended",
  "Applebot-Extended",
  "Bytespider",
  "CCBot",
  "meta-externalagent",
] as const;

export const SITE_FILE_THRESHOLDS = Object.freeze({
  /** AUX-R-003: "> 500 KB". Read as 500 KiB (the limit crawlers document); a body of exactly this is fine. */
  robotsMaxBytes: 500 * 1024,
  /** AUX-R-007: `lastmod` older than 180 d... */
  sitemapStaleDays: 180,
  /** ...on > 50% of entries. */
  sitemapStaleRatio: 0.5,
});

/** A fetched file. `null` where a function takes `SiteFile | null` = no response at all. */
export interface SiteFile {
  readonly status: number;
  readonly body: string;
  /** Size on the wire when the fetcher truncated `body`; otherwise the body's UTF-8 length. */
  readonly byteLength?: number;
}

const DAY_MS = 86_400_000;
const isSuccess = (f: SiteFile | null): boolean => f !== null && f.status >= 200 && f.status < 300;
const clip = (s: string): string => s.slice(0, SITE_FILE_EVIDENCE_SNIPPET_MAX);

function finding(
  rule_code: SiteFileFinding["rule_code"],
  severity: SiteFileFinding["severity"],
  measured_value: number | null,
  threshold_value: number | null,
  evidence: Omit<SiteFileEvidence, "snippet" | "line" | "subjects"> &
    Partial<Pick<SiteFileEvidence, "snippet" | "line" | "subjects">>,
): SiteFileFinding {
  return {
    rule_code,
    severity,
    measured_value,
    threshold_value,
    evidence: {
      file: evidence.file,
      reason: evidence.reason,
      snippet: evidence.snippet === undefined || evidence.snippet === null ? null : clip(evidence.snippet),
      line: evidence.line ?? null,
      subjects: (evidence.subjects ?? []).map((s) => s.slice(0, 200)).slice(0, 50),
    },
  };
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

/**
 * AUX-R-001 / 002 / 003 over `/robots.txt`. `trackedPaths` are the paths of
 * the project's tracked prompt set: a Disallow that touches none of them is
 * not a finding. `file === null` = no response.
 */
export function evaluateRobotsTxt(file: SiteFile | null, trackedPaths: readonly string[]): SiteFileFinding[] {
  const max = SITE_FILE_THRESHOLDS.robotsMaxBytes;
  if (file === null) {
    return [finding("AUX-R-003", "high", null, null, { file: "robots.txt", reason: "unreachable" })];
  }
  if (file.status >= 400) {
    return [finding("AUX-R-003", "high", file.status, 400, { file: "robots.txt", reason: "http_status" })];
  }

  const parsed = parseRobots(file.body);
  const out: SiteFileFinding[] = [];

  // AUX-R-001 — named AI agents.
  const affected: string[] = [];
  let rootBlocked = false;
  let firstLine: RobotsRule | null = null;
  for (const agent of AI_CRAWLER_AGENTS) {
    const rules = rulesFor(parsed, agent);
    if (rules.length === 0) continue;
    const hits = trackedPaths.map((p) => blockingRule(rules, p)).filter((r): r is RobotsRule => r !== null);
    if (hits.length === 0) continue;
    affected.push(agent);
    const root = blockingRule(rules, "/");
    if (root !== null) {
      if (!rootBlocked) firstLine = root;
      rootBlocked = true;
    } else if (firstLine === null) {
      firstLine = hits[0]!;
    }
  }
  if (affected.length > 0 && firstLine !== null) {
    out.push(
      finding("AUX-R-001", rootBlocked ? "critical" : "high", affected.length, 1, {
        file: "robots.txt",
        reason: rootBlocked ? "root_disallow" : "path_disallow",
        snippet: firstLine.text,
        line: firstLine.line,
        subjects: affected,
      }),
    );
  }

  // AUX-R-002 — the wildcard group is the only thing standing between AI agents and a tracked path.
  const anyAiNamed = parsed.groups.some((g) => g.agents.some((a) => AI_CRAWLER_AGENTS.some((n) => n.toLowerCase() === a)));
  if (!anyAiNamed) {
    const star = rulesFor(parsed, "*");
    const hits = trackedPaths.map((p) => blockingRule(star, p)).filter((r): r is RobotsRule => r !== null);
    if (hits.length > 0) {
      out.push(
        finding("AUX-R-002", "medium", hits.length, 1, {
          file: "robots.txt",
          reason: "wildcard_restricts_ai",
          snippet: hits[0]!.text,
          line: hits[0]!.line,
          subjects: ["*"],
        }),
      );
    }
  }

  // AUX-R-003 — oversize or malformed (an HTTP failure returned above).
  const bytes = file.byteLength ?? Buffer.byteLength(file.body, "utf8");
  if (bytes > max) {
    out.push(finding("AUX-R-003", "high", bytes, max, { file: "robots.txt", reason: "oversize" }));
  } else if (parsed.unparseable.length > 0) {
    const first = parsed.unparseable[0]!;
    out.push(
      finding("AUX-R-003", "high", parsed.unparseable.length, 1, {
        file: "robots.txt",
        reason: "unparseable_directive",
        snippet: first.text,
        line: first.line,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// llms.txt
// ---------------------------------------------------------------------------

const MD_LINK = /\[[^\]]+\]\(https?:\/\/[^)\s]+\)/;

/**
 * AUX-R-004. `root` is `/llms.txt`, `wellKnown` is `/.well-known/llms.txt`;
 * the root file is judged when it exists, else the well-known one. The format
 * check is the llmstxt.org shape: a leading `# Title`, and every list item a
 * Markdown link to an http(s) URL.
 */
export function evaluateLlmsTxt(root: SiteFile | null, wellKnown: SiteFile | null): SiteFileFinding[] {
  const file = root !== null && isSuccess(root) ? root : wellKnown !== null && isSuccess(wellKnown) ? wellKnown : null;
  if (file === null) {
    const answered = root !== null || wellKnown !== null;
    return [finding("AUX-R-004", "low", answered ? 0 : null, answered ? 1 : null, { file: "llms.txt", reason: "absent" })];
  }
  const lines = file.body.split(/\r?\n/);
  const violations: { line: number; text: string | null }[] = [];
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx < 0 || !/^# +\S/.test(lines[firstIdx]!.trim())) {
    violations.push({ line: firstIdx < 0 ? 1 : firstIdx + 1, text: firstIdx < 0 ? null : lines[firstIdx]!.trim() });
  }
  lines.forEach((l, i) => {
    if (/^\s*[-*]\s+/.test(l) && !MD_LINK.test(l)) violations.push({ line: i + 1, text: l.trim() });
  });
  if (violations.length === 0) return [];
  const first = violations[0]!;
  return [
    finding("AUX-R-004", "medium", violations.length, 1, {
      file: "llms.txt",
      reason: "invalid",
      snippet: first.text,
      line: first.line,
    }),
  ];
}

// ---------------------------------------------------------------------------
// sitemap
// ---------------------------------------------------------------------------

/**
 * AUX-R-007. `declaredInRobots` = robots.txt names this URL in a `Sitemap:`
 * line. Entries are `<url>` (urlset) and `<sitemap>` (index) elements; an entry
 * with no, or an unparseable, `lastmod` counts toward the total but is not
 * known to be stale.
 */
export function evaluateSitemap(
  file: SiteFile | null,
  ctx: { readonly now: Date; readonly declaredInRobots: boolean },
): SiteFileFinding[] {
  if (file === null || !isSuccess(file)) {
    if (file !== null && file.status === 404 && ctx.declaredInRobots) {
      return [finding("AUX-R-007", "medium", 404, null, { file: "sitemap.xml", reason: "declared_sitemap_404" })];
    }
    return [finding("AUX-R-007", "medium", file === null ? null : file.status, null, { file: "sitemap.xml", reason: "absent" })];
  }
  const { sitemapStaleDays, sitemapStaleRatio } = SITE_FILE_THRESHOLDS;
  let total = 0;
  const stale: { loc: string; lastmod: string }[] = [];
  // `elementsOf`, not a regex: a file of unclosed tags is quadratic under a lazy quantifier (see xml-scan.ts).
  for (const block of [...elementsOf(file.body, "url"), ...elementsOf(file.body, "sitemap")]) {
    total += 1;
    const lastmod = firstElement(block, "lastmod")?.trim();
    if (lastmod === undefined || lastmod.includes("<")) continue; // a nested tag is not a date
    const t = Date.parse(lastmod);
    if (Number.isNaN(t)) continue;
    if (ctx.now.getTime() - t > sitemapStaleDays * DAY_MS) {
      stale.push({ loc: firstElement(block, "loc")?.trim() ?? "", lastmod });
    }
  }
  if (total === 0) return [];
  const ratio = stale.length / total;
  if (!(ratio > sitemapStaleRatio)) return [];
  return [
    finding("AUX-R-007", "medium", ratio, sitemapStaleRatio, {
      file: "sitemap.xml",
      reason: "stale_lastmod",
      snippet: `<lastmod>${stale[0]!.lastmod}</lastmod>`,
      subjects: stale.slice(0, 5).map((s) => s.loc),
    }),
  ];
}

// ---------------------------------------------------------------------------
// all three
// ---------------------------------------------------------------------------

export interface SiteFilesInput {
  readonly robots: SiteFile | null;
  readonly llmsTxt: SiteFile | null;
  readonly llmsTxtWellKnown: SiteFile | null;
  readonly sitemap: SiteFile | null;
  readonly sitemapDeclaredInRobots: boolean;
  readonly trackedPaths: readonly string[];
  readonly now: Date;
}

/** Runs the three evaluators and counts each finding (`nominara_aux_site_file_findings_total`). */
export function evaluateSiteFiles(input: SiteFilesInput): SiteFileFinding[] {
  const findings = [
    ...evaluateRobotsTxt(input.robots, input.trackedPaths),
    ...evaluateLlmsTxt(input.llmsTxt, input.llmsTxtWellKnown),
    ...evaluateSitemap(input.sitemap, { now: input.now, declaredInRobots: input.sitemapDeclaredInRobots }),
  ];
  for (const f of findings) {
    incrementCounter("nominara_aux_site_file_findings_total", { rule_code: f.rule_code, severity: f.severity });
  }
  return findings;
}
