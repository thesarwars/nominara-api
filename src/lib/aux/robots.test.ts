import { describe, expect, it } from "vitest";
import { crawlDelayFor, isAllowed, parseRobots, sitemapUrlsOf } from "./robots.js";

// STORY-049 AC7 — "honours Crawl-delay, respects the target's own robots.txt for the NominaraBot user agent"
// (aux-and-geo-analysis.md §1, Politeness). The group choice is RFC 9309's: a group that NAMES the agent wins outright
// and `*` is the fallback only when no group names it. Merging the two would let a permissive `*` override a site's
// explicit instruction to us, or a restrictive `*` bind an agent the site had separately allowed.

const BODY = [
  "User-agent: *",
  "Disallow: /private",
  "Crawl-delay: 5",
  "",
  "User-agent: NominaraBot",
  "Allow: /private/public",
  "Disallow: /admin",
  "Crawl-delay: 2.5",
  "",
  "Sitemap: https://acme.com/sitemap.xml",
  "sitemap: https://acme.com/news-sitemap.xml",
].join("\n");

describe("STORY-049 AC7 · robots.txt for the NominaraBot agent", () => {
  const parsed = parseRobots(BODY);

  it("honours the declared Crawl-delay of the group that names NominaraBot, in seconds, fractions kept", () => {
    expect(crawlDelayFor(parsed, "NominaraBot")).toBe(2.5);
  });

  it("falls back to the * group's Crawl-delay only when no group names the agent", () => {
    expect(crawlDelayFor(parseRobots("User-agent: *\nCrawl-delay: 5\n"), "NominaraBot")).toBe(5);
    // a named group WITHOUT a delay does not inherit the wildcard's: the site spoke to us directly
    expect(crawlDelayFor(parseRobots("User-agent: *\nCrawl-delay: 5\n\nUser-agent: NominaraBot\nAllow: /\n"), "NominaraBot")).toBeNull();
  });

  it("null (no delay declared) is not 0 (declared zero)", () => {
    expect(crawlDelayFor(parseRobots("User-agent: *\nDisallow:\n"), "NominaraBot")).toBeNull();
    expect(crawlDelayFor(parseRobots("User-agent: *\nCrawl-delay: 0\n"), "NominaraBot")).toBe(0);
  });

  it.each(["abc", "-3", "", "NaN", "Infinity", "1e999"])("ignores an unusable Crawl-delay value (%j) rather than guessing", (value) => {
    expect(crawlDelayFor(parseRobots(`User-agent: *\nCrawl-delay: ${value}\n`), "NominaraBot")).toBeNull();
  });

  it("the agent name matches case-insensitively and by exact product token", () => {
    expect(crawlDelayFor(parseRobots("User-agent: nominarabot\nCrawl-delay: 7\n"), "NominaraBot")).toBe(7);
    expect(crawlDelayFor(parseRobots("User-agent: NominaraBot-Images\nCrawl-delay: 7\n"), "NominaraBot")).toBeNull();
  });

  it("applies the NominaraBot group, not the * group, when both exist", () => {
    expect(isAllowed(parsed, "NominaraBot", "/admin/x")).toBe(false);
    expect(isAllowed(parsed, "NominaraBot", "/private")).toBe(true); // * disallows it, the named group does not mention it
    expect(isAllowed(parsed, "NominaraBot", "/private/public")).toBe(true);
  });

  it("applies the * group when no group names the agent", () => {
    const wildcard = parseRobots("User-agent: *\nDisallow: /private\n");
    expect(isAllowed(wildcard, "NominaraBot", "/private/x")).toBe(false);
    expect(isAllowed(wildcard, "NominaraBot", "/public")).toBe(true);
  });

  it("allows everything when robots.txt has no rule for the agent, or is empty", () => {
    expect(isAllowed(parseRobots(""), "NominaraBot", "/anything")).toBe(true);
    expect(isAllowed(parseRobots("User-agent: GPTBot\nDisallow: /\n"), "NominaraBot", "/")).toBe(true);
  });

  it("an empty Disallow allows all; the longest match wins and a tie goes to Allow", () => {
    expect(isAllowed(parseRobots("User-agent: *\nDisallow:\n"), "NominaraBot", "/x")).toBe(true);
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/b\n"), "NominaraBot", "/a/b/c")).toBe(true);
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /a\nAllow: /a\n"), "NominaraBot", "/a")).toBe(true);
  });

  it("collects every Sitemap line, case-insensitively, wherever it sits", () => {
    expect(sitemapUrlsOf(parsed)).toEqual(["https://acme.com/sitemap.xml", "https://acme.com/news-sitemap.xml"]);
  });

  it("a Sitemap line that is not an absolute http(s) URL is dropped, not fetched", () => {
    const odd = parseRobots("Sitemap: /relative.xml\nSitemap: ftp://acme.com/s.xml\nSitemap: javascript:alert(1)\nSitemap: https://acme.com/ok.xml\n");
    expect(sitemapUrlsOf(odd)).toEqual(["https://acme.com/ok.xml"]);
  });
});

// Review round 2 — a hostile robots.txt must not be able to freeze a worker. The matcher used to compile each
// pattern into a backtracking regex, so `/*a*a*a*a*a*a*a*a*a*a*b` against a long run of `a` took exponential time on a
// SYNCHRONOUS call (no timer, budget or lock renewal can interrupt it). Both inputs belong to the target site: the file
// and, through sitemap <loc> entries and redirect Locations, the path.
describe("STORY-049 · robots.txt matching is linear-time on hostile input", () => {
  const timed = <T>(fn: () => T): { value: T; ms: number } => {
    const start = performance.now();
    const value = fn();
    return { value, ms: performance.now() - start };
  };
  const PATHOLOGICAL = `/${"*a".repeat(12)}*b`;
  const LONG_PATH = `/${"a".repeat(2048)}`;

  it("a pathological wildcard pattern against a 2048-character path finishes in quickly (bounded matching) and does not match", () => {
    const parsed = parseRobots(`User-agent: *\nDisallow: ${PATHOLOGICAL}\n`);
    const { value, ms } = timed(() => isAllowed(parsed, "NominaraBot", LONG_PATH));
    expect(value).toBe(true); // no `b` anywhere: the rule does not match
    expect(ms).toBeLessThan(5000);
  });

  it("thousands of pathological rules against a long path stay bounded", () => {
    const rules = Array.from({ length: 3000 }, () => `Disallow: ${PATHOLOGICAL}`).join("\n");
    const parsed = parseRobots(`User-agent: *\n${rules}\n`);
    const { ms } = timed(() => isAllowed(parsed, "NominaraBot", LONG_PATH));
    expect(ms).toBeLessThan(5000);
  });

  it("a multi-megabyte path (a hostile sitemap <loc> or redirect Location) is bounded too", () => {
    const parsed = parseRobots(`User-agent: *\nDisallow: ${PATHOLOGICAL}\n`);
    const { ms } = timed(() => isAllowed(parsed, "NominaraBot", `/${"a".repeat(2_000_000)}`));
    expect(ms).toBeLessThan(100);
  });

  it("an over-long pattern is bounded as well", () => {
    const parsed = parseRobots(`User-agent: *\nDisallow: /${"*a".repeat(200_000)}b\n`);
    const { ms } = timed(() => isAllowed(parsed, "NominaraBot", LONG_PATH));
    expect(ms).toBeLessThan(100);
  });

  // The behaviour the regex gave must survive the rewrite.
  it.each([
    ["/a*c", "/abc", false],
    ["/a*c", "/ac", false],
    ["/a*c", "/ab", true],
    ["/*.pdf$", "/x/y.pdf", false],
    ["/*.pdf$", "/x/y.pdf?x=1", true],
    ["/*.pdf", "/x/y.pdf?x=1", false],
    ["/private$", "/private", false],
    ["/private$", "/private/x", true],
    ["/a*b*c", "/a-b-c-d", false],
    ["/a*b*c", "/a-c-b", true],
    ["/a**b", "/ab", false],
    ["/*", "/anything", false],
    ["/*$", "/anything", false],
    ["/a.b", "/axb", true],
    ["/a+b", "/a+b", false],
    ["/a*", "/a", false],
  ] as const)("Disallow %s against %s: allowed=%s", (pattern, path, allowed) => {
    expect(isAllowed(parseRobots(`User-agent: *\nDisallow: ${pattern}\n`), "NominaraBot", path)).toBe(allowed);
  });
});

