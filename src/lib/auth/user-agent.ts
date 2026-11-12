// STORY-096 AC4/AC7 (owner decision 100(d)) — the session list shows a device and browser, parsed from the User-Agent stored on the session.
// A deliberately tiny parser: the fixed order of checks below is what makes "Edge" not read as "Chrome" and "Chrome on iOS" not read as "Safari".
// Anything it does not recognise is null, never a guess. The header is never logged (it is a fingerprint) and no IP is stored beside it.

export const MAX_USER_AGENT_LENGTH = 512;

/** What is stored: a single, bounded, control-free string, or null. A repeated header (an array) or an empty one stores nothing. */
export function normalizeUserAgent(raw: string | readonly string[] | undefined): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned === "") return null;
  return cleaned.slice(0, MAX_USER_AGENT_LENGTH);
}

export type DeviceType = "desktop" | "mobile" | "tablet";
export interface UserAgentDescription {
  readonly browser: string | null;
  readonly os: string | null;
  readonly device_type: DeviceType | null;
}

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bSafari\/.*\bVersion\/|\bVersion\/.*\bSafari\//, "Safari"],
];

export function describeUserAgent(userAgent: string | null): UserAgentDescription {
  const ua = userAgent ?? "";
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  let os: string | null = null;
  let deviceType: DeviceType | null = null;
  if (/\biPad\b/.test(ua)) {
    os = "iPadOS";
    deviceType = "tablet";
  } else if (/\biPhone\b|\biPod\b/.test(ua)) {
    os = "iOS";
    deviceType = "mobile";
  } else if (/\bAndroid\b/.test(ua)) {
    os = "Android";
    deviceType = /\bMobile\b/.test(ua) ? "mobile" : "tablet";
  } else if (/\bWindows\b/.test(ua)) {
    os = "Windows";
    deviceType = "desktop";
  } else if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) {
    os = "macOS";
    deviceType = "desktop";
  } else if (/\bCrOS\b/.test(ua)) {
    os = "ChromeOS";
    deviceType = "desktop";
  } else if (/\bLinux\b|\bX11\b/.test(ua)) {
    os = "Linux";
    deviceType = "desktop";
  }
  // A browser name with no recognised platform still reads as a browser; an unrecognised everything is all null.
  return { browser, os, device_type: deviceType };
}
