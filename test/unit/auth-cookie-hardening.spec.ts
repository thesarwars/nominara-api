import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as cookieModule from "../../src/lib/auth/cookies.js";
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  OAUTH_BINDING_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  clearAuthCookies,
  clearOauthBindingCookie,
  setAuthCookies,
  setOauthBindingCookie,
} from "../../src/lib/auth/cookies.js";

// STORY-171 — a browser REJECTS any `__Host-` Set-Cookie that lacks `Secure`
// (RFC 6265bis cookie prefixes), and `inject()` applies no such rule. The
// logout deletion was emitted WITHOUT `Secure`, so in a real browser it was
// ignored and the 30-day refresh cookie survived logout. These tests therefore
// apply the browser's prefix rule themselves to the raw Set-Cookie header
// strings. Registered exactly like src/api/register-cookies.ts: no options.

interface ParsedSetCookie {
  readonly name: string;
  readonly value: string;
  readonly attrs: ReadonlyMap<string, string | true>;
  readonly raw: string;
}

function parseSetCookie(raw: string): ParsedSetCookie {
  const [pair, ...rest] = raw.split(";").map((part) => part.trim());
  const eq = pair!.indexOf("=");
  const attrs = new Map<string, string | true>();
  for (const part of rest) {
    const i = part.indexOf("=");
    if (i === -1) attrs.set(part.toLowerCase(), true);
    else attrs.set(part.slice(0, i).toLowerCase(), part.slice(i + 1));
  }
  return { name: pair!.slice(0, eq), value: pair!.slice(eq + 1), attrs, raw };
}

/** Reasons a browser would reject (or a reviewer would flag) this Set-Cookie. */
function prefixViolations(c: ParsedSetCookie): string[] {
  const problems: string[] = [];
  // Default is "report": a cookie that is NOT `__Host-` is itself a finding,
  // because every auth-flow cookie is meant to carry the prefix.
  if (!c.name.startsWith("__Host-")) problems.push(`${c.name}: not __Host- prefixed`);
  if (!c.attrs.has("secure")) problems.push(`${c.name}: missing Secure`);
  if (c.attrs.get("path") !== "/") problems.push(`${c.name}: Path is not /`);
  if (c.attrs.has("domain")) problems.push(`${c.name}: carries Domain`);
  return problems;
}

function isExpiration(c: ParsedSetCookie): boolean {
  if (c.attrs.get("max-age") === "0") return true;
  const expires = c.attrs.get("expires");
  return typeof expires === "string" && new Date(expires).getTime() <= Date.now();
}

const app = Fastify();

beforeAll(async () => {
  await app.register(fastifyCookie);
  app.get("/set-auth", (_req, reply) => {
    setAuthCookies(reply, { accessToken: "a", refreshToken: "r", csrfToken: "c" });
    return reply.send();
  });
  app.get("/clear-auth", (_req, reply) => {
    clearAuthCookies(reply);
    return reply.send();
  });
  app.get("/set-binding", (_req, reply) => {
    setOauthBindingCookie(reply, "b", 600);
    return reply.send();
  });
  app.get("/clear-binding", (_req, reply) => {
    clearOauthBindingCookie(reply);
    return reply.send();
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function setCookies(url: string): Promise<ParsedSetCookie[]> {
  const res = await app.inject({ method: "GET", url });
  const header = res.headers["set-cookie"];
  const list = header === undefined ? [] : Array.isArray(header) ? header : [header];
  return list.map(parseSetCookie);
}

describe("STORY-171 · clearing a __Host- cookie carries the same hardening as setting it", () => {
  it("STORY-171 · clearAuthCookies emits a Secure, Path=/, Domain-less expiration for each of the three auth cookies", async () => {
    const cleared = await setCookies("/clear-auth");
    expect(cleared.map((c) => c.name).sort()).toEqual([ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, REFRESH_COOKIE_NAME].sort());
    for (const c of cleared) {
      expect(prefixViolations(c), c.raw).toEqual([]);
      expect(isExpiration(c), c.raw).toBe(true);
      expect(c.value).toBe("");
    }
  });

  it("STORY-171 · clearOauthBindingCookie emits a Secure, Path=/, Domain-less expiration", async () => {
    const cleared = await setCookies("/clear-binding");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.name).toBe(OAUTH_BINDING_COOKIE_NAME);
    expect(prefixViolations(cleared[0]!), cleared[0]!.raw).toEqual([]);
    expect(isExpiration(cleared[0]!), cleared[0]!.raw).toBe(true);
  });

  it("STORY-171 · each clear targets the same cookie as its set (HttpOnly and SameSite match)", async () => {
    const pairs: [string, string][] = [
      ["/set-auth", "/clear-auth"],
      ["/set-binding", "/clear-binding"],
    ];
    for (const [setUrl, clearUrl] of pairs) {
      const set = new Map((await setCookies(setUrl)).map((c) => [c.name, c]));
      for (const cleared of await setCookies(clearUrl)) {
        const original = set.get(cleared.name);
        expect(original, `${cleared.name} has a matching set`).toBeDefined();
        expect(cleared.attrs.has("httponly")).toBe(original!.attrs.has("httponly"));
        expect(cleared.attrs.get("samesite")).toBe(original!.attrs.get("samesite"));
      }
    }
  });
});

describe("STORY-171 · generic guard over every Set-Cookie the auth cookie helpers produce", () => {
  it("STORY-171 · every set and every clear satisfies the __Host- prefix rule", async () => {
    const all = (await Promise.all(["/set-auth", "/clear-auth", "/set-binding", "/clear-binding"].map(setCookies))).flat();
    expect(all.length).toBe(8);
    expect(all.flatMap(prefixViolations)).toEqual([]);
  });

  it("STORY-171 · every exported cookie name is both set and cleared (a new cookie without a clear is reported)", async () => {
    const exported = Object.entries(cookieModule)
      .filter(([key, value]) => key.endsWith("_COOKIE_NAME") && typeof value === "string")
      .map(([, value]) => value as string);
    const cleared = new Set([...(await setCookies("/clear-auth")), ...(await setCookies("/clear-binding"))].map((c) => c.name));
    const set = new Set([...(await setCookies("/set-auth")), ...(await setCookies("/set-binding"))].map((c) => c.name));
    expect(exported.filter((n) => !cleared.has(n))).toEqual([]);
    expect(exported.filter((n) => !set.has(n))).toEqual([]);
  });

  it("STORY-171 · the guard itself reports a __Host- cookie lacking Secure, a Domain, a wrong Path, or no prefix", () => {
    expect(prefixViolations(parseSetCookie("__Host-x=; Max-Age=0; Path=/"))).toEqual(["__Host-x: missing Secure"]);
    expect(prefixViolations(parseSetCookie("__Host-x=; Path=/; Secure; Domain=a.com"))).toEqual(["__Host-x: carries Domain"]);
    expect(prefixViolations(parseSetCookie("__Host-x=; Path=/a; Secure"))).toEqual(["__Host-x: Path is not /"]);
    expect(prefixViolations(parseSetCookie("plain=; Path=/; Secure"))).toEqual(["plain: not __Host- prefixed"]);
    expect(prefixViolations(parseSetCookie("__Host-x=; Path=/; Secure"))).toEqual([]);
  });
});
