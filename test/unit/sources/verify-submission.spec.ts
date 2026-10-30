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
    ["a redirect-hop refusal", () => Promise.reject(new GuardedFetchRefusal("redirect_target_refused")), "unsafe_target"],
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

  it("a task with no source domain (a playbook-only task) has no domain constraint", async () => {
    await expect(fetchSubmission(plan({ domain: null, sourceDomainId: null, url: "https://anywhere.org/p" }), vi.fn().mockResolvedValue(res("Acme Analytics", { finalUrl: "https://anywhere.org/p" })))).resolves.toEqual({ status: "verified" });
  });
});
