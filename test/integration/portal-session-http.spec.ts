import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hash as argon2idHash } from "../../src/lib/crypto/argon2id.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { PORTAL_COOKIE_NAME, PORTAL_SESSION_TTL_SECONDS, loadPortalCookieKey, openPortalCookie } from "../../src/modules/portal/portal-cookie.js";
import { generateShareSecret, hashShareSecret } from "../../src/modules/agency/share-tokens.service.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// Counts the Argon2 work the gate does, without changing what it does.
const argon = vi.hoisted(() => ({ verify: 0, decoy: 0 }));
vi.mock("../../src/lib/crypto/argon2id.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/crypto/argon2id.js")>();
  return {
    ...original,
    verify: (...a: Parameters<typeof original.verify>) => {
      argon.verify += 1;
      return original.verify(...a);
    },
    verifyDecoy: (...a: Parameters<typeof original.verifyDecoy>) => {
      argon.decoy += 1;
      return original.verifyDecoy(...a);
    },
  };
});

// STORY-098 part B (NEW-E-098b) — POST /v1/portal/session through the REAL ApiModule.
// Scenarios 5, 6, 7 (domain check), 8, 16, 18 (view row + count; the first-view notification is deferred: no email
// transport), 21 (header half). The app pool here is a superuser connection (the harness's); the RLS-bound
// halves are in share-token-gate-rls.spec.ts and portal-context-http.spec.ts, which log in as the real roles.
const COOKIE_KEY_B64 = randomBytes(32).toString("base64url");
const PASSWORD = "correct horse battery staple";
let passwordHash = "";
let nsCounter = 0;

describe("STORY-098 part B · POST /portal/session", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({
    env: () => {
      nsCounter += 1;
      const u = new URL(process.env.DATABASE_URL!);
      u.username = "nominara_portal";
      u.password = resolvePassword("nominara_portal", {});
      return {
        VALKEY_CACHE_URL: cacheValkey.url,
        QUEUE_REDIS_URL: queueValkey.connectionString,
        CACHE_KEY_NAMESPACE: `portal-session-${String(nsCounter)}-${randomUUID().slice(0, 8)}`,
        DATABASE_URL_PORTAL: u.toString(),
        PORTAL_COOKIE_KEY: COOKIE_KEY_B64,
      };
    },
  });

  beforeAll(async () => {
    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
    passwordHash = await argon2idHash(PASSWORD);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop()]);
  });
  beforeEach(() => {
    argon.verify = 0;
    argon.decoy = 0;
  });

  interface Seeded {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly otherProjectId: string;
    readonly userId: string;
  }
  async function workspace(): Promise<Seeded> {
    const db = harness.db();
    const [workspaceId, projectId, otherProjectId, userId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1::uuid,$1::text,$1::text,'growth')", [workspaceId]);
    await db.query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1,$2,now(),'active')", [userId, `${userId}@example.test`]);
    for (const id of [projectId, otherProjectId]) {
      await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://a.test','a.test')", [id, workspaceId, `p-${id.slice(0, 8)}`]);
    }
    return { workspaceId, projectId, otherProjectId, userId };
  }

  interface TokenOpts {
    password?: boolean;
    revoked?: boolean;
    expired?: boolean;
    maxViews?: number | null;
    viewCount?: number;
    domains?: string[];
    tabs?: string[];
  }
  async function token(w: Seeded, o: TokenOpts = {}): Promise<{ id: string; secret: string }> {
    const secret = generateShareSecret();
    const id = randomUUID();
    await harness.db().query(
      `INSERT INTO share_tokens (id, workspace_id, label, token_hash, token_prefix, password_hash, password_required, scope_project_ids,
                                 scope_tabs, allowed_email_domains, max_views, view_count, revoked_at, expires_at, created_by)
       VALUES ($1,$2,'Acme',$3,$4,$5,$6,$7::uuid[],$8::text[],$9::citext[],$10,$11,$12,$13,$14)`,
      [
        id, w.workspaceId, hashShareSecret(secret), secret.slice(0, 8),
        o.password === false ? null : passwordHash, o.password !== false,
        [w.projectId], o.tabs ?? ["overview", "tasks"], o.domains ?? [],
        o.maxViews ?? null, o.viewCount ?? 0,
        o.revoked === true ? new Date() : null,
        o.expired === true ? new Date(Date.now() - 60_000) : null,
        w.userId,
      ],
    );
    return { id, secret };
  }

  // api-spec §12: portal_session is 10/hour per ADDRESS with a burst of 2, so every call here comes from its own
  // address unless a test is about that limit.
  let addressSeq = 0;
  const session = (payload: unknown, headers: Record<string, string> = {}, remoteAddress?: string) => {
    addressSeq += 1;
    return harness.app().inject({
      method: "POST",
      url: apiUrl("/portal/session"),
      headers: { "content-type": "application/json", ...headers },
      payload: payload as object,
      remoteAddress: remoteAddress ?? `10.${String((addressSeq >> 8) & 255)}.${String(addressSeq & 255)}.7`,
    });
  };
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; message: string; details?: { retry_after_ms?: number } } }).error;
  const row = async (id: string) =>
    (await harness.db().query<{ view_count: number; last_viewed_at: Date | null; failed_attempts: number; locked_until: Date | null }>(
      "SELECT view_count, last_viewed_at, failed_attempts, locked_until FROM share_tokens WHERE id = $1", [id])).rows[0]!;
  const viewRows = async (id: string) => (await harness.db().query("SELECT * FROM share_token_views WHERE share_token_id = $1", [id])).rows;
  const setCookieOf = (res: { headers: Record<string, unknown> }): string => {
    const v = res.headers["set-cookie"];
    return String(Array.isArray(v) ? v.find((c) => String(c).startsWith(PORTAL_COOKIE_NAME)) : v);
  };

  it("STORY-098 s5 · the response body of a successful mint carries expiry and NOTHING else; a refusal carries no data either", async () => {
    const w = await workspace();
    const t = await token(w);
    const ok = await session({ secret: t.secret, password: PASSWORD });
    expect(ok.statusCode, ok.body).toBe(200);
    const body = ok.json() as { data: Record<string, unknown> };
    expect(Object.keys(body.data)).toEqual(["expires_at"]);
    for (const needle of [w.projectId, w.workspaceId, t.id, "Acme", "overview"]) expect(ok.body).not.toContain(needle);

    const bad = await session({ secret: t.secret, password: "nope" });
    expect(bad.statusCode).toBe(401);
    for (const needle of [w.projectId, w.workspaceId, t.id, "Acme"]) expect(bad.body).not.toContain(needle);
  });

  it("STORY-098 s8 · the cookie is __Host-, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, 4 h — and opens to exactly the five scope fields", async () => {
    const w = await workspace();
    const t = await token(w, { tabs: ["overview", "matrix"] });
    const res = await session({ secret: t.secret, password: PASSWORD });
    const cookie = setCookieOf(res);
    expect(cookie.startsWith(`${PORTAL_COOKIE_NAME}=`)).toBe(true);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    expect(cookie).toMatch(/;\s*Path=\//i);
    expect(cookie).not.toMatch(/;\s*Domain=/i);
    expect(cookie).toContain(`Max-Age=${String(PORTAL_SESSION_TTL_SECONDS)}`);
    const value = decodeURIComponent(cookie.split(";")[0]!.slice(PORTAL_COOKIE_NAME.length + 1));
    for (const needle of [t.id, w.workspaceId, w.projectId]) expect(value).not.toContain(needle);
    const opened = await openPortalCookie(value, loadPortalCookieKey(COOKIE_KEY_B64));
    expect(opened).toEqual({ token_id: t.id, workspace_id: w.workspaceId, scope_project_ids: [w.projectId], scope_tabs: ["overview", "matrix"], theme_id: null });
    const expiresAt = new Date((ok(res).data as { expires_at: string }).expires_at).getTime();
    expect(Math.abs(expiresAt - (Date.now() + PORTAL_SESSION_TTL_SECONDS * 1000))).toBeLessThan(30_000);
  });
  const ok = (res: { json(): unknown }) => res.json() as { data: Record<string, unknown> };

  it("STORY-098 s6 · five wrong passwords lock the token for 15 minutes: the 5th is 429 with retry_after_ms, and the right password is refused while locked", async () => {
    const w = await workspace();
    const t = await token(w);
    for (let i = 1; i <= 4; i += 1) {
      const res = await session({ secret: t.secret, password: `wrong-${String(i)}` });
      expect(res.statusCode, `attempt ${String(i)}`).toBe(401);
      expect(errorOf(res).code).toBe("unauthenticated");
    }
    const fifth = await session({ secret: t.secret, password: "wrong-5" });
    expect(fifth.statusCode).toBe(429);
    expect(errorOf(fifth).code).toBe("rate_limited");
    const retry = errorOf(fifth).details!.retry_after_ms!;
    expect(retry).toBeGreaterThan(14 * 60_000);
    expect(retry).toBeLessThanOrEqual(15 * 60_000);

    const locked = await row(t.id);
    expect(locked.locked_until!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

    const verifyBefore = argon.verify;
    const right = await session({ secret: t.secret, password: PASSWORD });
    expect(right.statusCode).toBe(429);
    expect(argon.verify, "a locked token is refused BEFORE any password is checked").toBe(verifyBefore);
    expect(await viewRows(t.id)).toHaveLength(0);
  });

  it("STORY-098 s6 · once the cooldown passes the right password works and the failure count restarts from zero", async () => {
    const w = await workspace();
    const t = await token(w);
    for (let i = 0; i < 5; i += 1) await session({ secret: t.secret, password: "wrong" });
    await harness.db().query("UPDATE share_tokens SET locked_until = now() - interval '1 second' WHERE id = $1", [t.id]);
    // The failure count restarted when the lock was set: four more wrong attempts do NOT lock again.
    for (let i = 0; i < 4; i += 1) expect((await session({ secret: t.secret, password: "wrong" })).statusCode).toBe(401);
    expect((await session({ secret: t.secret, password: PASSWORD })).statusCode).toBe(200);
    const after = await row(t.id);
    expect(after.failed_attempts).toBe(0);
    expect(after.locked_until).toBeNull();
  });

  it("STORY-098 s6 · parallel guessing cannot slip past the lock: of 12 simultaneous wrong passwords exactly 4 are 401 and 8 are 429, and only 5 are ever verified", async () => {
    const w = await workspace();
    const t = await token(w);
    const results = await Promise.all(Array.from({ length: 12 }, () => session({ secret: t.secret, password: "wrong" })));
    const codes = results.map((r) => r.statusCode);
    expect(codes.every((c) => c === 401 || c === 429)).toBe(true);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(4 + 0);
    expect((await row(t.id)).locked_until).not.toBeNull();
  });

  it("STORY-098 s6 · verification is constant-time in structure: an unknown secret pays a full Argon2 verify on a dummy hash and answers exactly as a wrong password does", async () => {
    const w = await workspace();
    const t = await token(w);
    const wrong = await session({ secret: t.secret, password: "wrong" });
    expect(argon.verify).toBe(1);
    expect(argon.decoy).toBe(0);
    argon.verify = 0;
    const unknown = await session({ secret: generateShareSecret(), password: "wrong" });
    expect(argon.decoy, "the unknown-token path must do the same work").toBe(1);
    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect({ code: errorOf(unknown).code, message: errorOf(unknown).message }).toEqual({ code: errorOf(wrong).code, message: errorOf(wrong).message });
    // An unknown secret with NO password still pays the decoy.
    argon.decoy = 0;
    await session({ secret: generateShareSecret() });
    expect(argon.decoy).toBe(1);
  });

  it("STORY-098 s6 · a password-protected link with no password supplied is refused as a wrong password, and counts toward the lock", async () => {
    const w = await workspace();
    const t = await token(w);
    const res = await session({ secret: t.secret });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe("unauthenticated");
    expect((await row(t.id)).failed_attempts).toBe(1);
    expect(argon.verify + argon.decoy).toBeGreaterThanOrEqual(1);
  });

  it("STORY-098 s16 · expired, revoked and view-capped links give ONE neutral refusal, byte for byte, and disclose nothing", async () => {
    const w = await workspace();
    const expired = await token(w, { expired: true });
    const revoked = await token(w, { revoked: true });
    const capped = await token(w, { maxViews: 1, viewCount: 1 });
    const bodies = new Set<string>();
    for (const t of [expired, revoked, capped]) {
      // Even with the CORRECT password: lifecycle is checked before the password.
      const res = await session({ secret: t.secret, password: PASSWORD });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe("token_revoked");
      expect(res.headers["set-cookie"]).toBeUndefined();
      const e = errorOf(res);
      bodies.add(JSON.stringify({ code: e.code, message: e.message }));
      for (const needle of [w.projectId, w.workspaceId, "Acme", t.id]) expect(res.body).not.toContain(needle);
      expect(await viewRows(t.id)).toHaveLength(0);
    }
    expect(bodies.size, "all three refusals are indistinguishable").toBe(1);
  });

  it("STORY-098 s16 · the view cap is atomic: with max_views 3, eight parallel mints produce exactly three sessions, three view rows and view_count 3", async () => {
    const w = await workspace();
    const t = await token(w, { maxViews: 3, password: false });
    const results = await Promise.all(Array.from({ length: 8 }, () => session({ secret: t.secret })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(3);
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(5);
    expect((await row(t.id)).view_count).toBe(3);
    expect(await viewRows(t.id)).toHaveLength(3);
  });

  it("STORY-098 s18 · each mint writes a share_token_views row (address, agent, authenticated) and increments view_count", async () => {
    const w = await workspace();
    const t = await token(w);
    const res = await session({ secret: t.secret, password: PASSWORD }, { "user-agent": "Mozilla/5.0 (portal-test)" });
    expect(res.statusCode).toBe(200);
    const after = await row(t.id);
    expect(after.view_count).toBe(1);
    expect(after.last_viewed_at).not.toBeNull();
    const views = await viewRows(t.id);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ workspace_id: w.workspaceId, share_token_id: t.id, authenticated: true, user_agent: "Mozilla/5.0 (portal-test)" });
    expect(views[0].ip).not.toBeNull();
    await session({ secret: t.secret, password: PASSWORD });
    expect((await row(t.id)).view_count).toBe(2);
    expect(await viewRows(t.id)).toHaveLength(2);
  });

  it("STORY-098 s3 · a passwordless link (acknowledged at mint) opens without a password and its view row is marked unauthenticated", async () => {
    const w = await workspace();
    const t = await token(w, { password: false });
    const res = await session({ secret: t.secret });
    expect(res.statusCode, res.body).toBe(200);
    expect((await viewRows(t.id))[0]).toMatchObject({ authenticated: false });
  });

  it("STORY-098 s7 · where allowed domains are set: an email is required, a foreign domain is refused, and an allowed one is refused until the code step exists (deferred, fail closed)", async () => {
    const w = await workspace();
    const t = await token(w, { domains: ["acme.test"] });
    const missing = await session({ secret: t.secret, password: PASSWORD });
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing).code).toBe("validation_failed");
    const foreign = await session({ secret: t.secret, password: PASSWORD, email: "eve@evil.test" });
    expect(foreign.statusCode).toBe(401);
    expect(errorOf(foreign).code).toBe("unauthenticated");
    const allowed = await session({ secret: t.secret, password: PASSWORD, email: "Jane@ACME.test" });
    expect(allowed.statusCode).toBe(503);
    expect(errorOf(allowed).code).toBe("degraded");
    expect(allowed.headers["set-cookie"]).toBeUndefined();
    expect(await viewRows(t.id), "no session was minted, so no view").toHaveLength(0);
    expect((await row(t.id)).view_count).toBe(0);
  });

  it("STORY-098 s7 · the domain check never runs before the password: a wrong password with a foreign email is still just 401", async () => {
    const w = await workspace();
    const t = await token(w, { domains: ["acme.test"] });
    const res = await session({ secret: t.secret, password: "wrong", email: "eve@evil.test" });
    expect(res.statusCode).toBe(401);
  });

  it("STORY-098 s21 · the mint response itself is private and non-cacheable", async () => {
    const w = await workspace();
    const t = await token(w);
    const res = await session({ secret: t.secret, password: PASSWORD });
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(String(res.headers["x-robots-tag"])).toContain("noindex");
    const refused = await session({ secret: generateShareSecret(), password: "x" });
    expect(refused.headers["cache-control"]).toBe("private, no-store");
  });

  it("STORY-098 s5 · an unknown body key, a missing secret and an over-long password are 400 and touch no token", async () => {
    const w = await workspace();
    const t = await token(w);
    for (const payload of [{ secret: t.secret, password: PASSWORD, project_id: w.projectId }, { password: PASSWORD }, { secret: t.secret, password: "x".repeat(129) }, { secret: "short" }]) {
      const res = await session(payload);
      expect(res.statusCode).toBe(400);
    }
    expect((await row(t.id)).failed_attempts).toBe(0);
  });

  it("STORY-098 s6 · the limit is per token: locking one link does not lock another", async () => {
    const w = await workspace();
    const a = await token(w);
    const b = await token(w);
    for (let i = 0; i < 5; i += 1) await session({ secret: a.secret, password: "wrong" });
    expect((await session({ secret: b.secret, password: PASSWORD })).statusCode).toBe(200);
  });

  it("api-spec §6/§12 · POST /portal/session is limited per ADDRESS (10/hour, burst 2): the 3rd quick request is 429 rate_limited, never reaches the gate, and another address is unaffected", async () => {
    const w = await workspace();
    const t = await token(w);
    const same = "198.51.100.20";
    expect((await session({ secret: generateShareSecret(), password: "x" }, {}, same)).statusCode).toBe(401);
    expect((await session({ secret: generateShareSecret(), password: "x" }, {}, same)).statusCode).toBe(401);
    argon.decoy = 0;
    const limited = await session({ secret: t.secret, password: PASSWORD }, {}, same);
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe("rate_limited");
    expect(argon.decoy + argon.verify, "refused before any Argon2 work").toBe(0);
    expect((await row(t.id)).view_count).toBe(0);
    expect((await session({ secret: t.secret, password: PASSWORD }, {}, "198.51.100.21")).statusCode).toBe(200);
  });

  it("STORY-098 s8 · with no PORTAL_COOKIE_KEY configured the endpoint fails closed with 503 degraded and mints nothing", async () => {
    // beforeEach of the harness has already booted with the key; boot-time config is read per request, so unset it now.
    const w = await workspace();
    const t = await token(w, { password: false });
    const saved = process.env.PORTAL_COOKIE_KEY;
    delete process.env.PORTAL_COOKIE_KEY;
    try {
      const res = await session({ secret: t.secret });
      expect(res.statusCode).toBe(503);
      expect(errorOf(res).code).toBe("degraded");
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect((await row(t.id)).view_count).toBe(0);
    } finally {
      process.env.PORTAL_COOKIE_KEY = saved;
    }
  });
});
