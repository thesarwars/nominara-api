import { describe, expect, it } from "vitest";
import { GuardedFetchRefusal, guardedFetch } from "../../net/guarded-fetch.js";
import { createGuardedPageFetcher } from "./page-fetcher.js";

const ok = (body: string, type = "text/html; charset=utf-8", status = 200) => ({
  status,
  headers: { "content-type": type },
  body: Buffer.from(body),
  finalUrl: "https://x.example/p",
});

describe("guarded page fetcher - STORY-058 AC4 / scenario 5", () => {
  it("scenario 5 - a guard refusal is a refused result carrying the reason, never an exception", async () => {
    const fetcher = createGuardedPageFetcher(async () => {
      throw new GuardedFetchRefusal("address_not_global");
    });
    await expect(fetcher("http://internal.example/")).resolves.toEqual({ kind: "refused", reason: "address_not_global" });
  });
  it("scenario 5 - the REAL guard refuses loopback, link-local and private literals without any network call", async () => {
    const fetcher = createGuardedPageFetcher(guardedFetch);
    for (const url of ["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/", "http://[::1]/"]) {
      const result = await fetcher(url);
      expect(result.kind).toBe("refused");
    }
  });
  it("a 200 html response is returned as html", async () => {
    const fetcher = createGuardedPageFetcher(async () => ok("<p>hi</p>"));
    await expect(fetcher("https://x.example/p")).resolves.toEqual({ kind: "html", html: "<p>hi</p>" });
  });
  it("a non-2xx status, a non-html type, or an unexpected error is a failed result with a short code (no message, no address)", async () => {
    await expect(createGuardedPageFetcher(async () => ok("x", "text/html", 503))("https://x.example/")).resolves.toEqual({ kind: "failed", reason: "http_503" });
    await expect(createGuardedPageFetcher(async () => ok("x", "application/pdf"))("https://x.example/")).resolves.toEqual({ kind: "failed", reason: "not_html" });
    const boom = createGuardedPageFetcher(async () => {
      throw new Error("connect ECONNREFUSED 10.1.2.3:443");
    });
    const result = await boom("https://x.example/");
    expect(result).toEqual({ kind: "failed", reason: "fetch_error" });
  });
  it("the request is the identified crawler and keeps a truncated body rather than rejecting it", async () => {
    let seen: { headers?: Record<string, string>; truncateAtCap?: boolean } = {};
    await createGuardedPageFetcher(async (_url, init) => {
      seen = init ?? {};
      return ok("<p>x</p>");
    })("https://x.example/");
    expect(seen.headers?.["user-agent"]).toMatch(/^NominaraBot\//);
    expect(seen.truncateAtCap).toBe(true);
  });
});
