import { describe, expect, it, vi } from "vitest";
import { createGuardedJsonFetcher, type JsonFetcher, type JsonFetchResult } from "./json-fetcher.js";
import { brandSameAsFrom } from "./same-as.js";
import { createWikiProfileProbe, WIKI_PROBE_MAX_REQUESTS } from "./wiki-probe.js";
import { CrawlRefusal } from "../../net/crawl-gate.js";
import { NOMINARA_USER_AGENT } from "../../net/user-agent.js";

// STORY-060 E1/E3 (owner decision 99b) - the Wikidata and Wikipedia profile probe, against FIXTURES: nothing here touches the network.

const SUBJECT = { name: "Acme", aliases: ["Acme Inc"], rootDomain: "acme.com" };

const json = (body: unknown): JsonFetchResult => ({ kind: "json", body });
const refused: JsonFetchResult = { kind: "refused", reason: "robots_disallowed" };

/** Answers by the host and the action in the URL; records every URL requested. */
function fixtureFetcher(answer: (url: URL) => JsonFetchResult): { fetchJson: JsonFetcher; requested: URL[] } {
  const requested: URL[] = [];
  return {
    requested,
    fetchJson: async (raw) => {
      const url = new URL(raw);
      requested.push(url);
      return answer(url);
    },
  };
}

const claim = (value: unknown) => [{ mainsnak: { snaktype: "value", datavalue: { value } } }];
const entity = (id: string, over: { website?: string; description?: string; instanceOf?: boolean; inception?: boolean; hq?: boolean; enwiki?: string } = {}) => ({
  id,
  descriptions: over.description === undefined ? {} : { en: { value: over.description } },
  claims: {
    ...(over.website === undefined ? {} : { P856: claim(over.website) }),
    ...(over.instanceOf === false ? {} : { P31: claim({ id: "Q4830453" }) }),
    ...(over.inception === false ? {} : { P571: claim({ time: "+2012-00-00T00:00:00Z" }) }),
    ...(over.hq === false ? {} : { P159: claim({ id: "Q60" }) }),
  },
  sitelinks: over.enwiki === undefined ? {} : { enwiki: { title: over.enwiki } },
});

/** A world where Wikidata knows Q1 (Acme, acme.com), Q2 (an unrelated "Acme"), and Wikipedia has the article "Acme (company)". */
function world(over: { q1?: ReturnType<typeof entity>; wikipediaMissing?: boolean; extract?: string; extlinks?: string[]; search?: { id: string }[] } = {}) {
  const q1 = over.q1 ?? entity("Q1", { website: "https://www.acme.com/", description: "software company", enwiki: "Acme (company)" });
  const q2 = entity("Q2", { website: "https://acme-corp.example/", description: "a fictional company" });
  return (url: URL): JsonFetchResult => {
    if (url.hostname.endsWith("wikidata.org")) {
      const action = url.searchParams.get("action");
      if (action === "wbsearchentities") return json({ search: over.search ?? [{ id: "Q2" }, { id: "Q1" }] });
      if (action === "wbgetentities") {
        const ids = (url.searchParams.get("ids") ?? "").split("|");
        return json({ entities: Object.fromEntries([q1, q2].filter((e) => ids.includes(e.id)).map((e) => [e.id, e])) });
      }
    }
    if (url.hostname.endsWith("wikipedia.org")) {
      const action = url.searchParams.get("action");
      if (action === "query" && url.searchParams.get("titles") !== null) {
        const title = url.searchParams.get("titles")!;
        if (over.wikipediaMissing === true) return json({ query: { pages: { "-1": { title, missing: "" } } } });
        return json({
          query: {
            pages: {
              "42": {
                pageid: 42,
                title,
                extract: over.extract ?? "Acme is a software company. ".repeat(20),
                extlinks: (over.extlinks ?? ["https://www.acme.com/"]).map((u) => ({ "*": u })),
                pageprops: { wikibase_item: "Q1" },
              },
            },
          },
        });
      }
      if (action === "query" && url.searchParams.get("list") === "exturlusage") return json({ query: { exturlusage: [{ title: "Acme (company)" }] } });
    }
    return { kind: "failed", reason: "http_404" };
  };
}

describe("STORY-060 E1 · the Wikidata and Wikipedia probe", () => {
  it("a Wikidata entity whose official website is the project's domain is the brand's profile; a namesake with another website is not", async () => {
    const { fetchJson } = fixtureFetcher(world());
    const out = await createWikiProfileProbe(fetchJson).probe(SUBJECT);
    const wikidata = out.checks.find((c) => c.node === "wikidata")!;
    expect(wikidata.url).toBe("https://www.wikidata.org/wiki/Q1");
    expect(wikidata.missingFields).toEqual([]);
  });

  it("a brand with NO matching entity is affirmatively ABSENT (a check with no url), because every request was answered", async () => {
    const { fetchJson } = fixtureFetcher(world({ search: [{ id: "Q2" }] }));
    const out = await createWikiProfileProbe(fetchJson).probe(SUBJECT);
    expect(out.checks.find((c) => c.node === "wikidata")).toEqual({ node: "wikidata", url: null, missingFields: [] });
    expect(out.unchecked).toEqual([]);
  });

  it("a candidate that states no official website cannot be told from a namesake, so it is not the brand's profile", async () => {
    const bare = entity("Q1", { description: "software company" });
    const { fetchJson } = fixtureFetcher(world({ q1: bare }));
    expect((await createWikiProfileProbe(fetchJson).probe(SUBJECT)).checks.find((c) => c.node === "wikidata")!.url).toBeNull();
  });

  it("completeness: the core fields the entity lacks are recorded, separate from presence", async () => {
    const thin = entity("Q1", { website: "https://acme.com", enwiki: "Acme (company)", instanceOf: false, inception: false, hq: false });
    const { fetchJson } = fixtureFetcher(world({ q1: thin }));
    const check = (await createWikiProfileProbe(fetchJson).probe(SUBJECT)).checks.find((c) => c.node === "wikidata")!;
    expect(check.url).toBe("https://www.wikidata.org/wiki/Q1");
    expect(check.missingFields).toEqual(["description", "instance_of", "inception", "headquarters_location"]);
  });

  it("Wikipedia: the article the Wikidata entity links to is the profile; a thin one reports what it lacks", async () => {
    const { fetchJson } = fixtureFetcher(world({ extract: "Short.", extlinks: [] }));
    const check = (await createWikiProfileProbe(fetchJson).probe(SUBJECT)).checks.find((c) => c.node === "wikipedia")!;
    expect(check.url).toBe("https://en.wikipedia.org/wiki/Acme_(company)");
    expect(check.missingFields).toEqual(["lead_section", "official_website_link"]);
  });

  it("Wikipedia: a Wikidata entity with no English article, or a linked article that does not exist, is affirmatively absent", async () => {
    const noArticle = entity("Q1", { website: "https://acme.com", description: "d" });
    expect((await createWikiProfileProbe(fixtureFetcher(world({ q1: noArticle })).fetchJson).probe(SUBJECT)).checks.find((c) => c.node === "wikipedia")).toEqual({ node: "wikipedia", url: null, missingFields: [] });
    expect((await createWikiProfileProbe(fixtureFetcher(world({ wikipediaMissing: true })).fetchJson).probe(SUBJECT)).checks.find((c) => c.node === "wikipedia")!.url).toBeNull();
  });

  it("Wikipedia without a Wikidata match: an article that links to the brand's domain and is titled by its name is found", async () => {
    const { fetchJson } = fixtureFetcher(world({ search: [{ id: "Q2" }] }));
    const check = (await createWikiProfileProbe(fetchJson).probe(SUBJECT)).checks.find((c) => c.node === "wikipedia")!;
    expect(check.url).toBe("https://en.wikipedia.org/wiki/Acme_(company)");
  });

  it("FAIL CLOSED: a refused, blocked or failed request leaves the node UNCHECKED, never absent", async () => {
    for (const blocked of [refused, { kind: "failed", reason: "http_503" } as JsonFetchResult]) {
      const { fetchJson } = fixtureFetcher((url) => (url.hostname.endsWith("wikidata.org") ? blocked : world()(url)));
      const out = await createWikiProfileProbe(fetchJson).probe(SUBJECT);
      expect(out.checks.find((c) => c.node === "wikidata")).toBeUndefined();
      expect(out.unchecked.find((u) => u.node === "wikidata")).toBeDefined();
    }
    const allBlocked = await createWikiProfileProbe(fixtureFetcher(() => refused).fetchJson).probe(SUBJECT);
    expect(allBlocked.checks).toEqual([]);
    expect(allBlocked.unchecked.map((u) => u.node).sort()).toEqual(["wikidata", "wikipedia"]);
  });

  it("a Wikidata answer that is not the shape expected is a failure to check, never a claim of absence", async () => {
    const { fetchJson } = fixtureFetcher((url) => (url.hostname.endsWith("wikidata.org") ? json({ unexpected: true }) : world()(url)));
    const out = await createWikiProfileProbe(fetchJson).probe(SUBJECT);
    expect(out.checks.find((c) => c.node === "wikidata")).toBeUndefined();
    expect(out.unchecked.find((u) => u.node === "wikidata")).toBeDefined();
  });

  it("ONLY the two probed nodes are ever reported (the other five stay 'not checked'), and only wikidata.org and wikipedia.org are contacted, within a bounded request count", async () => {
    const { fetchJson, requested } = fixtureFetcher(world());
    const out = await createWikiProfileProbe(fetchJson).probe(SUBJECT);
    expect(new Set([...out.checks.map((c) => c.node), ...out.unchecked.map((u) => u.node)])).toEqual(new Set(["wikidata", "wikipedia"]));
    expect(requested.every((u) => /(^|\.)(wikidata|wikipedia)\.org$/u.test(u.hostname))).toBe(true);
    expect(requested.length).toBeLessThanOrEqual(WIKI_PROBE_MAX_REQUESTS);
    // Only the brand's own vocabulary leaves: names and the domain, nothing about the workspace or its users.
    for (const u of requested) expect(u.search).not.toMatch(/workspace|project|user/iu);
  });

  it("looks the brand up by its name and aliases, bounded, de-duplicated and trimmed", async () => {
    const searches: string[] = [];
    const base = world();
    const { fetchJson } = fixtureFetcher((url) => {
      if (url.searchParams.get("action") === "wbsearchentities") searches.push(url.searchParams.get("search")!);
      return base(url);
    });
    await createWikiProfileProbe(fetchJson).probe({ name: "Acme", aliases: ["acme", " Acme Inc ", "Acme Inc", "A", "B", "C", "D", "E"], rootDomain: "acme.com" });
    expect(searches.length).toBeLessThanOrEqual(3);
    expect(new Set(searches).size).toBe(searches.length);
    expect(searches[0]).toBe("Acme");
  });
});

describe("STORY-060 E1 · the guarded JSON fetcher (robots and the per-host budget are the crawl gate's)", () => {
  const response = (status: number, body: string, type = "application/json") => ({ status, headers: { "content-type": type }, body: Buffer.from(body), finalUrl: "https://x.example/" });

  it("sends the identified NominaraBot agent and asks for JSON, and parses a 2xx JSON body", async () => {
    const fetchImpl = vi.fn(async () => response(200, '{"a":1}'));
    const out = await createGuardedJsonFetcher(fetchImpl as never)("https://www.wikidata.org/w/api.php?action=x");
    expect(out).toEqual({ kind: "json", body: { a: 1 } });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1];
    expect(init.headers["user-agent"]).toBe(NOMINARA_USER_AGENT);
    expect(init.headers.accept).toMatch(/json/u);
  });

  it("a robots refusal is a `refused` result carrying a reason code only; any other failure is `failed`", async () => {
    expect(await createGuardedJsonFetcher((async () => { throw new CrawlRefusal("robots_disallowed"); }) as never)("https://a.example/")).toEqual({ kind: "refused", reason: "robots_disallowed" });
    expect(await createGuardedJsonFetcher((async () => { throw new Error("connect ECONNREFUSED 10.0.0.1"); }) as never)("https://a.example/")).toEqual({ kind: "failed", reason: "fetch_error" });
    expect(await createGuardedJsonFetcher((async () => response(503, "x")) as never)("https://a.example/")).toEqual({ kind: "failed", reason: "http_503" });
    expect(await createGuardedJsonFetcher((async () => response(200, "<html>", "text/html")) as never)("https://a.example/")).toEqual({ kind: "failed", reason: "not_json" });
    expect(await createGuardedJsonFetcher((async () => response(200, "{broken")) as never)("https://a.example/")).toEqual({ kind: "failed", reason: "not_json" });
  });
});

describe("STORY-060 E3 · the brand's own sameAs, read from the home page's JSON-LD (the STORY-050 document model)", () => {
  it("collects every sameAs of an Organization-like node, from arrays, strings, @graph and nested nodes, de-duplicated", () => {
    const jsonLd = [
      { "@type": "Organization", name: "Acme", sameAs: ["https://www.wikidata.org/wiki/Q1", "https://www.linkedin.com/company/acme/"] },
      { "@graph": [{ "@type": ["Thing", "Corporation"], sameAs: "https://github.com/acme" }, { "@type": "WebSite", sameAs: ["https://not-the-brand.example/"] }] },
      { "@type": "Organization", sameAs: ["https://www.wikidata.org/wiki/Q1", { "@id": "https://en.wikipedia.org/wiki/Acme" }] },
    ];
    expect(brandSameAsFrom(jsonLd, [])).toEqual([
      "https://www.wikidata.org/wiki/Q1",
      "https://www.linkedin.com/company/acme/",
      "https://github.com/acme",
      "https://en.wikipedia.org/wiki/Acme",
    ]);
  });

  it("ignores a non-Organization node, a non-http value and a malformed one; no sameAs is an empty list, not an error", () => {
    expect(brandSameAsFrom([{ "@type": "Person", sameAs: ["https://x.example/"] }, { "@type": "Organization", sameAs: ["javascript:alert(1)", 5, null, "not a url"] }], [])).toEqual([]);
    expect(brandSameAsFrom([], [])).toEqual([]);
  });

  it("also reads microdata `sameAs` properties of an Organization item", () => {
    expect(brandSameAsFrom([], [{ type: "https://schema.org/Organization", properties: { sameAs: ["https://github.com/acme"] } }])).toEqual(["https://github.com/acme"]);
  });
});
