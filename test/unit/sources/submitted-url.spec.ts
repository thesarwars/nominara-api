import { describe, expect, it } from "vitest";
import { checkSubmittedUrl, isSeedingTask } from "../../../src/lib/sources/verify-submission.js";

// STORY-055 scenario 8 — the PURE host check at submit (owner decision 30): no DNS, no socket, so it is safe in the request
// handler (KAD-06). Anything it cannot prove safe from the text alone is refused with the guarded fetcher's own reasons; what
// only DNS can tell (a public name that resolves to a private address) is refused again by the guarded fetch in the job.
describe("STORY-055 scenario 8 · checkSubmittedUrl (pure host rules)", () => {
  it.each([
    ["https://www.reddit.com/r/saas/comments/abc/best_tools/", "https://www.reddit.com/r/saas/comments/abc/best_tools/"],
    ["http://g2.com/products/acme/reviews", "http://g2.com/products/acme/reviews"],
    ["  https://news.ycombinator.com/item?id=1  ", "https://news.ycombinator.com/item?id=1"],
    // review r3: the NORMALISED href is what is stored, fetched and returned (default port dropped, scheme and host lowercased).
    ["https://example.com:443/x", "https://example.com/x"],
    ["HTTPS://Example.COM/Path?Q=1#f", "https://example.com/Path?Q=1#f"],
  ])("accepts %s", (raw, url) => {
    expect(checkSubmittedUrl(raw)).toEqual({ ok: true, url });
  });

  it.each([
    ["http://127.0.0.1/x", "address_not_global"],
    ["http://127.1/x", "address_not_global"],
    ["http://0x7f.0.0.1/x", "address_not_global"],
    ["http://2130706433/x", "address_not_global"],
    ["http://10.0.0.5/x", "address_not_global"],
    ["http://172.16.0.1/x", "address_not_global"],
    ["http://192.168.1.1/x", "address_not_global"],
    ["http://169.254.169.254/latest/meta-data", "address_not_global"],
    ["http://[::1]/x", "address_not_global"],
    ["http://[::ffff:127.0.0.1]/x", "address_not_global"],
    ["http://[fd00::1]/x", "address_not_global"],
    ["http://localhost/x", "address_not_global"],
    ["http://LOCALHOST./x", "address_not_global"],
    ["http://app.localhost/x", "address_not_global"],
    ["http://db.internal/x", "address_not_global"],
    ["http://printer.local/x", "address_not_global"],
    ["http://intranet/x", "address_not_global"],
  ])("refuses the private or internal host %s as %s", (raw, reason) => {
    expect(checkSubmittedUrl(raw)).toEqual({ ok: false, reason });
  });

  it.each([
    ["ftp://example.com/x", "scheme_not_allowed"],
    ["file:///etc/passwd", "scheme_not_allowed"],
    ["javascript:alert(1)", "scheme_not_allowed"],
    ["gopher://example.com/", "scheme_not_allowed"],
    ["not a url", "scheme_not_allowed"],
    ["https://example.com:8443/x", "port_not_allowed"],
    ["http://example.com:22/x", "port_not_allowed"],
  ])("refuses %s as %s", (raw, reason) => {
    expect(checkSubmittedUrl(raw)).toEqual({ ok: false, reason });
  });

  it.each(["https://user:pw@reddit.com/r/x", "https://user@reddit.com/r/x", "http://:pw@g2.com/x"])("review r3 - refuses a URL that carries credentials: %s", (raw) => {
    expect(checkSubmittedUrl(raw)).toEqual({ ok: false, reason: "credentials" });
  });

  it("the refusal never echoes the address", () => {
    expect(JSON.stringify(checkSubmittedUrl("http://10.1.2.3/secret"))).not.toContain("10.1.2.3");
  });
});

describe("STORY-055 · isSeedingTask — a playbook or a source class", () => {
  it.each([
    [{ playbook_slug: "reddit-contribution", source_domain_id: null }, true],
    [{ playbook_slug: null, source_domain_id: "d" }, true],
    [{ playbook_slug: "p", source_domain_id: "d" }, true],
    [{ playbook_slug: null, source_domain_id: null }, false],
  ])("%j -> %s", (task, expected) => {
    expect(isSeedingTask(task)).toBe(expected);
  });
});
