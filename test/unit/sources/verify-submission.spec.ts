import { describe, expect, it, vi } from "vitest";
import { GuardedFetchRefusal, type GuardedResponse } from "../../../src/lib/net/guarded-fetch.js";
import { fetchSubmission, type SubmissionPlan } from "../../../src/lib/sources/verify-submission.js";

// STORY-055 AC6 + AC11 (scenarios 6 and 7) - the fetch phase of a submitted URL: no database, a fake guarded fetcher, and the
// mapping from what the fetch found to the SPECIFIC reason the customer sees. A reason is never generic.

const URL_OK = "https://reviews.dev/threads/acme";
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
    expect(fetch).toHaveBeenCalledWith(URL_OK);
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
});
