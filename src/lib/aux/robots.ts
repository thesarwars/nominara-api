// STORY-049 — robots.txt parsing, shared by the site-file evaluators (`site-files.ts`, AUX-R-001/002/003) and the
// crawl's own politeness (`politeness.ts`, page selection): one parser, so what the audit REPORTS about a site's
// robots.txt and what the crawler OBEYS cannot disagree. Extracted verbatim from `site-files.ts`, plus `Crawl-delay`,
// `Sitemap:` and the RFC 9309 group choice for a single agent.

export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
  readonly line: number;
  readonly text: string;
}
export interface RobotsGroup {
  readonly agents: string[];
  readonly rules: RobotsRule[];
  /** Seconds, from this group's first usable `Crawl-delay`; null when none (null is not 0). */
  crawlDelay: number | null;
}
export interface ParsedRobots {
  readonly groups: RobotsGroup[];
  readonly unparseable: { line: number; text: string }[];
  /** Every `Sitemap:` value, in file order. Not group-scoped (RFC 9309 §2.3). */
  readonly sitemaps: string[];
}

const FIELD = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** A non-negative decimal. `Number("")` is 0 and `Number("-3")` is -3, so the shape is checked BEFORE the conversion. */
const CRAWL_DELAY_VALUE = /^\d+(\.\d+)?$/;

export function parseRobots(body: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const unparseable: { line: number; text: string }[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let collectingAgents = false;
  body.split(/\r?\n/).forEach((raw, i) => {
    const text = raw.replace(/#.*$/, "").trim();
    if (text === "") return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? "" : text.slice(0, colon).trim();
    if (colon < 0 || !FIELD.test(field)) {
      unparseable.push({ line: i + 1, text: raw.trim() });
      return;
    }
    const value = text.slice(colon + 1).trim();
    const name = field.toLowerCase();
    if (name === "user-agent") {
      if (!collectingAgents || current === null) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
      return;
    }
    collectingAgents = false;
    if (name === "sitemap") {
      sitemaps.push(value);
      return;
    }
    if (name === "crawl-delay" && current !== null && current.crawlDelay === null && CRAWL_DELAY_VALUE.test(value)) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) current.crawlDelay = seconds;
      return;
    }
    if ((name === "allow" || name === "disallow") && current !== null) {
      current.rules.push({ allow: name === "allow", pattern: value, line: i + 1, text: raw.trim() });
    }
  });
  return { groups, unparseable, sitemaps };
}

function patternRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const core = anchored ? pattern.slice(0, -1) : pattern;
  const source = core.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`);
}

/** The rule that decides `path` for the merged rules of an agent, or `null` when none matches. Longest pattern wins; a tie goes to Allow. */
function decidingRule(rules: readonly RobotsRule[], path: string): RobotsRule | null {
  const target = path.startsWith("/") ? path : `/${path}`;
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (rule.pattern === "") continue;
    if (!patternRegex(rule.pattern).test(target)) continue;
    if (best === null || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)) {
      best = rule;
    }
  }
  return best;
}

export const blockingRule = (rules: readonly RobotsRule[], path: string): RobotsRule | null => {
  const r = decidingRule(rules, path);
  return r !== null && !r.allow ? r : null;
};

export function rulesFor(parsed: ParsedRobots, agent: string): RobotsRule[] {
  const key = agent.toLowerCase();
  return parsed.groups.filter((g) => g.agents.includes(key)).flatMap((g) => g.rules);
}


/** The agent the crawl identifies as (aux-and-geo-analysis.md §1: UA `NominaraBot/1.0`). The robots product token is the part before the slash. */
export const CRAWL_AGENT = "NominaraBot";

/**
 * The rules and delay that bind `agent`: the group(s) that NAME it, else the `*` group. Never both merged (RFC 9309 §2.2.1):
 * a site that wrote a group for us has told us something specific, and a wildcard must neither loosen nor tighten it.
 */
function groupsFor(parsed: ParsedRobots, agent: string): RobotsGroup[] {
  const key = agent.toLowerCase();
  const named = parsed.groups.filter((g) => g.agents.includes(key));
  return named.length > 0 ? named : parsed.groups.filter((g) => g.agents.includes("*"));
}

/** May `agent` fetch `path`? No rule for it, an empty Disallow, or a longest-match Allow all mean yes. */
export function isAllowed(parsed: ParsedRobots, agent: string, path: string): boolean {
  return blockingRule(groupsFor(parsed, agent).flatMap((g) => g.rules), path) === null;
}

/** The declared `Crawl-delay` in seconds for `agent`, or null when none is declared. A declared 0 is 0. */
export function crawlDelayFor(parsed: ParsedRobots, agent: string): number | null {
  for (const group of groupsFor(parsed, agent)) if (group.crawlDelay !== null) return group.crawlDelay;
  return null;
}

/**
 * The `Sitemap:` URLs, absolute http(s) only. A relative value, another scheme or `javascript:` is dropped here rather
 * than handed to the fetcher: the guard would refuse most of them, but a value that is not a sitemap URL should not
 * reach it at all.
 */
export function sitemapUrlsOf(parsed: ParsedRobots): string[] {
  const out: string[] = [];
  for (const value of parsed.sitemaps) {
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") out.push(value);
    } catch {
      // not a URL: dropped
    }
  }
  return out;
}
