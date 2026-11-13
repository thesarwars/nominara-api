import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { createCrawlGate } from "../../lib/net/crawl-gate.js";
import type { GuardedResponse } from "../../lib/net/guarded-fetch.js";
import type { UrlGuard } from "../../lib/net/url-guard.service.js";
import { ProjectFingerprintService } from "./project-fingerprint.service.js";

vi.mock("../../lib/net/crawl-gate.js", async (importOriginal) => ({ ...(await importOriginal<object>()), crawlGatedFetch: vi.fn() }));

// Owner decisions 70(d) and 105(c): the fingerprint's one fetch identifies as NominaraBot, so it reads robots.txt and keeps the per-host budget like every other
// NominaraBot fetch. It stays inside the request's single deadline; a refused page is an ANSWER (`unavailable`), never an error.
const reply = (url: string, body: string, status = 200, type = "text/html"): GuardedResponse => ({ status, headers: { "content-type": type }, body: Buffer.from(body), finalUrl: url }) as GuardedResponse;
const guard = () => ({ validateAndNormalize: vi.fn(async () => ({ rootDomain: "a.test" })) }) as unknown as UrlGuard;

describe("POST /projects/fingerprint · decision 70(d) robots gate", () => {
  it("the DEFAULT fetch is the robots-gated one", async () => {
    const { crawlGatedFetch } = await import("../../lib/net/crawl-gate.js");
    vi.mocked(crawlGatedFetch).mockResolvedValue(reply("https://default.test/", "<html><title>Acme</title></html>"));
    const res = await new ProjectFingerprintService(guard()).fingerprint({ root_url: "https://default.test/" });
    expect(res.status).toBe("complete");
    expect(crawlGatedFetch).toHaveBeenCalledTimes(1);
  });

  it("a site whose robots.txt disallows the page is not fetched: the answer is unavailable (unreachable), with no error", async () => {
    const requested: string[] = [];
    const inner = async (url: string): Promise<GuardedResponse> => {
      requested.push(url);
      return url.endsWith("/robots.txt") ? reply(url, "User-agent: *\nDisallow: /", 200, "text/plain") : reply(url, "<html><title>Acme</title></html>");
    };
    const res = await new ProjectFingerprintService(guard(), createCrawlGate({ fetch: inner })).fingerprint({ root_url: "https://closed.test/" });
    expect(res).toMatchObject({ status: "unavailable", reason: "unreachable", credits_charged: 0 });
    expect(requested).toEqual(["https://closed.test/robots.txt"]);
  });
});
