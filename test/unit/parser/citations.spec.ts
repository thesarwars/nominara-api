import { describe, expect, it, vi } from "vitest";
import { GuardedFetchRefusal } from "../../../src/lib/net/guarded-fetch.js";
import {
  classifyCitation,
  isOwnedHost,
  normalizeCitationUrl,
  positionWeight,
} from "../../../src/lib/parser/citation-url.js";
import {
  dedupeWithinResponse,
  extractCitations,
  resolveCitation,
  shouldAlertOnResolutionFailures,
  type ExtractedCitation,
  type ResolveContext,
} from "../../../src/lib/parser/citations.js";

// STORY-037's eleven scenarios.

const CONTEXT: ResolveContext = {
  rootDomain: "hubspot.com",
  ownedDomains: ["hubspot.dev"],
  competitorDomains: ["salesforce.com"],
  now: () => new Date("2026-09-09T00:00:00.000Z"),
  fetch: (url) => Promise.resolve({ status: 200, finalUrl: url }),
};

function slot(rawUrl: string, slotIndex = 1): ExtractedCitation {
  return { slotIndex, rawUrl, anchorText: null, title: null };
}

describe("STORY-037 · extraction", () => {
  it("Scenario 1 — prefers the adapter's structured array, in slot order", () => {
    const citations = extractCitations("prose mentioning https://ignored.example.com", [
      { url: "https://b.example.com", slot: 2 },
      { url: "https://a.example.com", slot: 1, title: "A" },
    ]);

    expect(citations.map((c) => [c.slotIndex, c.rawUrl])).toEqual([
      [1, "https://a.example.com"],
      [2, "https://b.example.com"],
    ]);
    expect(citations[0]!.title).toBe("A");
  });

  it("does NOT merge the prose URLs in when a structured array is present", () => {
    // The union would add the same sources again under different slot numbers
    // and overstate every one of them.
    const citations = extractCitations("see https://extra.example.com too", [{ url: "https://a.example.com", slot: 1 }]);
    expect(citations).toHaveLength(1);
  });

  it("Scenario 2 — extracts markdown links, bare URLs and footnotes, inventing nothing", () => {
    const text = [
      "Try [HubSpot](https://hubspot.com/crm) or read https://g2.com/crm-reviews.",
      "",
      "[1]: https://capterra.com/crm",
    ].join("\n");

    const citations = extractCitations(text);
    expect(citations.map((c) => c.rawUrl)).toEqual([
      "https://hubspot.com/crm",
      "https://g2.com/crm-reviews",
      "https://capterra.com/crm",
    ]);
  });

  it("invents nothing from a response with no links at all", () => {
    expect(extractCitations("HubSpot is a good CRM. Salesforce is another.")).toEqual([]);
  });

  it("keeps the anchor text of a markdown link", () => {
    expect(extractCitations("[G2 reviews](https://g2.com/x)")[0]!.anchorText).toBe("G2 reviews");
  });

  it("counts a URL written twice as ONE citation, at its first appearance", () => {
    const citations = extractCitations("[G2](https://g2.com/x) — and again at https://g2.com/x.");
    expect(citations).toHaveLength(1);
    expect(citations[0]!.slotIndex).toBe(1);
  });

  it("does not swallow trailing sentence punctuation into a bare URL", () => {
    expect(extractCitations("see https://g2.com/crm.")[0]!.rawUrl).toBe("https://g2.com/crm");
  });
});

describe("STORY-037 · normalisation", () => {
  it("Scenario 5 — strips tracking parameters and the trailing slash", () => {
    const normalized = normalizeCitationUrl("https://WWW.G2.com/crm/?utm_source=chatgpt&utm_medium=ai&gclid=x&page=2");
    expect(normalized.normalized).toBe("https://g2.com/crm?page=2");
  });

  it("keeps parameters that are not on the list — over-stripping merges different pages", () => {
    // `?ref=` and `?source=` are tracking on some sites and routing on others.
    // Under-stripping splits a source's rows, which is visible; over-stripping
    // silently attributes one page's citations to another.
    expect(normalizeCitationUrl("https://g2.com/x?ref=nav&source=home").normalized).toBe(
      "https://g2.com/x?ref=nav&source=home",
    );
  });

  it("lower-cases the scheme and host but NOT the path", () => {
    // A path is case-significant on most servers; a host is not.
    expect(normalizeCitationUrl("HTTPS://G2.com/CRM/Reviews").normalized).toBe("https://g2.com/CRM/Reviews");
  });

  it("leaves the root's slash alone", () => {
    expect(normalizeCitationUrl("https://g2.com/").normalized).toBe("https://g2.com/");
  });

  it("Scenario 6 — PRESERVES a text-directive fragment and drops every other", () => {
    // The highest-value line in the story: the directive names the exact
    // passage the engine quoted, which the centroid can use without fetching
    // the page — routing around blocked and paywalled sources.
    const directive = normalizeCitationUrl("https://g2.com/crm#:~:text=HubSpot%20leads%20the%20category");
    expect(directive.textFragment).toBe("HubSpot%20leads%20the%20category");
    expect(directive.normalized).toContain("#:~:text=");

    const ordinary = normalizeCitationUrl("https://g2.com/crm#section-3");
    expect(ordinary.textFragment).toBeNull();
    expect(ordinary.normalized).toBe("https://g2.com/crm");
  });

  it("reports the registrable domain, not the host", () => {
    expect(normalizeCitationUrl("https://blog.example.co.uk/post").domain).toBe("example.co.uk");
  });

  it("hashes the NORMALISED url, so two spellings of one page collide deliberately", () => {
    const a = normalizeCitationUrl("https://www.g2.com/crm/?utm_source=x");
    const b = normalizeCitationUrl("https://g2.com/crm");
    expect(a.urlHash.equals(b.urlHash)).toBe(true);
  });
});

describe("STORY-037 · classification", () => {
  it("Scenario 7 — a subdomain of an owned domain is owned", () => {
    // The story flags this as easy to get wrong and expensive: owned share is
    // a component of the headline score, so a docs subdomain classified as
    // foreign directly depresses the number.
    expect(isOwnedHost("docs.hubspot.com", "hubspot.com", [])).toBe(true);
    expect(isOwnedHost("hubspot.com", "hubspot.com", [])).toBe(true);
    expect(isOwnedHost("www.hubspot.com", "hubspot.com", [])).toBe(true);
    expect(isOwnedHost("blog.hubspot.dev", "hubspot.com", ["hubspot.dev"])).toBe(true);
  });

  it("does NOT treat a lookalike domain as owned", () => {
    // `nothubspot.com` ends with `hubspot.com` and belongs to someone else.
    // The dot boundary is what makes a suffix a subdomain.
    expect(isOwnedHost("nothubspot.com", "hubspot.com", [])).toBe(false);
    expect(isOwnedHost("hubspot.com.evil.example", "hubspot.com", [])).toBe(false);
  });

  it("classifies owned and competitor domains as vendor_owned, keeping WHOSE separate", () => {
    // The class says what KIND of source it is; the booleans say whose.
    // Collapsing them makes "how many of my citations are vendor sites"
    // impossible to ask without double-counting my own.
    const owned = classifyCitation({ host: "docs.hubspot.com", domain: "hubspot.com", isOwned: true, competitorDomains: ["salesforce.com"] });
    expect(owned).toEqual({ isOwned: true, isCompetitor: false, sourceClass: "vendor_owned" });

    const competitor = classifyCitation({ host: "www.salesforce.com", domain: "salesforce.com", isOwned: false, competitorDomains: ["salesforce.com"] });
    expect(competitor).toEqual({ isOwned: false, isCompetitor: true, sourceClass: "vendor_owned" });
  });

  it("uses the curated list, then the heuristics", () => {
    expect(classifyCitation({ host: "en.wikipedia.org", domain: "wikipedia.org", isOwned: false, competitorDomains: [] }).sourceClass).toBe("encyclopedic");
    expect(classifyCitation({ host: "www.g2.com", domain: "g2.com", isOwned: false, competitorDomains: [] }).sourceClass).toBe("review_marketplace");
    expect(classifyCitation({ host: "docs.stripe.com", domain: "stripe.com", isOwned: false, competitorDomains: [] }).sourceClass).toBe("developer_platform");
    expect(classifyCitation({ host: "cs.stanford.edu", domain: "stanford.edu", isOwned: false, competitorDomains: [] }).sourceClass).toBe("academic");
  });

  it("answers `other` rather than GUESSING for an unrecognised host", () => {
    // Guessing "blog" for every unrecognised host would put a confident label
    // on most of the index and make the column worthless.
    expect(classifyCitation({ host: "some-company.example", domain: "some-company.example", isOwned: false, competitorDomains: [] }).sourceClass).toBe("other");
  });

  it("weights by 1/√slot, and refuses slot 0", () => {
    expect(positionWeight(1)).toBe(1);
    expect(positionWeight(4)).toBe(0.5);
    expect(() => positionWeight(0)).toThrow(RangeError);
  });
});

describe("STORY-037 · resolution", () => {
  it("Scenario 3 — resolves a wrapper and retains BOTH urls", () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, finalUrl: "https://g2.com/crm-reviews" });
    return resolveCitation(slot("https://vertexaisearch.example/grounding?id=abc"), { ...CONTEXT, fetch }).then((resolved) => {
      expect(resolved.rawUrl).toBe("https://vertexaisearch.example/grounding?id=abc");
      expect(resolved.normalizedUrl).toBe("https://g2.com/crm-reviews");
      expect(resolved.httpStatus).toBe(200);
      expect(resolved.countsTowardShare).toBe(true);
    });
  });

  it("Scenario 4 — an unresolvable redirect keeps the raw URL and is EXCLUDED from share", async () => {
    // Counting it as foreign penalises the brand for a vendor's redirect
    // scheme; counting it as owned would be worse.
    const fetch = vi.fn().mockRejectedValue(new GuardedFetchRefusal("too_many_redirects"));
    const resolved = await resolveCitation(slot("https://wrapper.example/loop"), { ...CONTEXT, fetch });

    expect(resolved.rawUrl).toBe("https://wrapper.example/loop");
    expect(resolved.httpStatus).toBeNull();
    expect(resolved.resolvedAt).toBeNull();
    expect(resolved.countsTowardShare).toBe(false);
    expect(resolved.isOwned).toBe(false);
    expect(resolved.isCompetitor).toBe(false);
  });

  it("Scenario 10 — a citation resolving to an internal address is refused, and does not fail the parse", async () => {
    // A citation URL is attacker-controlled in the most direct sense: an
    // engine can be induced to cite anything. One hostile citation must not
    // take down the whole capture.
    const fetch = vi.fn().mockRejectedValue(new GuardedFetchRefusal("redirect_target_refused"));
    const resolved = await resolveCitation(slot("https://wrapper.example/ssrf"), { ...CONTEXT, fetch });

    expect(resolved.countsTowardShare).toBe(false);
    expect(resolved.httpStatus).toBeNull();
  });

  it("classifies against the RESOLVED url, not the wrapper", async () => {
    // A wrapper on a foreign host resolving to the brand's own docs is an
    // owned citation, and classifying the wrapper would lose it.
    const fetch = vi.fn().mockResolvedValue({ status: 200, finalUrl: "https://docs.hubspot.com/api" });
    const resolved = await resolveCitation(slot("https://t.co/abc"), { ...CONTEXT, fetch });

    expect(resolved.isOwned).toBe(true);
  });

  it("keeps a slot whose URL will not parse, excluded from share, inventing nothing", async () => {
    const resolved = await resolveCitation(slot("https://"), { ...CONTEXT, fetch: () => Promise.reject(new Error("x")) });
    expect(resolved.rawUrl).toBe("https://");
    expect(resolved.countsTowardShare).toBe(false);
  });
});

describe("STORY-037 · deduplication and alerting", () => {
  it("Scenario 8 — the same normalised URL in three slots counts once, at the BEST slot", async () => {
    // Some engines repeat a citation across slots; counting each overstates
    // that source's influence. The best slot is the lowest index because
    // 1/√slot is decreasing — the citation the engine led with.
    const citations = await Promise.all(
      [1, 2, 3].map((index) =>
        resolveCitation(slot(`https://www.g2.com/crm?utm_source=s${String(index)}`, index), CONTEXT),
      ),
    );

    const deduped = dedupeWithinResponse(citations);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.slotIndex).toBe(1);
    expect(deduped[0]!.positionWeight).toBe(1);
  });

  it("Scenario 9 — the same URL across responses is not deduplicated", () => {
    // Nothing merges responses; each is deduplicated on its own. Asserted so
    // a future "optimisation" that dedupes across a run has to break a test.
    const one = dedupeWithinResponse([{ ...base(), normalizedUrl: "https://g2.com/x" }]);
    const two = dedupeWithinResponse([{ ...base(), normalizedUrl: "https://g2.com/x" }]);
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(1);
  });

  it("Scenario 11 — a high failure rate alerts, but only on a real sample", () => {
    // A vendor-change detector. One failure out of one is 100% and means
    // nothing; alerting on it would page someone for a single dead link, and
    // an alert that fires on noise stops being read.
    expect(shouldAlertOnResolutionFailures(100, 40)).toBe(true);
    expect(shouldAlertOnResolutionFailures(100, 10)).toBe(false);
    expect(shouldAlertOnResolutionFailures(1, 1)).toBe(false);
    expect(shouldAlertOnResolutionFailures(19, 19)).toBe(false);
  });
});

function base() {
  return {
    slotIndex: 1,
    rawUrl: "https://g2.com/x",
    normalizedUrl: "https://g2.com/x",
    urlHash: Buffer.alloc(32),
    domain: "g2.com",
    path: "/x",
    anchorText: null,
    title: null,
    isOwned: false,
    isCompetitor: false,
    sourceClass: "review_marketplace" as const,
    httpStatus: 200,
    resolvedAt: null,
    positionWeight: 1,
    textFragment: null,
    countsTowardShare: true,
  };
}
