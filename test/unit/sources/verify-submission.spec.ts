import { describe, expect, it, vi } from "vitest";
import { GuardedFetchRefusal, type GuardedResponse } from "../../../src/lib/net/guarded-fetch.js";
import { decodeLoosely, fetchSubmission, urlEchoesBrand, type SubmissionPlan } from "../../../src/lib/sources/verify-submission.js";

// STORY-055 AC6 + AC11 (scenarios 6 and 7) - the fetch phase of a submitted URL: no database, a fake guarded fetcher, and the
// mapping from what the fetch found to the SPECIFIC reason the customer sees. A reason is never generic.

const URL_OK = "https://reviews.dev/threads/best-tools";
const plan = (over: Partial<SubmissionPlan> = {}): SubmissionPlan => ({
  workspaceId: "w", projectId: "p", taskId: "t", submissionId: "s", url: URL_OK, submittedBy: null, title: "Contribute", sourceDomainId: "d",
  domain: "reviews.dev", today: "2026-10-07", brand: { name: "Acme Analytics", aliases: ["Acme"], negativeAliases: [] }, ...over,
});
const res = (text: string, over: Partial<GuardedResponse> = {}): GuardedResponse => ({
  status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(`<html><body><p>${text}</p></body></html>`), finalUrl: URL_OK, ...over,
});

describe("STORY-055 · fetchSubmission", () => {
  it("a page that names the brand, on the task's domain, is verified", async () => {
    const fetch = vi.fn().mockResolvedValue(res("Acme Analytics is great"));
    await expect(fetchSubmission(plan(), fetch)).resolves.toEqual({ status: "verified" });
    expect(fetch).toHaveBeenCalledWith(URL_OK, expect.objectContaining({ followRedirect: expect.any(Function) }));
  });

  it("scenario 6 - a page that resolves but names no brand is no_mention", async () => {
    await expect(fetchSubmission(plan(), vi.fn().mockResolvedValue(res("Globex only")))).resolves.toEqual({ status: "unverified", reason: "no_mention" });
  });

  it("the brand in a link target or script only is no mention (visible text only)", async () => {
    const body = Buffer.from('<html><script>var a="Acme Analytics"</script><a href="https://acme.com/Acme">here</a></html>');
    await expect(fetchSubmission(plan(), vi.fn().mockResolvedValue(res("", { body })))).resolves.toEqual({ status: "unverified", reason: "no_mention" });
  });

  it.each([
    ["a connection error", () => Promise.reject(new Error("ECONNRESET")), "unreachable"],
    ["a 404", () => Promise.resolve(res("Not found", { status: 404 })), "unreachable"],
    ["a 500", () => Promise.resolve(res("boom", { status: 500 })), "unreachable"],
    ["a PDF", () => Promise.resolve(res("%PDF", { headers: { "content-type": "application/pdf" } })), "not_a_page"],
    ["a refusal by the guard", () => Promise.reject(new GuardedFetchRefusal("address_not_global")), "unsafe_target"],
    ["a redirect-hop refusal to a private address", () => Promise.reject(new GuardedFetchRefusal("redirect_target_refused")), "unsafe_target"],
    ["a refused port", () => Promise.reject(new GuardedFetchRefusal("port_not_allowed")), "unsafe_target"],
    ["a refused scheme", () => Promise.reject(new GuardedFetchRefusal("scheme_not_allowed")), "unsafe_target"],
    // Review r3 M1: a name that does not resolve, or a resolver that is down, is about the NETWORK, not about the customer's URL.
    ["a name that does not exist (NXDOMAIN)", () => Promise.reject(new GuardedFetchRefusal("dns_resolution_failed", "ENOTFOUND")), "unreachable"],
    ["a resolver that is down (EAI_AGAIN)", () => Promise.reject(new GuardedFetchRefusal("dns_resolution_failed", "EAI_AGAIN")), "unreachable"],
    ["a resolver failure (ESERVFAIL)", () => Promise.reject(new GuardedFetchRefusal("dns_resolution_failed", "ESERVFAIL")), "unreachable"],
    ["a resolver failure with no errno", () => Promise.reject(new GuardedFetchRefusal("dns_resolution_failed", "UNKNOWN")), "unreachable"],
    ["a redirect hop whose name does not resolve", () => Promise.reject(new GuardedFetchRefusal("redirect_target_refused", "ENOTFOUND")), "unreachable"],
    ["too many redirects", () => Promise.reject(new GuardedFetchRefusal("too_many_redirects")), "unreachable"],
  ])("scenario 7 - %s gives %s", async (_name, fetch, reason) => {
    await expect(fetchSubmission(plan(), vi.fn().mockImplementation(fetch))).resolves.toEqual({ status: "unverified", reason });
  });

  it("a project with no brand names cannot be matched: no_brand_names, and nothing is fetched", async () => {
    const fetch = vi.fn();
    await expect(fetchSubmission(plan({ brand: { name: " ", aliases: [], negativeAliases: [] } }), fetch)).resolves.toEqual({ status: "unverified", reason: "no_brand_names" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a URL on another site is wrong_domain and is never fetched; so are a look-alike suffix and a lookalike prefix", async () => {
    for (const url of ["https://elsewhere.org/acme", "https://notreviews.dev/acme", "https://reviews.dev.evil.org/acme"]) {
      const fetch = vi.fn().mockResolvedValue(res("Acme Analytics"));
      await expect(fetchSubmission(plan({ url }), fetch), url).resolves.toEqual({ status: "unverified", reason: "wrong_domain" });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("a subdomain of the task's domain is on the domain", async () => {
    const url = "https://old.reviews.dev/t/1";
    await expect(fetchSubmission(plan({ url }), vi.fn().mockResolvedValue(res("Acme Analytics", { finalUrl: url })))).resolves.toEqual({ status: "verified" });
  });

  it("a redirect that lands off the domain is wrong_domain even though the page names the brand", async () => {
    await expect(fetchSubmission(plan(), vi.fn().mockResolvedValue(res("Acme Analytics", { finalUrl: "https://evil.org/landing" })))).resolves.toEqual({
      status: "unverified",
      reason: "wrong_domain",
    });
  });

  it("review r3 - a redirect off the domain whose page does NOT name the brand is wrong_domain, not no_mention", async () => {
    await expect(fetchSubmission(plan(), vi.fn().mockResolvedValue(res("Globex only", { finalUrl: "https://evil.org/landing" })))).resolves.toEqual({
      status: "unverified",
      reason: "wrong_domain",
    });
  });

  it("review r3 - a task with no source domain FAILS CLOSED in the job too (the request already refuses it): nothing is fetched", async () => {
    const fetch = vi.fn().mockResolvedValue(res("Acme Analytics", { finalUrl: "https://anywhere.org/p" }));
    await expect(fetchSubmission(plan({ domain: null, sourceDomainId: null, url: "https://anywhere.org/p" }), fetch)).resolves.toEqual({ status: "unverified", reason: "wrong_domain" });
    expect(fetch).not.toHaveBeenCalled();
  });

  // ---- review r4 (dangerous-area audit) --------------------------------------------------------------------------------------
  // The customer chooses the URL. A site search, a tag page and a soft-404 ECHO it, so a brand in the URL would "appear" on a page
  // that never mentioned it. Fails closed, before any fetch.
  const WIKI = (url: string, over: Partial<SubmissionPlan> = {}) => plan({ url, domain: "wikipedia.org", ...over });
  const echoPage = (u: string): GuardedResponse => {
    const q = decodeLoosely(new URL(u).search + new URL(u).pathname);
    // a wiki shows a title for a slug with its underscores as spaces
    return res(`Search results for ${q.replace(/_/gu, " ")}. There were no results matching the query ${q.replace(/_/gu, " ")}.`, { finalUrl: u });
  };

  // Round 5 (owner decision 46): a brand in the URL is no longer refused outright - the job fetches a CANARY (the same URL with the
  // brand token replaced by a random nonce) and refuses only when the site echoes the nonce or serves the same page for it.
  it.each([
    ["a site search (the auditor's probe)", "https://en.wikipedia.org/w/index.php?search=Acme+Analytics&fulltext=1"],
    ["a search with a percent-encoded query", "https://en.wikipedia.org/w/index.php?search=acme%20analytics"],
    ["a double-encoded query", "https://en.wikipedia.org/w/index.php?search=%2541cme+Analytics"],
    ["a tag page", "https://en.wikipedia.org/wiki/Tag/acme-analytics"],
    ["a soft-404 that echoes the path", "https://en.wikipedia.org/wiki/Acme_Analytics_does_not_exist"],
    ["an alias in the query key", "https://en.wikipedia.org/w/index.php?Acme=1"],
  ])("review r4/r5 - %s is url_echoes_brand: the canary comes back echoing the nonce", async (_name, url) => {
    const fetch = vi.fn().mockImplementation(async (u: string) => echoPage(u));
    await expect(fetchSubmission(WIKI(url), fetch)).resolves.toEqual({ status: "unverified", reason: "url_echoes_brand" });
    expect(fetch).toHaveBeenCalledTimes(2); // the page, then its canary
    expect(fetch.mock.calls[1]![0]).not.toBe(url);
  });

  it("review r5 - the fragment is never sent to the server, so a text fragment naming the brand is not an echo: one fetch, no canary", async () => {
    const url = "https://en.wikipedia.org/wiki/Foo#:~:text=Acme%20Analytics";
    const fetch = vi.fn().mockResolvedValue(res("Acme Analytics is mentioned here.", { finalUrl: url }));
    await expect(fetchSubmission(WIKI(url), fetch)).resolves.toEqual({ status: "verified" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(urlEchoesBrand(url, { name: "Acme Analytics", aliases: ["Acme"], negativeAliases: [] })).toBe(false);
  });

  it("review r4 - a real article that names the brand in its TEXT, at a URL that does not, still verifies", async () => {
    const url = "https://en.wikipedia.org/wiki/Product_analytics";
    const fetch = vi.fn().mockResolvedValue(res("Tools such as Acme Analytics are widely used.", { finalUrl: url }));
    await expect(fetchSubmission(WIKI(url), fetch)).resolves.toEqual({ status: "verified" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("review r4 - a redirect that lands on a search URL echoing the brand is url_echoes_brand even though the page names it", async () => {
    const url = "https://en.wikipedia.org/wiki/Special:Go";
    const landed = "https://en.wikipedia.org/w/index.php?search=Acme+Analytics";
    // decision 49: the canary is the same (empty) template once the brand is gone, and does not name the brand: a disguised reflection
    // A realistic search template: the canary's body drops the brand and differs from the original only by a counter, so the refusal
    // is reached through same_page on real text, not through two empty word lists.
    const SEARCH_TEXT = (term: string, hits: number) =>
      `Search results. You searched for ${term}. Showing ${hits} results. Use the main navigation to browse categories, read the latest articles, ` +
      "or check the help pages for tips on how to refine your search and find what you are looking for. Results are ordered by relevance and then by the date " +
      "of the most recent edit, and every entry links to the full article, its revision history, its talk page, and the list of other pages that point to it. " +
      "Contributors may also filter by namespace, language, license or length, and may download the whole result set in a machine readable format for offline study.";
    const fetch = vi.fn().mockImplementation(async (u: string) =>
      u === url ? res(`${SEARCH_TEXT("Acme Analytics", 12)}`, { finalUrl: landed }) : res(SEARCH_TEXT("", 3), { finalUrl: u }),
    );
    await expect(fetchSubmission(WIKI(url), fetch)).resolves.toEqual({ status: "unverified", reason: "url_echoes_brand" });
  });

  it("review r4 - urlEchoesBrand reads path, query and fragment, not the host, and a URL without the brand is clean", () => {
    const brand = { name: "Acme Analytics", aliases: ["Acme"], negativeAliases: [] };
    expect(urlEchoesBrand("https://acme.substack.com/p/our-launch", brand)).toBe(false);
    expect(urlEchoesBrand("https://reddit.com/r/saas/comments/abc/best_tools/", brand)).toBe(false);
    expect(urlEchoesBrand("https://reddit.com/r/saas/comments/abc/acme_vs_globex/", brand)).toBe(true);
    expect(urlEchoesBrand("not a url", brand)).toBe(false);
    expect(urlEchoesBrand("https://x.dev/%E0%A4%A", brand)).toBe(false); // a malformed escape never throws
  });

  it("review r4 - no hop is followed off the task's domain: followRedirect is false off it and true on it, and an off-domain redirect is wrong_domain", async () => {
    const asked: Record<string, boolean> = {};
    const fetch = vi.fn().mockImplementation(async (u: string, init?: { followRedirect?: (n: string) => boolean }) => {
      asked["https://evil.org/landing"] = init!.followRedirect!("https://evil.org/landing");
      asked["https://reviews.dev/moved"] = init!.followRedirect!("https://reviews.dev/moved");
      asked["https://sub.reviews.dev/moved"] = init!.followRedirect!("https://sub.reviews.dev/moved");
      asked["https://reviews.dev.evil.org/x"] = init!.followRedirect!("https://reviews.dev.evil.org/x");
      return res("", { status: 301, finalUrl: u, headers: { location: "https://evil.org/landing" } });
    });
    await expect(fetchSubmission(plan(), fetch)).resolves.toEqual({ status: "unverified", reason: "wrong_domain" });
    expect(asked).toEqual({
      "https://evil.org/landing": false,
      "https://reviews.dev/moved": true,
      "https://sub.reviews.dev/moved": true,
      "https://reviews.dev.evil.org/x": false,
    });
  });

  // ---- review r5 (danger audit of r4) --------------------------------------------------------------------------------------
  describe("review r5 - lenient decoding: one bad escape no longer leaves the whole segment raw", () => {
    const brand = { name: "Acme Analytics", aliases: ["Acme"], negativeAliases: [] };

    it.each([
      ["a valid escape beside an invalid UTF-8 byte", "https://x.dev/search/%41cme%C0/"],
      ["a valid escape beside a malformed one", "https://x.dev/search/Acm%65%ZZ"],
      ["triple encoding", "https://x.dev/search/%252541cme"],
      ["quadruple encoding (the fourth pass)", "https://x.dev/search/%25252541cme"],
      ["the %uXXXX form in a query value", "https://x.dev/s?q=%u0041cme"],
      ["the %uXXXX form in a query key", "https://x.dev/s?%u0041cme=1"],
      ["a truncated multi-byte escape before the name", "https://x.dev/search/%E0%A4%A/Acme"],
      ["an encoded space between the words", "https://x.dev/s?q=Acme%20Analytics%ZZ"],
    ])("urlEchoesBrand sees the brand through %s", (_name, url) => {
      expect(urlEchoesBrand(url, brand)).toBe(true);
    });

    it("urlEchoesBrand: a URL without the brand stays clean however it is escaped", () => {
      expect(urlEchoesBrand("https://x.dev/search/%41cm%ZZ/", brand)).toBe(false);
      expect(urlEchoesBrand("https://x.dev/search/%252541cm", brand)).toBe(false);
      expect(urlEchoesBrand("https://x.dev/s?q=%u0041cm", brand)).toBe(false);
    });

    it.each([
      ["a bad escape stays in place, the good one beside it decodes", "%41%ZZ", "A%ZZ"],
      ["a lone invalid byte becomes the replacement character", "a%C0b", "a\uFFFDb"],
      ["a run of escapes decodes as UTF-8", "%C3%A9t%C3%A9", "\u00e9t\u00e9"],
      ["a truncated sequence is replaced, not thrown", "%E0%A4%A", "\uFFFD%A"],
      ["%uXXXX decodes", "%u0041%u00e9", "A\u00e9"],
      ["a malformed %u stays", "%u00G1", "%u00G1"],
      ["repeated until stable: triple encoding", "%252541", "A"],
      ["at most four passes", "%2525252541", "%41"],
      ["a lone percent stays", "100%", "100%"],
      ["an unencoded string is unchanged", "plain-text", "plain-text"],
    ])("decodeLoosely: %s", (_name, input, expected) => {
      expect(decodeLoosely(input)).toBe(expected);
    });
  });

  describe("review r5 (owner decision 46) - the canary", () => {
    // Deterministic nonces, all letters, distinct per occurrence.
    const nonces = () => {
      let i = 0;
      return () => `zqxjvkwp${String.fromCharCode(97 + i++)}`;
    };
    const PAGE_TEXT =
      "Acme Analytics is a product analytics platform. Teams use it to track funnels, retention and revenue across web and mobile apps. " +
      "Reviewers praise the dashboards and the SQL access, and some mention pricing. See the full list of integrations below.";
    const notFound = (u: string): GuardedResponse => res("Page not found", { status: 404, finalUrl: u });
    // the nonce's first letter may be percent-encoded (to mirror an encoded original), so match its tail
    const isCanary = (u: string) => u.includes("qxjvkwp");
    const G2 = (over: Partial<SubmissionPlan> = {}) => plan({ url: "https://www.g2.com/products/acme-analytics/reviews", domain: "g2.com", ...over });

    it("g2.com/products/acme-analytics/reviews: the canary is a 404, so the original is verified - and the canary is the same URL with the slug replaced", async () => {
      const fetch = vi.fn().mockImplementation(async (u: string) => (isCanary(u) ? notFound(u) : res(PAGE_TEXT, { finalUrl: u })));
      await expect(fetchSubmission(G2(), fetch, { nonce: nonces() })).resolves.toEqual({ status: "verified" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]![0]).toBe("https://www.g2.com/products/acme-analytics/reviews");
      expect(fetch.mock.calls[1]![0]).toBe("https://www.g2.com/products/zqxjvkwpa/reviews");
      // the canary goes through the SAME guarded fetcher with the same redirect rule
      expect(fetch.mock.calls[1]![1]).toEqual(expect.objectContaining({ followRedirect: expect.any(Function) }));
      expect(fetch.mock.calls[1]![1].followRedirect("https://evil.org/x")).toBe(false);
      expect(fetch.mock.calls[1]![1].followRedirect("https://www.g2.com/x")).toBe(true);
    });

    it("a 410 canary is also 'the site does not serve any slug': verified", async () => {
      const fetch = vi.fn().mockImplementation(async (u: string) => (isCanary(u) ? res("gone", { status: 410, finalUrl: u }) : res(PAGE_TEXT, { finalUrl: u })));
      await expect(fetchSubmission(G2(), fetch, { nonce: nonces() })).resolves.toEqual({ status: "verified" });
    });

    it("a page that does not name the brand is still no_mention when the canary is a 404", async () => {
      const fetch = vi.fn().mockImplementation(async (u: string) => (isCanary(u) ? notFound(u) : res("Globex only", { finalUrl: u })));
      await expect(fetchSubmission(G2(), fetch, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "no_mention" });
    });

    it("a reflecting search page (the nonce is echoed) is url_echoes_brand", async () => {
      const url = "https://www.g2.com/search?query=Acme+Analytics";
      const fetch = vi.fn().mockImplementation(async (u: string) => res(`You searched for ${decodeLoosely(new URL(u).search)}. Acme Analytics may be listed.`, { finalUrl: u }));
      await expect(fetchSubmission(G2({ url }), fetch, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "url_echoes_brand" });
      expect(fetch.mock.calls[1]![0]).toBe("https://www.g2.com/search?query=zqxjvkwpa");
    });

    it("a soft-404 template page that echoes the path is url_echoes_brand", async () => {
      const url = "https://www.g2.com/categories/acme-analytics-alternatives";
      const fetch = vi.fn().mockImplementation(async (u: string) => res(`Sorry, ${new URL(u).pathname} does not exist. Acme Analytics fans may try the home page.`, { finalUrl: u }));
      await expect(fetchSubmission(G2({ url }), fetch, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "url_echoes_brand" });
    });

    // Owner decision 49: the same template is a refusal only when the canary no longer names the brand (a disguised reflection).
    const NO_BRAND = PAGE_TEXT.replace("Acme Analytics", "This product");

    it("a same-template 200 that no longer names the brand (a disguised reflection) is url_echoes_brand", async () => {
      const fetch = vi.fn().mockImplementation(async (u: string) => res(isCanary(u) ? NO_BRAND : PAGE_TEXT, { finalUrl: u }));
      await expect(fetchSubmission(G2(), fetch, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "url_echoes_brand" });
    });

    it("the same template with a few words changed (a counter, a date), still without the brand, is still the same page", async () => {
      const fetch = vi.fn().mockImplementation(async (u: string) => res(isCanary(u) ? `${NO_BRAND} Updated today.` : PAGE_TEXT, { finalUrl: u }));
      await expect(fetchSubmission(G2(), fetch, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "url_echoes_brand" });
    });

    it("decision 49 - a canary that still names the brand: the brand came from the content, verified", async () => {
      const fetch = vi.fn().mockImplementation(async (u: string) => res(PAGE_TEXT, { finalUrl: u }));
      await expect(fetchSubmission(G2(), fetch, { nonce: nonces() })).resolves.toEqual({ status: "verified" });
    });

    it("decision 49 - a canary redirected back to the canonical page (final URL = the page's) is verified even without the brand", async () => {
      const fetch = vi.fn().mockImplementation(async (u: string) => (isCanary(u) ? res(NO_BRAND, { finalUrl: "https://www.g2.com/products/acme-analytics/reviews" }) : res(PAGE_TEXT, { finalUrl: u })));
      await expect(fetchSubmission(G2(), fetch, { nonce: nonces() })).resolves.toEqual({ status: "verified" });
    });

    it("decision 49 - Stack Overflow /questions/123/acme-analytics-vs-globex, canary 301'd back to the canonical URL: verified", async () => {
      const url = "https://stackoverflow.com/questions/123/acme-analytics-vs-globex";
      const fetch = vi.fn().mockImplementation(async (u: string) => res(isCanary(u) ? NO_BRAND : PAGE_TEXT, { finalUrl: isCanary(u) ? url : u }));
      await expect(fetchSubmission(plan({ url, domain: "stackoverflow.com" }), fetch, { nonce: nonces() })).resolves.toEqual({ status: "verified" });
    });

    it("decision 49 - Medium title-slug-<id> serves the same story for any slug: verified", async () => {
      const url = "https://medium.com/@someone/acme-analytics-review-a1b2c3d4e5f6";
      const fetch = vi.fn().mockImplementation(async (u: string) => res(isCanary(u) ? NO_BRAND : PAGE_TEXT, { finalUrl: isCanary(u) ? url : u }));
      await expect(fetchSubmission(plan({ url, domain: "medium.com" }), fetch, { nonce: nonces() })).resolves.toEqual({ status: "verified" });
    });

    it("ECHO_PREFIX_MIN_LENGTH - a 4-letter nonce prefix on the canary is not an echo (the original is verified); a 5-letter one is", async () => {
      const four = vi.fn().mockImplementation(async (u: string) => res(isCanary(u) ? `${NO_BRAND} Ask zqxj about it.` : PAGE_TEXT, { finalUrl: u }));
      await expect(fetchSubmission(G2(), four, { nonce: nonces() })).resolves.toEqual({ status: "verified" });
      const five = vi.fn().mockImplementation(async (u: string) => res(isCanary(u) ? `${NO_BRAND} Ask zqxjv about it.` : PAGE_TEXT, { finalUrl: u }));
      await expect(fetchSubmission(G2(), five, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "url_echoes_brand" });
    });

    it("a clearly different 200 (a generic not-found template that does not echo) verifies the original", async () => {
      const other =
        "We could not find that page. Browse our categories, read the latest buyer guides, or use the main navigation to look for software by industry, company size and price.";
      const fetch = vi.fn().mockImplementation(async (u: string) => (isCanary(u) ? res(other, { finalUrl: u }) : res(PAGE_TEXT, { finalUrl: u })));
      await expect(fetchSubmission(G2(), fetch, { nonce: nonces() })).resolves.toEqual({ status: "verified" });
    });

    it("a canary that redirects off the domain (not followed) is a different page: verified", async () => {
      const fetch = vi.fn().mockImplementation(async (u: string) => (isCanary(u) ? res("", { status: 302, finalUrl: u, headers: { location: "https://evil.org/" } }) : res(PAGE_TEXT, { finalUrl: u })));
      await expect(fetchSubmission(G2(), fetch, { nonce: nonces() })).resolves.toEqual({ status: "verified" });
    });

    it("a canary that fails on the network or times out fails CLOSED with unreachable, never verified", async () => {
      for (const failure of [new Error("timeout"), new GuardedFetchRefusal("dns_resolution_failed", "ETIMEOUT"), new GuardedFetchRefusal("too_many_redirects")]) {
        const fetch = vi.fn().mockImplementation(async (u: string) => (isCanary(u) ? Promise.reject(failure) : res(PAGE_TEXT, { finalUrl: u })));
        await expect(fetchSubmission(G2(), fetch, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "unreachable" });
      }
    });

    it.each([[500], [503], [429], [403]])("a canary answered %i cannot be read as 'the site distinguishes slugs': fails closed with unreachable", async (status) => {
      const fetch = vi.fn().mockImplementation(async (u: string) => (isCanary(u) ? res("x", { status, finalUrl: u }) : res(PAGE_TEXT, { finalUrl: u })));
      await expect(fetchSubmission(G2(), fetch, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "unreachable" });
    });

    it("a canary refused for an unsafe target is unsafe_target (the same mapping as the page's own refusal)", async () => {
      const fetch = vi.fn().mockImplementation(async (u: string) => (isCanary(u) ? Promise.reject(new GuardedFetchRefusal("address_not_global")) : res(PAGE_TEXT, { finalUrl: u })));
      await expect(fetchSubmission(G2(), fetch, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "unsafe_target" });
    });

    it("the canary is not fetched when the page itself failed: the page's own reason is reported", async () => {
      const fetch = vi.fn().mockResolvedValue(res("boom", { status: 500 }));
      await expect(fetchSubmission(G2(), fetch, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "unreachable" });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["%41cme%C0 (valid escape beside an invalid byte)", "https://en.wikipedia.org/w/search/%41cme%C0/x"],
      ["Acm%65%ZZ (valid escape beside a malformed one)", "https://en.wikipedia.org/w/search/Acm%65%ZZ"],
      ["%252541cme (triple encoding)", "https://en.wikipedia.org/w/search/%252541cme"],
      ["?q=%u0041cme (the %u form)", "https://en.wikipedia.org/w/search?q=%u0041cme"],
    ])("the encoded bypass %s is caught by the canary: the nonce, encoded the same way, comes back", async (_name, url) => {
      const fetch = vi.fn().mockImplementation(async (u: string) => echoPage(u));
      await expect(fetchSubmission(WIKI(url), fetch, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "url_echoes_brand" });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("the canary is encoded the way the original was: the escapes outside the brand token are kept byte for byte", async () => {
      const seen: string[] = [];
      const fetch = vi.fn().mockImplementation(async (u: string) => {
        seen.push(u);
        return isCanary(u) ? notFound(u) : res(PAGE_TEXT, { finalUrl: u });
      });
      await fetchSubmission(WIKI("https://en.wikipedia.org/w/search/%41cme%C0/x"), fetch, { nonce: nonces() });
      // the escaped 'A' (depth 1) is replaced by an escaped 'z' (0x7A); the bytes beyond the token are untouched
      expect(seen[1]).toBe("https://en.wikipedia.org/w/search/%7Aqxjvkwpa%C0/x");
    });

    it("a %u-encoded token is re-encoded in the %u form", async () => {
      const seen: string[] = [];
      const fetch = vi.fn().mockImplementation(async (u: string) => {
        seen.push(u);
        return seen.length === 1 ? res("Acme Analytics.", { finalUrl: u }) : res("not found", { status: 404, finalUrl: u });
      });
      await fetchSubmission(WIKI("https://en.wikipedia.org/w/search?q=%u0041cme"), fetch, { nonce: () => "zqxjvkwpa" });
      expect(seen[1]).toBe("https://en.wikipedia.org/w/search?q=%u007Aqxjvkwpa");
    });

    it("a triple-encoded token is re-encoded at the same depth for the nonce", async () => {
      const seen: string[] = [];
      const fetch = vi.fn().mockImplementation(async (u: string) => {
        seen.push(u);
        return isCanary(u) ? notFound(u) : res(PAGE_TEXT, { finalUrl: u });
      });
      await fetchSubmission(WIKI("https://en.wikipedia.org/w/search/%252541cme"), fetch, { nonce: nonces() });
      expect(decodeLoosely(new URL(seen[1]!).pathname)).toContain("zqxjvkwpa");
      expect(new URL(seen[1]!).pathname).toContain("%25257A"); // 'z' (0x7A) at the depth of the escaped 'A' it replaces
    });

    it("a brand that cannot be located as a token in one segment (it is split over two) fails closed without a canary", async () => {
      const url = "https://en.wikipedia.org/wiki/acme/analytics";
      const fetch = vi.fn().mockResolvedValue(res(PAGE_TEXT, { finalUrl: url }));
      await expect(fetchSubmission(WIKI(url, { brand: { name: "Acme Analytics", aliases: [], negativeAliases: [] } }), fetch, { nonce: nonces() })).resolves.toEqual({
        status: "unverified",
        reason: "url_echoes_brand",
      });
      expect(fetch).toHaveBeenCalledTimes(1); // the page; no canary can be built
    });

    it("a canary that would STILL name the brand (one token replaced, another split over two segments) is not sent: fail closed", async () => {
      const url = "https://en.wikipedia.org/wiki/acme/analytics/Acme_Analytics";
      const fetch = vi.fn().mockImplementation(async (u: string) => (isCanary(u) ? notFound(u) : res(PAGE_TEXT, { finalUrl: u })));
      const brand = { name: "Acme Analytics", aliases: [], negativeAliases: [] };
      await expect(fetchSubmission(WIKI(url, { brand }), fetch, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "url_echoes_brand" });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("short brand names (Box, Notion) are not falsely refused: a /products/box/ URL whose canary is a 404 verifies", async () => {
      const brand = { name: "Box", aliases: [], negativeAliases: [] };
      const url = "https://www.g2.com/products/box/reviews";
      const fetch = vi.fn().mockImplementation(async (u: string) => (isCanary(u) ? notFound(u) : res("Box is a cloud content platform.", { finalUrl: u })));
      await expect(fetchSubmission(G2({ url, brand }), fetch, { nonce: nonces() })).resolves.toEqual({ status: "verified" });
      expect(fetch.mock.calls[1]![0]).toBe("https://www.g2.com/products/zqxjvkwpa/reviews");
    });

    it("an acme_vs_globex thread on reddit (real Reddit serves the same thread for any slug) is verified; a reflecting one is refused", async () => {
      const url = "https://reddit.com/r/saas/comments/abc/acme_vs_globex/";
      const R = (over: Partial<SubmissionPlan> = {}) => plan({ url, domain: "reddit.com", ...over });
      const thread = "Acme Analytics versus Globex, a comparison of two analytics tools and what teams think of them in this thread.";
      const real = vi.fn().mockImplementation(async (u: string) => res(thread, { finalUrl: u }));
      await expect(fetchSubmission(R(), real, { nonce: nonces() })).resolves.toEqual({ status: "verified" });
      const reflecting = vi.fn().mockImplementation(async (u: string) => res(`No thread called ${new URL(u).pathname}. Acme Analytics.`, { finalUrl: u }));
      await expect(fetchSubmission(R(), reflecting, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "url_echoes_brand" });
    });

    it("decision 49 - a redirect that keeps the slug (/tag/x -> /tag/x/) is not a reflection", async () => {
      const url = "https://www.g2.com/tag/acme-analytics";
      const soft404 = "We could not find that page. Browse our categories, read the latest buyer guides, or use the main navigation to look for software by industry, company size and price.";
      const fetch = vi.fn().mockImplementation(async (u: string) => (isCanary(u) ? res(soft404, { finalUrl: `${u}/` }) : res(PAGE_TEXT, { finalUrl: u })));
      await expect(fetchSubmission(G2({ url }), fetch, { nonce: nonces() })).resolves.toEqual({ status: "verified" });
    });

    it.each([[6], [5]])("a canary page that prints the first %i letters of the nonce is an echo (a truncated reflection)", async (n) => {
      const brand = { name: "Box", aliases: [], negativeAliases: [] };
      const url = "https://www.g2.com/search?q=box";
      const fetch = vi.fn().mockImplementation(async (u: string) => {
        if (!isCanary(u)) return res("Box is a cloud content platform.", { finalUrl: u });
        return res(`No results for ${new URL(u).searchParams.get("q")!.slice(0, n)}`, { finalUrl: u });
      });
      await expect(fetchSubmission(G2({ url, brand }), fetch, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "url_echoes_brand" });
    });

    it("the echo check and the canary run again on the FINAL url: a redirect onto a search URL is canaried, and verified when that canary is a 404", async () => {
      const start = "https://en.wikipedia.org/wiki/Special:Go";
      const landed = "https://en.wikipedia.org/w/index.php?search=Acme+Analytics";
      const fetch = vi.fn().mockImplementation(async (u: string) => (isCanary(u) ? notFound(u) : res("Acme Analytics, in text.", { finalUrl: landed })));
      await expect(fetchSubmission(WIKI(start), fetch, { nonce: nonces() })).resolves.toEqual({ status: "verified" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1]![0]).toBe("https://en.wikipedia.org/w/index.php?search=zqxjvkwpa");
    });

    it("the final URL's canary can refuse: the landed search page reflects the nonce", async () => {
      const start = "https://en.wikipedia.org/wiki/Special:Go";
      const landed = "https://en.wikipedia.org/w/index.php?search=Acme+Analytics";
      const fetch = vi.fn().mockImplementation(async (u: string) => (isCanary(u) ? res(`Results for ${decodeLoosely(new URL(u).search)}`, { finalUrl: u }) : res("Acme Analytics, in text.", { finalUrl: landed })));
      await expect(fetchSubmission(WIKI(start), fetch, { nonce: nonces() })).resolves.toEqual({ status: "unverified", reason: "url_echoes_brand" });
    });

    it("the random default nonce is letters only, and a different one for each occurrence", async () => {
      const seen: string[] = [];
      const fetch = vi.fn().mockImplementation(async (u: string) => {
        seen.push(u);
        return seen.length === 1 ? res(PAGE_TEXT, { finalUrl: u }) : notFound(u);
      });
      await fetchSubmission(WIKI("https://en.wikipedia.org/wiki/Acme/x?a=Acme&b=Acme"), fetch);
      const url = new URL(seen[1]!);
      const found = [url.pathname.split("/")[2]!, url.searchParams.get("a")!, url.searchParams.get("b")!];
      for (const n of found) expect(n).toMatch(/^[a-z]{8,}$/u);
      expect(new Set(found).size).toBe(3);
    });
  });
});
