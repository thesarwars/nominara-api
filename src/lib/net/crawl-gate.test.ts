import { describe, expect, it } from "vitest";
import { CrawlRefusal, createCrawlGate } from "./crawl-gate.js";
import type { GuardedFetchInit, GuardedResponse } from "./guarded-fetch.js";
import { NOMINARA_USER_AGENT } from "./user-agent.js";

// Owner decision 70(d): every NominaraBot fetch checks the target host's robots.txt and keeps to a per-host budget.

const reply = (status: number, body = "", headers: Record<string, string> = {}, finalUrl = ""): GuardedResponse => ({
  status,
  headers: { "content-type": "text/html", ...headers },
  body: Buffer.from(body),
  finalUrl,
});

function harness(routes: Record<string, () => GuardedResponse>, options: { robotsTtlMs?: number } = {}) {
  const calls: { url: string; init: GuardedFetchInit }[] = [];
  const clock = { t: 1_000_000 };
  const sleeps: number[] = [];
  const inner = async (url: string, init: GuardedFetchInit = {}): Promise<GuardedResponse> => {
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) throw new Error(`no route ${url}`);
    return { ...route(), finalUrl: url };
  };
  const gate = createCrawlGate({
    fetch: inner,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    ...options,
  });
  return { gate, calls, clock, sleeps, urls: () => calls.map((c) => c.url) };
}

const ROBOTS = "https://a.example/robots.txt";

describe("crawl gate - decision 70(d)", () => {
  it("70d-1 a path robots.txt disallows is NOT fetched, and the refusal says robots_disallowed", async () => {
    const h = harness({ [ROBOTS]: () => reply(200, "User-agent: *\nDisallow: /private"), "https://a.example/private/x": () => reply(200, "secret") });
    const error = await h.gate("https://a.example/private/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrawlRefusal);
    expect((error as CrawlRefusal).reason).toBe("robots_disallowed");
    expect(h.urls()).toEqual([ROBOTS]);
  });

  it("70d-2 an allowed path is fetched, as NominaraBot, after robots.txt", async () => {
    const h = harness({ [ROBOTS]: () => reply(200, "User-agent: *\nDisallow: /private"), "https://a.example/pub": () => reply(200, "hi") });
    const response = await h.gate("https://a.example/pub", { headers: { "user-agent": NOMINARA_USER_AGENT } });
    expect(response.status).toBe(200);
    expect(h.urls()).toEqual([ROBOTS, "https://a.example/pub"]);
    expect(h.calls[0]!.init.headers?.["user-agent"]).toBe(NOMINARA_USER_AGENT);
  });

  it("70d-3 a group naming NominaraBot overrides the wildcard group", async () => {
    const h = harness({ [ROBOTS]: () => reply(200, "User-agent: *\nDisallow: /\n\nUser-agent: NominaraBot\nAllow: /"), "https://a.example/p": () => reply(200, "x") });
    await expect(h.gate("https://a.example/p")).resolves.toMatchObject({ status: 200 });
  });

  it("70d-4 the robots cache: one robots.txt fetch serves many paths, a TTL expiry refetches, another host has its own", async () => {
    const h = harness(
      {
        [ROBOTS]: () => reply(200, ""),
        "https://a.example/1": () => reply(200),
        "https://a.example/2": () => reply(200),
        "https://b.example/robots.txt": () => reply(404),
        "https://b.example/1": () => reply(200),
      },
      { robotsTtlMs: 60_000 },
    );
    await h.gate("https://a.example/1");
    await h.gate("https://a.example/2");
    expect(h.urls().filter((u) => u === ROBOTS)).toHaveLength(1);
    h.clock.t += 61_000;
    await h.gate("https://a.example/1");
    expect(h.urls().filter((u) => u === ROBOTS)).toHaveLength(2);
    await h.gate("https://b.example/1");
    expect(h.urls().filter((u) => u === "https://b.example/robots.txt")).toHaveLength(1);
  });

  it("70d-5 concurrent first requests to one host share ONE robots.txt fetch", async () => {
    const h = harness({ [ROBOTS]: () => reply(200, ""), "https://a.example/1": () => reply(200), "https://a.example/2": () => reply(200) });
    await Promise.all([h.gate("https://a.example/1"), h.gate("https://a.example/2")]);
    expect(h.urls().filter((u) => u === ROBOTS)).toHaveLength(1);
  });

  it("70d-6 the budget: requests to one host start at least 500 ms apart (robots.txt counts), another host is not delayed by it", async () => {
    const h = harness({
      [ROBOTS]: () => reply(200, ""),
      "https://a.example/1": () => reply(200),
      "https://a.example/2": () => reply(200),
      "https://b.example/robots.txt": () => reply(404),
      "https://b.example/1": () => reply(200),
    });
    const starts: number[] = [];
    const base = h.gate;
    await base("https://a.example/1");
    starts.push(h.clock.t);
    await base("https://a.example/2");
    starts.push(h.clock.t);
    // robots (t0), page 1 (>= t0+500), page 2 (>= t0+1000): two sleeps of 500 each.
    expect(h.sleeps).toEqual([500, 500]);
    const before = h.sleeps.length;
    await base("https://b.example/1");
    expect(h.sleeps.slice(before)).toEqual([500]); // b's own robots then page: one wait between THEM, none inherited from a
  });

  it("70d-7 the budget honours the host's Crawl-delay", async () => {
    const h = harness({ [ROBOTS]: () => reply(200, "User-agent: *\nCrawl-delay: 2"), "https://a.example/1": () => reply(200), "https://a.example/2": () => reply(200) });
    await h.gate("https://a.example/1");
    await h.gate("https://a.example/2");
    expect(h.sleeps).toEqual([2000, 2000]);
  });

  it("70d-8 robots.txt 404 means no rules; 5xx or an error means unavailable and NOTHING is fetched (fail closed)", async () => {
    const open = harness({ [ROBOTS]: () => reply(404), "https://a.example/1": () => reply(200) });
    await expect(open.gate("https://a.example/1")).resolves.toMatchObject({ status: 200 });
    const down = harness({ [ROBOTS]: () => reply(503), "https://a.example/1": () => reply(200) });
    const error = await down.gate("https://a.example/1").catch((e: unknown) => e);
    expect((error as CrawlRefusal).reason).toBe("robots_unavailable");
    expect(down.urls()).toEqual([ROBOTS]);
    const broken = harness({ "https://a.example/1": () => reply(200) }); // robots route missing: the inner fetch throws
    const brokenError = await broken.gate("https://a.example/1").catch((e: unknown) => e);
    expect((brokenError as CrawlRefusal).reason).toBe("robots_unavailable");
  });

  it("70d-9 a robots.txt that could not be read is retried after a short while, not cached as the TTL", async () => {
    let status = 503;
    const h = harness({ [ROBOTS]: () => reply(status, ""), "https://a.example/1": () => reply(200) }, { robotsTtlMs: 3_600_000 });
    await h.gate("https://a.example/1").catch(() => undefined);
    await h.gate("https://a.example/1").catch(() => undefined);
    expect(h.urls().filter((u) => u === ROBOTS)).toHaveLength(1); // the failure is cached briefly
    status = 200;
    h.clock.t += 6 * 60_000;
    await expect(h.gate("https://a.example/1")).resolves.toMatchObject({ status: 200 });
  });

  it("70d-10 robots.txt itself is always fetchable (no recursion), and is gated like any request", async () => {
    const h = harness({ [ROBOTS]: () => reply(200, "User-agent: *\nDisallow: /") });
    await expect(h.gate(ROBOTS)).resolves.toMatchObject({ status: 200 });
    expect(h.urls()).toEqual([ROBOTS]);
  });

  it("70d-11 a redirect hop is gated: a hop into a disallowed path (even on another host) is refused and never requested", async () => {
    const h = harness({
      [ROBOTS]: () => reply(200, ""),
      "https://a.example/old": () => reply(301, "", { location: "https://b.example/secret" }),
      "https://b.example/robots.txt": () => reply(200, "User-agent: *\nDisallow: /secret"),
      "https://b.example/secret": () => reply(200, "no"),
    });
    const error = await h.gate("https://a.example/old").catch((e: unknown) => e);
    expect((error as CrawlRefusal).reason).toBe("robots_disallowed");
    expect(h.urls()).not.toContain("https://b.example/secret");
  });

  it("70d-12 an allowed redirect is followed, the chain is recorded, and the caller's followRedirect veto still applies", async () => {
    const routes = {
      [ROBOTS]: () => reply(200, ""),
      "https://a.example/old": () => reply(301, "", { location: "https://a.example/new" }),
      "https://a.example/new": () => reply(200, "ok"),
    };
    const h = harness(routes);
    const followed = await h.gate("https://a.example/old");
    expect(followed.status).toBe(200);
    expect(followed.finalUrl).toBe("https://a.example/new");
    expect(followed.redirectChain).toEqual(["https://a.example/old"]);
    const vetoed = await harness(routes).gate("https://a.example/old", { followRedirect: () => false });
    expect(vetoed.status).toBe(301);
  });

  it("70d-13 a redirect loop ends in too_many_redirects, not a hang", async () => {
    const h = harness({ [ROBOTS]: () => reply(200, ""), "https://a.example/x": () => reply(302, "", { location: "https://a.example/x" }) });
    await expect(h.gate("https://a.example/x")).rejects.toMatchObject({ reason: "too_many_redirects" });
  });
});
