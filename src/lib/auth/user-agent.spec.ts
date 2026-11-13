import { describe, expect, it } from "vitest";
import { MAX_USER_AGENT_LENGTH, describeUserAgent, normalizeUserAgent } from "./user-agent.js";

// STORY-096 AC4/AC7 — the session list shows device and browser parsed from the stored User-Agent. A tiny in-repo parser; no dependency.
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const EDGE_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const SAFARI_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const OPERA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0";
const CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1";

describe("STORY-096 AC4/AC7 · describeUserAgent", () => {
  it.each([
    ["Chrome on macOS", CHROME_MAC, { browser: "Chrome", os: "macOS", device_type: "desktop" }],
    ["Safari on iPhone", SAFARI_IPHONE, { browser: "Safari", os: "iOS", device_type: "mobile" }],
    ["Firefox on Linux", FIREFOX_LINUX, { browser: "Firefox", os: "Linux", device_type: "desktop" }],
    ["Edge (not Chrome) on Windows", EDGE_WIN, { browser: "Edge", os: "Windows", device_type: "desktop" }],
    ["Chrome on Android", CHROME_ANDROID, { browser: "Chrome", os: "Android", device_type: "mobile" }],
    ["Safari on iPad", SAFARI_IPAD, { browser: "Safari", os: "iPadOS", device_type: "tablet" }],
    ["Opera (not Chrome)", OPERA, { browser: "Opera", os: "Windows", device_type: "desktop" }],
    ["Chrome on iOS (CriOS, not Safari)", CHROME_IOS, { browser: "Chrome", os: "iOS", device_type: "mobile" }],
  ])("%s", (_name, ua, expected) => {
    expect(describeUserAgent(ua)).toEqual(expected);
  });

  it("an absent or unrecognisable user agent is null in every field, never a guess", () => {
    const none = { browser: null, os: null, device_type: null };
    expect(describeUserAgent(null)).toEqual(none);
    expect(describeUserAgent("")).toEqual(none);
    expect(describeUserAgent("curl/8.4.0")).toEqual(none);
  });
});

describe("STORY-096 AC4/AC7 · normalizeUserAgent (what is stored)", () => {
  it("keeps an ordinary header untouched", () => {
    expect(normalizeUserAgent(CHROME_MAC)).toBe(CHROME_MAC);
  });
  it("absent, empty and whitespace-only headers store nothing", () => {
    expect(normalizeUserAgent(undefined)).toBeNull();
    expect(normalizeUserAgent("")).toBeNull();
    expect(normalizeUserAgent("   ")).toBeNull();
  });
  it("a repeated header (array) is not stored", () => {
    expect(normalizeUserAgent(["a", "b"])).toBeNull();
  });
  it("is truncated to exactly the column bound, at the boundary", () => {
    expect(normalizeUserAgent("a".repeat(MAX_USER_AGENT_LENGTH))).toHaveLength(MAX_USER_AGENT_LENGTH);
    expect(normalizeUserAgent("a".repeat(MAX_USER_AGENT_LENGTH + 1))).toHaveLength(MAX_USER_AGENT_LENGTH);
    expect(MAX_USER_AGENT_LENGTH).toBe(512);
  });
  it("strips control characters, including NUL, which Postgres text refuses", () => {
    expect(normalizeUserAgent("Mozilla\u0000/5.0\r\n(X)")).toBe("Mozilla/5.0(X)");
  });
});
