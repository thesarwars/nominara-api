import { describe, expect, it } from "vitest";
import { classifyReferrer, countryFromHeader, deviceFromUserAgent, InvalidLandingUrlError, normalizeLanding, withoutQueryAndFragment, UNKNOWN_COUNTRY } from "./beacon-dimensions.js";

const LANDING = "https://shop.example.com/guide";

describe("STORY-113 - referrer classification (AC: documented classes, other_ai, unattributed first-class)", () => {
  it.each([
    ["https://chatgpt.com/", "chatgpt"],
    ["https://chat.openai.com/c/abc", "chatgpt"],
    ["https://www.perplexity.ai/search?q=x", "perplexity"],
    ["https://gemini.google.com/app", "gemini"],
    ["https://claude.ai/chat/1", "claude"],
    ["https://copilot.microsoft.com/", "copilot"],
    ["https://www.meta.ai/", "meta_ai"],
  ])("S3 %s is recognised as %s", (referrer, expected) => {
    expect(classifyReferrer(referrer, LANDING)).toBe(expected);
  });

  it("S7 a stripped (empty or absent) referrer lands in the unattributed class, not nowhere", () => {
    expect(classifyReferrer("", LANDING)).toBe("unattributed_direct");
    expect(classifyReferrer(undefined, LANDING)).toBe("unattributed_direct");
    expect(classifyReferrer("not a url at all", LANDING)).toBe("unattributed_direct");
  });

  it("S8 an unrecognised AI host lands in other_ai rather than being dropped", () => {
    expect(classifyReferrer("https://some-new-engine.ai/chat", LANDING)).toBe("other_ai");
    expect(classifyReferrer("https://you.com/search", LANDING)).toBe("other_ai");
  });

  it("a referrer that is neither an AI engine nor absent is not an AI referral", () => {
    expect(classifyReferrer("https://www.google.com/", LANDING)).toBe("non_ai");
    expect(classifyReferrer("https://news.ycombinator.com/", LANDING)).toBe("non_ai");
  });

  it("does not match a host that merely ends in an engine's name", () => {
    expect(classifyReferrer("https://notchatgpt.com/", LANDING)).toBe("non_ai");
    expect(classifyReferrer("https://claude.ai.evil.example/", LANDING)).toBe("non_ai");
  });

  it("the landing URL's utm_source names the engine when the referrer was stripped", () => {
    expect(classifyReferrer("", "https://shop.example.com/guide?utm_source=chatgpt.com")).toBe("chatgpt");
    expect(classifyReferrer("", "https://shop.example.com/guide?utm_source=newsletter")).toBe("unattributed_direct");
  });
});

describe("STORY-113 - the site's own navigation is never an AI referral", () => {
  it("a referrer on the landing page's own host is not an AI session, even when the customer's domain is a .ai one", () => {
    expect(classifyReferrer("https://acme.ai/pricing", "https://acme.ai/guide")).toBe("non_ai");
    expect(classifyReferrer("https://www.acme.ai/", "https://acme.ai/guide")).toBe("non_ai");
    expect(classifyReferrer("https://ACME.ai/", "https://www.acme.ai/guide")).toBe("non_ai");
    expect(classifyReferrer("https://app.acme.ai/", "https://acme.ai/guide")).toBe("other_ai"); // a different host is still classified
    expect(classifyReferrer("https://some-new-engine.ai/chat", "https://acme.ai/guide")).toBe("other_ai");
  });

  it("a same-site referral does not fall through to a utm_source left on the URL", () => {
    expect(classifyReferrer("https://shop.example.com/a", "https://shop.example.com/b?utm_source=chatgpt.com")).toBe("non_ai");
  });
});

describe("STORY-113 - visitor-specific parts of a landing URL are never kept", () => {
  it("drops the whole query and the fragment, keeping scheme, host, port and path", () => {
    expect(withoutQueryAndFragment("https://shop.example.com/reset?token=SECRET&email=a@b.com#x")).toBe("https://shop.example.com/reset");
    expect(withoutQueryAndFragment("https://shop.example.com:8443/a/b?x=1")).toBe("https://shop.example.com:8443/a/b");
    expect(withoutQueryAndFragment("not a url")).toBe("not a url");
  });
});

describe("STORY-113 - landing URL normalisation", () => {
  it("hashes the same normalised form citation_facts.url_hash uses (tracking params and fragment dropped)", () => {
    const a = normalizeLanding("https://WWW.Shop.example.com/guide/?utm_source=chatgpt.com#top");
    const b = normalizeLanding("https://shop.example.com/guide");
    expect(a.url).toBe("https://shop.example.com/guide");
    expect(a.hash.equals(b.hash)).toBe(true);
    expect(a.hash.length).toBe(32);
  });

  it("refuses a non-http(s) or unparsable landing URL", () => {
    expect(() => normalizeLanding("javascript:alert(1)")).toThrow(InvalidLandingUrlError);
    expect(() => normalizeLanding("ftp://example.com/x")).toThrow(InvalidLandingUrlError);
    expect(() => normalizeLanding("nope")).toThrow(InvalidLandingUrlError);
  });
});

describe("STORY-113 - coarse dimensions", () => {
  it("device is one of three categories and the raw agent is never kept", () => {
    expect(deviceFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148")).toBe("mobile");
    expect(deviceFromUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("tablet");
    expect(deviceFromUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36")).toBe("mobile");
    expect(deviceFromUserAgent("Mozilla/5.0 (Linux; Android 14; SM-X900) Safari/537.36")).toBe("tablet");
    expect(deviceFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("desktop");
    expect(deviceFromUserAgent(undefined)).toBe("desktop");
  });

  it("country is a two-letter code from the edge header, else the unknown marker", () => {
    expect(countryFromHeader("de")).toBe("DE");
    expect(countryFromHeader("US")).toBe("US");
    expect(countryFromHeader(undefined)).toBe(UNKNOWN_COUNTRY);
    expect(countryFromHeader("XX")).toBe(UNKNOWN_COUNTRY);
    expect(countryFromHeader("T1")).toBe(UNKNOWN_COUNTRY);
    expect(countryFromHeader("USA")).toBe(UNKNOWN_COUNTRY);
  });
});
