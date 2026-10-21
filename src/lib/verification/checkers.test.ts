import { describe, expect, it, vi } from "vitest";
import { checkDnsTxt, checkMetaTag, checkWellKnownFile, TXT_PREFIX, type CheckDeps } from "./checkers.js";
import { GuardedFetchRefusal } from "../net/guarded-fetch.js";

// STORY-048 scenarios 2-6.

const NONCE = "a1b2c3d4e5f6";
const DOMAIN = "hubspot.com";

function deps(over: Partial<CheckDeps>): CheckDeps {
  return {
    resolveTxt: vi.fn(async () => []),
    fetch: vi.fn(async () => ({ status: 404, headers: {}, body: Buffer.from(""), finalUrl: "" })),
    ...over,
  };
}

function serving(status: number, body: string, headers: Record<string, string> = {}) {
  return vi.fn(async () => ({ status, headers, body: Buffer.from(body), finalUrl: `https://${DOMAIN}/` }));
}

describe("STORY-048 · DNS TXT", () => {
  it("scenario 2 — succeeds on a correct record", async () => {
    const d = deps({ resolveTxt: vi.fn(async () => [[`${TXT_PREFIX}${NONCE}`]]) });
    await expect(checkDnsTxt(DOMAIN, NONCE, d)).resolves.toEqual({ ok: true });
  });

  it("queries the _nominara-verify subdomain, not the apex", async () => {
    const resolveTxt = vi.fn(async () => [[`${TXT_PREFIX}${NONCE}`]]);
    await checkDnsTxt(DOMAIN, NONCE, deps({ resolveTxt }));
    expect(resolveTxt).toHaveBeenCalledWith("_nominara-verify.hubspot.com");
  });

  it("scenario 3 — absent record fails with record_absent", async () => {
    const d = deps({ resolveTxt: vi.fn(async () => { throw new Error("ENOTFOUND"); }) });
    await expect(checkDnsTxt(DOMAIN, NONCE, d)).resolves.toEqual({ ok: false, reason: "record_absent" });
  });

  // Scenario 4 — a DIFFERENT remedy from an absent record, so a different reason.
  it("scenario 4 — a record with the wrong value is distinguished from an absent one", async () => {
    const d = deps({ resolveTxt: vi.fn(async () => [[`${TXT_PREFIX}wrong-nonce`]]) });
    await expect(checkDnsTxt(DOMAIN, NONCE, d)).resolves.toEqual({ ok: false, reason: "record_present_but_wrong" });
  });

  // A TXT value over 255 bytes is split by the protocol itself. Without
  // joining, a long record never matches and the failure looks like a wrong
  // value rather than a chunking bug.
  it("joins the chunks of a split TXT record", async () => {
    const value = `${TXT_PREFIX}${NONCE}`;
    const split = [value.slice(0, 5), value.slice(5)];
    const d = deps({ resolveTxt: vi.fn(async () => [split]) });
    await expect(checkDnsTxt(DOMAIN, NONCE, d)).resolves.toEqual({ ok: true });
  });

  it("finds our record among a domain's other TXT records", async () => {
    const d = deps({
      resolveTxt: vi.fn(async () => [["v=spf1 include:_spf.google.com ~all"], [`${TXT_PREFIX}${NONCE}`]]),
    });
    await expect(checkDnsTxt(DOMAIN, NONCE, d)).resolves.toEqual({ ok: true });
  });
});

describe("STORY-048 · well-known file", () => {
  it("scenario 2 — succeeds when the file contains exactly the nonce", async () => {
    await expect(checkWellKnownFile(DOMAIN, NONCE, deps({ fetch: serving(200, `${NONCE}\n`) }))).resolves.toEqual({
      ok: true,
    });
  });

  it("requests the per-nonce path", async () => {
    const fetch = serving(200, NONCE);
    await checkWellKnownFile(DOMAIN, NONCE, deps({ fetch }));
    expect(fetch).toHaveBeenCalledWith(`https://${DOMAIN}/.well-known/nominara-${NONCE}.txt`);
  });

  // Scenario 5 — a redirect proves control of the TARGET, not of this domain.
  // Following it is exactly how this check would become forgeable.
  it.each([301, 302, 307, 308])("scenario 5 — a %d redirect is not proof", async (status) => {
    await expect(checkWellKnownFile(DOMAIN, NONCE, deps({ fetch: serving(status, "") }))).resolves.toEqual({
      ok: false,
      reason: "file_redirected",
    });
  });

  it("scenario 3 — a 404 fails with file_absent", async () => {
    await expect(checkWellKnownFile(DOMAIN, NONCE, deps({ fetch: serving(404, "") }))).resolves.toEqual({
      ok: false,
      reason: "file_absent",
    });
  });

  it("distinguishes wrong content from an absent file", async () => {
    await expect(checkWellKnownFile(DOMAIN, NONCE, deps({ fetch: serving(200, "something else") }))).resolves.toEqual({
      ok: false,
      reason: "file_wrong_content",
    });
  });

  // Scenario 6 — and the refusal must not say WHICH check fired, or
  // verification becomes the address oracle STORY-131 exists to deny.
  it("scenario 6 — a guard refusal is reported without leaking the reason", async () => {
    const d = deps({ fetch: vi.fn(async () => { throw new GuardedFetchRefusal("address_not_global"); }) });
    const result = await checkWellKnownFile("internal.corp", NONCE, d);

    expect(result).toEqual({ ok: false, reason: "fetch_refused" });
    expect(JSON.stringify(result)).not.toContain("address_not_global");
  });
});

describe("STORY-048 · meta tag", () => {
  it("scenario 2 — succeeds on a correct tag", async () => {
    const html = `<html><head><meta name="nominara-verify" content="${NONCE}"></head></html>`;
    await expect(checkMetaTag(DOMAIN, NONCE, deps({ fetch: serving(200, html) }))).resolves.toEqual({ ok: true });
  });

  it("accepts the attributes in either order", async () => {
    const html = `<html><head><meta content="${NONCE}" name="nominara-verify"></head></html>`;
    await expect(checkMetaTag(DOMAIN, NONCE, deps({ fetch: serving(200, html) }))).resolves.toEqual({ ok: true });
  });

  it("scenario 3 — no tag fails with tag_absent", async () => {
    await expect(checkMetaTag(DOMAIN, NONCE, deps({ fetch: serving(200, "<html></html>") }))).resolves.toEqual({
      ok: false,
      reason: "tag_absent",
    });
  });

  it("distinguishes a wrong value from an absent tag", async () => {
    const html = `<html><head><meta name="nominara-verify" content="someone-elses-nonce"></head></html>`;
    await expect(checkMetaTag(DOMAIN, NONCE, deps({ fetch: serving(200, html) }))).resolves.toEqual({
      ok: false,
      reason: "tag_wrong_value",
    });
  });

  it("scenario 6 — a guard refusal is reported without leaking the reason", async () => {
    const d = deps({ fetch: vi.fn(async () => { throw new GuardedFetchRefusal("address_not_global"); }) });
    await expect(checkMetaTag("127.0.0.1", NONCE, d)).resolves.toEqual({ ok: false, reason: "fetch_refused" });
  });
});

// Review finding — a failure on OUR side is not evidence the customer removed the proof. The periodic sweep
// must be able to tell the two apart, so every checker marks it `inconclusive`.
describe("STORY-048 · inconclusive outcomes (our outage is not their absence)", () => {
  const code = (c: string) => Object.assign(new Error(c), { code: c });

  it.each(["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", "EREFUSED"])("a resolver %s is inconclusive", async (c) => {
    const d = deps({ resolveTxt: vi.fn(async () => { throw code(c); }) });
    await expect(checkDnsTxt(DOMAIN, NONCE, d)).resolves.toEqual({ ok: false, reason: "record_absent", inconclusive: true });
  });

  it.each(["ENOTFOUND", "ENODATA"])("a resolver %s is conclusive absence", async (c) => {
    const d = deps({ resolveTxt: vi.fn(async () => { throw code(c); }) });
    await expect(checkDnsTxt(DOMAIN, NONCE, d)).resolves.toEqual({ ok: false, reason: "record_absent" });
  });

  // AC7 review: a failure on the TARGET's side (connect, TLS, timeout, 5xx) is what a domain that changed hands looks
  // like, so it is conclusive (the manual path and the sweep clear verified_at, as on main). Only OUR resolver is
  // inconclusive, until the owner decides a grace period.
  it.each([
    ["socket hang up"],
    ["ETIMEDOUT"],
    ["ECONNREFUSED"],
    ["CERT_HAS_EXPIRED"],
  ])("a target-side %s fetching the file is conclusive", async (message) => {
    const d = deps({ fetch: vi.fn(async () => { throw new Error(message); }) });
    await expect(checkWellKnownFile(DOMAIN, NONCE, d)).resolves.toEqual({ ok: false, reason: "file_absent" });
  });

  it.each([500, 502, 503, 429, 408])("a %d fetching the file or tag is conclusive", async (status) => {
    await expect(checkWellKnownFile(DOMAIN, NONCE, deps({ fetch: serving(status, "") }))).resolves.toEqual({
      ok: false, reason: "file_absent",
    });
    await expect(checkMetaTag(DOMAIN, NONCE, deps({ fetch: serving(status, "") }))).resolves.toEqual({
      ok: false, reason: "tag_absent",
    });
  });

  it.each(["ETIMEDOUT", "ECONNREFUSED", "CERT_HAS_EXPIRED"])("a target-side %s fetching the root page is conclusive", async (message) => {
    const d = deps({ fetch: vi.fn(async () => { throw new Error(message); }) });
    await expect(checkMetaTag(DOMAIN, NONCE, d)).resolves.toEqual({ ok: false, reason: "tag_absent" });
  });

  it("a 404 and a guard refusal stay conclusive", async () => {
    await expect(checkMetaTag(DOMAIN, NONCE, deps({ fetch: serving(404, "") }))).resolves.toEqual({ ok: false, reason: "tag_absent" });
    const refuse = deps({ fetch: vi.fn(async () => { throw new GuardedFetchRefusal("address_not_global"); }) });
    await expect(checkMetaTag(DOMAIN, NONCE, refuse)).resolves.toEqual({ ok: false, reason: "fetch_refused" });
  });
});

describe("STORY-048 review r3 · a non-object rejection from the resolver", () => {
  it.each([undefined, null, "boom", 42])("dns_txt · rejecting with %s is inconclusive, never a TypeError", async (reason) => {
    const outcome = await checkDnsTxt("site.test", "n1", {
      resolveTxt: () => Promise.reject(reason),
      fetch: async () => {
        throw new Error("no http");
      },
    });
    expect(outcome).toMatchObject({ ok: false, inconclusive: true });
  });
});
