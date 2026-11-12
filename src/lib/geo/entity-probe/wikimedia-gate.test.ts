import { describe, expect, it } from "vitest";
import { CrawlRefusal } from "../../net/crawl-gate.js";
import type { GuardedFetchInit, GuardedResponse } from "../../net/guarded-fetch.js";
import { NOMINARA_USER_AGENT } from "../../net/user-agent.js";
import { createWikimediaGate, isWikimediaApiEndpoint, WIKIMEDIA_API_CRAWL_DELAY_SECONDS } from "./wikimedia-gate.js";

// STORY-060 E1 / owner decision 99(j): a documented, NARROW robots exemption for the official Wikidata and Wikipedia API endpoints. Wikimedia's
// robots.txt disallows /w/ for `*`, which would refuse every probe request; their API etiquette (identifying user agent, serial requests) is the
// rule for these endpoints instead. Everything else keeps the robots gate.

const WD = "https://www.wikidata.org/w/api.php";
const WP = "https://en.wikipedia.org/w/api.php";

describe("isWikimediaApiEndpoint: exact hosts, exact path, enumerated actions", () => {
  it.each([
    [`${WD}?action=wbsearchentities&search=x`, true],
    [`${WD}?action=wbgetentities&ids=Q1`, true],
    [`${WP}?action=query&list=exturlusage`, true],
    [`${WP}?action=query&titles=A`, true],
  ])("%s -> %s", (url, expected) => expect(isWikimediaApiEndpoint(new URL(url))).toBe(expected));

  it.each([
    "https://www.wikidata.org/w/index.php?action=query",
    "https://www.wikidata.org/w/api.php?action=edit",
    "https://www.wikidata.org/w/api.php",
    "https://www.wikidata.org/w/api.php?action=query",
    "https://en.wikipedia.org/w/api.php?action=wbsearchentities",
    "https://en.wikipedia.org/w/api.php?action=parse&page=X",
    "https://en.wikipedia.org/wiki/Acme",
    "https://en.wikipedia.org/w/api.php/extra?action=query",
    "https://de.wikipedia.org/w/api.php?action=query",
    "https://wikipedia.org/w/api.php?action=query",
    "https://evil.example/w/api.php?action=query",
    "https://www.wikidata.org.evil.example/w/api.php?action=wbgetentities",
    "http://en.wikipedia.org/w/api.php?action=query",
    "https://en.wikipedia.org:8443/w/api.php?action=query",
  ])("is NOT exempt: %s", (url) => expect(isWikimediaApiEndpoint(new URL(url))).toBe(false));
});

describe("the Wikimedia gate", () => {
  function harness(robots: string) {
    const calls: { url: string; init: GuardedFetchInit }[] = [];
    const sleeps: number[] = [];
    const clock = { t: 1_000_000 };
    const inner = async (url: string, init: GuardedFetchInit = {}): Promise<GuardedResponse> => {
      calls.push({ url, init });
      const body = url.endsWith("/robots.txt") ? robots : "{}";
      return { status: 200, headers: { "content-type": url.endsWith("/robots.txt") ? "text/plain" : "application/json" }, body: Buffer.from(body), finalUrl: url };
    };
    const gate = createWikimediaGate({ fetch: inner, now: () => clock.t, sleep: async (ms) => void (sleeps.push(ms), (clock.t += ms)) });
    return { gate, calls, sleeps };
  }
  const WIKIMEDIA_ROBOTS = "User-agent: *\nDisallow: /w/\nDisallow: /wiki/Special:";

  it("an exempt API request is sent although robots.txt disallows /w/, WITHOUT reading robots.txt, as the identified NominaraBot", async () => {
    const h = harness(WIKIMEDIA_ROBOTS);
    const res = await h.gate(`${WD}?action=wbgetentities&ids=Q1`, { headers: { "user-agent": NOMINARA_USER_AGENT } });
    expect(res.status).toBe(200);
    expect(h.calls.map((c) => c.url)).toEqual([`${WD}?action=wbgetentities&ids=Q1`]);
    expect(h.calls[0]!.init.headers?.["user-agent"]).toBe(NOMINARA_USER_AGENT);
  });

  it("any OTHER path on the same domains still obeys robots: refused, robots_disallowed", async () => {
    const h = harness(WIKIMEDIA_ROBOTS);
    for (const url of ["https://www.wikidata.org/w/index.php?title=Q1", "https://en.wikipedia.org/w/api.php?action=parse&page=X", "https://en.wikipedia.org/wiki/Special:Search?search=x"]) {
      const error = await h.gate(url).catch((e: unknown) => e);
      expect(error, url).toBeInstanceOf(CrawlRefusal);
      expect((error as CrawlRefusal).reason).toBe("robots_disallowed");
    }
    expect(h.calls.every((c) => c.url.endsWith("/robots.txt"))).toBe(true);
  });

  it("any other HOST obeys robots even on an API-shaped URL", async () => {
    const h = harness("User-agent: *\nDisallow: /w/");
    const error = await h.gate("https://evil.example/w/api.php?action=query&titles=A").catch((e: unknown) => e);
    expect((error as CrawlRefusal).reason).toBe("robots_disallowed");
  });

  it("requests to one host are spaced by the strict crawl delay (serial, never a burst)", async () => {
    const h = harness(WIKIMEDIA_ROBOTS);
    await h.gate(`${WD}?action=wbsearchentities&search=a`);
    await h.gate(`${WD}?action=wbsearchentities&search=b`);
    await h.gate(`${WD}?action=wbgetentities&ids=Q1`);
    expect(h.sleeps.length).toBe(2);
    expect(h.sleeps.every((ms) => ms >= WIKIMEDIA_API_CRAWL_DELAY_SECONDS * 1000 - 1)).toBe(true);
  });

  it("a redirect from an exempt endpoint to a non-exempt URL is judged by robots on that hop", async () => {
    const calls: string[] = [];
    const inner = async (url: string): Promise<GuardedResponse> => {
      calls.push(url);
      if (url.endsWith("/robots.txt")) return { status: 200, headers: {}, body: Buffer.from(WIKIMEDIA_ROBOTS), finalUrl: url };
      return { status: 302, headers: { location: "https://www.wikidata.org/w/index.php?x=1" }, body: Buffer.from(""), finalUrl: url };
    };
    const gate = createWikimediaGate({ fetch: inner });
    const error = await gate(`${WD}?action=wbgetentities&ids=Q1`).catch((e: unknown) => e);
    expect((error as CrawlRefusal).reason).toBe("robots_disallowed");
    expect(calls.some((c) => c.includes("index.php?x=1"))).toBe(false);
  });
});
