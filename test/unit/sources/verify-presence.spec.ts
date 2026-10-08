import { describe, expect, it, vi } from "vitest";
import { GuardedFetchRefusal, type GuardedResponse } from "../../../src/lib/net/guarded-fetch.js";
import {
  PRESENCE_CACHE_DAYS,
  isDemoDomain,
  selectPresenceChecks,
  verifyUrlPresence,
  type PresenceCandidate,
} from "../../../src/lib/sources/verify-presence.js";

// NEW-C-15 / STORY-054 AC4 + AC11 (scenarios 5, 6, 7): brand presence on a
// cited domain is VERIFIED BY FETCHING THE CITED URL (through the guarded
// fetcher) and matching it against the brand alias automaton, cached 30 days.
// A fetch that fails stays null; a demo `.example` domain is never verified.

const NOW = new Date("2026-10-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const BRAND = { name: "Acme Analytics", aliases: ["Acme"], negativeAliases: ["acme corporation of old"] };

function page(body: string, init: { status?: number; contentType?: string } = {}): GuardedResponse {
  return {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "text/html; charset=utf-8" },
    body: Buffer.from(body, "utf8"),
    finalUrl: "https://reviews.test/best",
  };
}

function candidate(over: Partial<PresenceCandidate> = {}): PresenceCandidate {
  return { sourceDomainId: "sd-1", domain: "reviews.test", topUrl: "https://reviews.test/best", verifiedAt: null, ...over };
}

describe("NEW-C-15 · verifyUrlPresence — STORY-054 scenarios 5 and 6", () => {
  it("STORY-054 scenario 5: the brand is on the fetched page, so presence is recorded true", async () => {
    const fetch = vi.fn().mockResolvedValue(page("<html><body><h1>Best tools</h1><p>We rank Acme Analytics first.</p></body></html>"));
    expect(await verifyUrlPresence("https://reviews.test/best", BRAND, fetch)).toEqual({ status: "present" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://reviews.test/best");
  });

  it("STORY-054 scenario 5: an alias (not the display name) also counts", async () => {
    const fetch = vi.fn().mockResolvedValue(page("<p>Many teams pick acme for dashboards.</p>"));
    expect(await verifyUrlPresence("https://reviews.test/best", BRAND, fetch)).toEqual({ status: "present" });
  });

  it("STORY-054 scenario 6: the page was fetched and the brand is not on it, so absence is VERIFIED false", async () => {
    const fetch = vi.fn().mockResolvedValue(page("<p>Only Globex and Initech are reviewed here.</p>"));
    expect(await verifyUrlPresence("https://reviews.test/best", BRAND, fetch)).toEqual({ status: "absent" });
  });

  it("STORY-054 scenario 6: a brand that appears only inside a link target or script is not a mention", async () => {
    const html =
      '<a href="https://acme.example/pricing">pricing</a><script>var x = "Acme Analytics";</script><style>.acme{}</style><p>Nothing here.</p>';
    expect(await verifyUrlPresence("https://reviews.test/best", BRAND, vi.fn().mockResolvedValue(page(html)))).toEqual({
      status: "absent",
    });
  });

  it("STORY-054 scenario 6: a negative alias suppresses the match (the common-word defence holds)", async () => {
    const fetch = vi.fn().mockResolvedValue(page("<p>The acme corporation of old went bankrupt.</p>"));
    expect(await verifyUrlPresence("https://reviews.test/best", BRAND, fetch)).toEqual({ status: "absent" });
  });

  it("STORY-054 scenario 6: a word boundary is required (Acmeville is not Acme)", async () => {
    const fetch = vi.fn().mockResolvedValue(page("<p>Visit Acmeville this summer.</p>"));
    expect(await verifyUrlPresence("https://reviews.test/best", BRAND, fetch)).toEqual({ status: "absent" });
  });

  it("STORY-054 AC4: a 404 is a FAILED fetch (null), never an asserted absence", async () => {
    const outcome = await verifyUrlPresence("https://reviews.test/gone", BRAND, vi.fn().mockResolvedValue(page("not found", { status: 404 })));
    expect(outcome).toEqual({ status: "failed", reason: "http_status" });
  });

  it("STORY-054 AC4: a 500 is a failed fetch", async () => {
    const outcome = await verifyUrlPresence("https://reviews.test/x", BRAND, vi.fn().mockResolvedValue(page("", { status: 500 })));
    expect(outcome).toEqual({ status: "failed", reason: "http_status" });
  });

  it("STORY-054 AC4: a network error is a failed fetch, and does not throw", async () => {
    const outcome = await verifyUrlPresence("https://reviews.test/x", BRAND, vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    expect(outcome).toEqual({ status: "failed", reason: "fetch_error" });
  });

  it("STORY-054 AC11: a refusal from the guarded fetcher is a failed fetch carrying only the refusal reason", async () => {
    const outcome = await verifyUrlPresence(
      "https://internal.test/x",
      BRAND,
      vi.fn().mockRejectedValue(new GuardedFetchRefusal("address_not_global")),
    );
    expect(outcome).toEqual({ status: "failed", reason: "refused" });
  });

  it("STORY-054 AC4: a non-text body (a PDF) cannot be matched, so it is failed rather than absent", async () => {
    const outcome = await verifyUrlPresence(
      "https://reviews.test/x.pdf",
      BRAND,
      vi.fn().mockResolvedValue(page("%PDF-1.7 Acme Analytics", { contentType: "application/pdf" })),
    );
    expect(outcome).toEqual({ status: "failed", reason: "not_text" });
  });

  it("STORY-054 AC4: an empty 200 page is absent (it was fetched; nothing is on it)", async () => {
    expect(await verifyUrlPresence("https://reviews.test/x", BRAND, vi.fn().mockResolvedValue(page("")))).toEqual({ status: "absent" });
  });

  it("STORY-054 AC4: a brand with no usable alias cannot be matched, so it is failed and never fetches", async () => {
    const fetch = vi.fn();
    const outcome = await verifyUrlPresence("https://reviews.test/x", { name: "  ", aliases: [], negativeAliases: [] }, fetch);
    expect(outcome).toEqual({ status: "failed", reason: "no_aliases" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("NEW-C-15 · selectPresenceChecks — STORY-054 scenario 7 (cache window) and the demo rule", () => {
  it("is thirty days", () => {
    expect(PRESENCE_CACHE_DAYS).toBe(30);
  });

  it("STORY-054 scenario 7: a domain never verified is fetched", () => {
    const { check } = selectPresenceChecks([candidate()], NOW);
    expect(check.map((c) => c.domain)).toEqual(["reviews.test"]);
  });

  it("STORY-054 scenario 7: a domain verified inside the window is NOT fetched again", () => {
    const { check, skipped } = selectPresenceChecks([candidate({ verifiedAt: new Date(NOW.getTime() - 10 * DAY) })], NOW);
    expect(check).toEqual([]);
    expect(skipped.cached).toBe(1);
  });

  it("STORY-054 scenario 7: one millisecond inside thirty days is still cached", () => {
    const { check } = selectPresenceChecks([candidate({ verifiedAt: new Date(NOW.getTime() - 30 * DAY + 1) })], NOW);
    expect(check).toEqual([]);
  });

  it("STORY-054 scenario 7: at exactly thirty days the cache has expired and the domain is fetched again", () => {
    const { check } = selectPresenceChecks([candidate({ verifiedAt: new Date(NOW.getTime() - 30 * DAY) })], NOW);
    expect(check).toHaveLength(1);
  });

  it("STORY-054 AC4: a domain with no known URL is skipped (nothing to fetch), counted", () => {
    const { check, skipped } = selectPresenceChecks([candidate({ topUrl: null })], NOW);
    expect(check).toEqual([]);
    expect(skipped.no_url).toBe(1);
  });

  it("NEW-C-15: a demo .example domain is never fetched, even when unverified", () => {
    const { check, skipped } = selectPresenceChecks([candidate({ domain: "acme-io.community-forum.example", topUrl: "https://acme-io.community-forum.example/t/1" })], NOW);
    expect(check).toEqual([]);
    expect(skipped.demo).toBe(1);
  });

  it("an empty candidate list yields nothing and zero counts", () => {
    expect(selectPresenceChecks([], NOW)).toEqual({ check: [], skipped: { demo: 0, cached: 0, no_url: 0 } });
  });

  it("is a partition: every candidate is checked or counted in exactly one skip bucket", () => {
    const candidates = [
      candidate({ sourceDomainId: "a" }),
      candidate({ sourceDomainId: "b", verifiedAt: new Date(NOW.getTime() - DAY) }),
      candidate({ sourceDomainId: "c", topUrl: null }),
      candidate({ sourceDomainId: "d", domain: "x.example", topUrl: "https://x.example/" }),
    ];
    const { check, skipped } = selectPresenceChecks(candidates, NOW);
    expect(check.length + skipped.cached + skipped.no_url + skipped.demo).toBe(candidates.length);
  });
});

describe("NEW-C-15 · isDemoDomain — only a real citation verifies", () => {
  it.each([
    ["reviews.example", true],
    ["acme-io.community-forum.example", true],
    ["REVIEWS.EXAMPLE", true],
    ["reviews.example.", true],
    ["example.com", false],
    ["reviews.example.com", false],
    ["notexample", false],
    ["myexample.org", false],
    ["reddit.com", false],
  ])("%s -> %s", (domain, expected) => {
    expect(isDemoDomain(domain)).toBe(expected);
  });
});
