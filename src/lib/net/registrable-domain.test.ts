import { describe, expect, it } from "vitest";
import { hostIsIpLiteral, toRegistrableDomain, UnparsableHostError } from "./registrable-domain.js";

// STORY-131 scenarios 1, 16, 17.
describe("STORY-131 · registrable domain", () => {
  it("derives the registrable domain from a plain URL", () => {
    expect(toRegistrableDomain("https://hubspot.com")).toBe("hubspot.com");
    expect(toRegistrableDomain("https://hubspot.com/pricing")).toBe("hubspot.com");
  });

  // The reason the dependency was signed off. Naive last-two-labels gives
  // `co.uk` here, and every .co.uk customer would share one root_domain.
  it.each([
    ["https://www.bbc.co.uk/news?utm_source=x#frag", "bbc.co.uk"],
    ["https://shop.example.com.au/", "example.com.au"],
    ["https://foo.co.jp/", "foo.co.jp"],
    ["https://a.b.c.example.co.uk/deep/path", "example.co.uk"],
  ])("%s -> %s (multi-label public suffix)", (input, expected) => {
    expect(toRegistrableDomain(input)).toBe(expected);
  });

  it("discards www, subdomains, path, query, fragment and port", () => {
    expect(toRegistrableDomain("https://www.hubspot.com:443/a/b?utm_source=x&gclid=y#z")).toBe("hubspot.com");
    expect(toRegistrableDomain("http://blog.eng.hubspot.com/post")).toBe("hubspot.com");
  });

  it("lowercases", () => {
    expect(toRegistrableDomain("https://HubSpot.COM/")).toBe("hubspot.com");
  });

  // A bare public suffix is a string a caller can send and not a site anyone
  // owns; accepting it would create a project whose root_domain is `co.uk`.
  it("refuses a bare public suffix", () => {
    expect(() => toRegistrableDomain("https://co.uk/")).toThrow(UnparsableHostError);
    expect(() => toRegistrableDomain("https://com/")).toThrow(UnparsableHostError);
  });

  it("refuses an IP literal", () => {
    expect(() => toRegistrableDomain("http://127.0.0.1/")).toThrow(UnparsableHostError);
    expect(() => toRegistrableDomain("http://[::1]/")).toThrow(UnparsableHostError);
  });

  // Deliberately NOT refused. tldts treats an unknown single-label TLD as a
  // valid suffix, so this returns `foo.invalidtld` rather than throwing, and
  // that is the behaviour we want: whether a TLD exists is DNS's question, and
  // assertSafeUrl already asks it (`dns_resolution_failed`). Requiring an ICANN
  // suffix here would instead refuse a legitimately NEW TLD whenever our
  // bundled public-suffix list is stale — refusing a real customer's real
  // domain, which is a far worse failure than briefly accepting a hostname DNS
  // is about to reject anyway.
  it("accepts an unlisted TLD and leaves its existence to DNS", () => {
    expect(toRegistrableDomain("http://foo.invalidtld/")).toBe("foo.invalidtld");
  });

  it("identifies an IP literal host", () => {
    expect(hostIsIpLiteral("http://127.0.0.1/")).toBe(true);
    expect(hostIsIpLiteral("https://hubspot.com/")).toBe(false);
  });
});
