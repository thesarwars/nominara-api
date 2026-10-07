import { randomUUID } from "node:crypto";
import { CompactEncrypt, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { PortalCookiePayload } from "../../../contracts/portal/index.js";
import { loadPortalCookieKey, openPortalCookie, PORTAL_COOKIE_NAME, PORTAL_SESSION_TTL_SECONDS, sealPortalCookie } from "./portal-cookie.js";

// STORY-098 scenario 8 — the session cookie is scoped, signed, encrypted, host-prefixed, short-lived.
const KEY = loadPortalCookieKey(Buffer.alloc(32, 9).toString("base64url"));
const OTHER_KEY = loadPortalCookieKey(Buffer.alloc(32, 10).toString("base64url"));

const payload = (): PortalCookiePayload => ({
  token_id: randomUUID(),
  workspace_id: randomUUID(),
  scope_project_ids: [randomUUID(), randomUUID()],
  scope_tabs: ["overview", "tasks"],
  theme_id: randomUUID(),
});

describe("STORY-098 s8 · the portal session cookie", () => {
  it("STORY-098 s8 · the name carries the __Host- prefix and the lifetime is 4 hours", () => {
    expect(PORTAL_COOKIE_NAME.startsWith("__Host-")).toBe(true);
    expect(PORTAL_SESSION_TTL_SECONDS).toBe(4 * 60 * 60);
  });

  it("STORY-098 s8 · a sealed cookie opens to exactly the scope it was sealed with", async () => {
    const p = payload();
    const { value } = await sealPortalCookie(p, KEY);
    expect(await openPortalCookie(value, KEY)).toEqual(p);
  });

  it("STORY-098 s8 · the cookie is encrypted: no identifier appears in it, in the clear or as decoded base64url", async () => {
    const p = payload();
    const { value } = await sealPortalCookie(p, KEY);
    // A compact JWE has five dot-separated parts; a signed-only JWT has three.
    expect(value.split(".")).toHaveLength(5);
    const decoded = value.split(".").map((part) => Buffer.from(part, "base64url").toString("latin1")).join("|");
    for (const needle of [p.token_id, p.workspace_id, p.theme_id!, ...p.scope_project_ids, "overview"]) {
      expect(value).not.toContain(needle);
      expect(decoded).not.toContain(needle);
    }
  });

  it("STORY-098 s8 · the expiry is 4 hours from now and a cookie past it is refused", async () => {
    const now = new Date("2026-10-07T10:00:00Z");
    const sealed = await sealPortalCookie(payload(), KEY, now);
    expect(sealed.expiresAt.toISOString()).toBe("2026-10-07T14:00:00.000Z");
    expect(await openPortalCookie(sealed.value, KEY, new Date("2026-10-07T13:59:59Z"))).not.toBeNull();
    expect(await openPortalCookie(sealed.value, KEY, new Date("2026-10-07T14:00:01Z"))).toBeNull();
  });

  it("STORY-098 s8 · a cookie sealed under another key, a flipped byte, or garbage opens to nothing", async () => {
    const { value } = await sealPortalCookie(payload(), KEY);
    expect(await openPortalCookie(value, OTHER_KEY)).toBeNull();
    const parts = value.split(".");
    parts[3] = (parts[3]![0] === "A" ? "B" : "A") + parts[3]!.slice(1);
    expect(await openPortalCookie(parts.join("."), KEY)).toBeNull();
    expect(await openPortalCookie("not-a-cookie", KEY)).toBeNull();
    expect(await openPortalCookie("", KEY)).toBeNull();
  });

  it("STORY-098 s8 · encrypted but UNSIGNED content is refused: the inner JWT must carry our signature", async () => {
    // Anyone holding the encryption key alone cannot mint a session; here the key is the same, the signature is not.
    const p = payload();
    const forged = await new SignJWT({ ...p }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("4h").sign(new Uint8Array(32).fill(1));
    const wrapped = await new CompactEncrypt(new TextEncoder().encode(forged)).setProtectedHeader({ alg: "dir", enc: "A256GCM", cty: "JWT" }).encrypt(KEY.enc);
    expect(await openPortalCookie(wrapped, KEY)).toBeNull();
  });

  it("STORY-098 s8 · a payload with a key beyond the five, or a missing scope, is refused (the cookie confers nothing else)", async () => {
    const extra = await sealPortalCookie({ ...payload(), role: "owner" } as unknown as PortalCookiePayload, KEY);
    expect(await openPortalCookie(extra.value, KEY)).toBeNull();
    const empty = await sealPortalCookie({ ...payload(), scope_project_ids: [] }, KEY);
    expect(await openPortalCookie(empty.value, KEY)).toBeNull();
  });

  it("STORY-098 s8 · a key that is not 32 bytes of base64url is refused at load, not at first use", () => {
    expect(() => loadPortalCookieKey("short")).toThrow(/32 bytes/);
    expect(() => loadPortalCookieKey("")).toThrow();
  });
});
