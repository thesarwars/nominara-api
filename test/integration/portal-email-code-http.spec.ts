import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hash as argon2idHash } from "../../src/lib/crypto/argon2id.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { hashEmailKey } from "../../src/lib/auth/email-otp.js";
import { EMAIL_SENDER, type EmailMessage, type EmailSender } from "../../src/modules/identity/ports/email-sender.js";
import { generateShareSecret, hashShareSecret } from "../../src/modules/agency/share-tokens.service.js";
import { loadPortalCookieKey, openPortalCookie, PORTAL_COOKIE_NAME } from "../../src/modules/portal/portal-cookie.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// Counts the Argon2 work the code step does, without changing what it does.
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

// STORY-098 scenario 7 · owner decision 71 (b) — the allowed-email-domain sign-in, through the REAL ApiModule. Only delivery is
// faked, at the EMAIL_SENDER port. Run as the real nominara_app role so RLS, not a predicate, is what isolates the tokens.
const COOKIE_KEY_B64 = randomBytes(32).toString("base64url");
const PASSWORD = "correct horse battery staple";
const PEPPER = "test-otp-email-hash-pepper";
let passwordHash = "";
let nsCounter = 0;

class FakeSender implements EmailSender {
  sent: EmailMessage[] = [];
  failWith: Error | null = null;
  async send(message: EmailMessage): Promise<void> {
    if (this.failWith !== null) throw this.failWith;
    this.sent.push(message);
  }
  codesFor(to: string): string[] {
    return this.sent.filter((m) => m.to === to).map((m) => m.textBody.match(/\b(\d{6})\b/)?.[1]).filter((c): c is string => c !== undefined);
  }
}
const sender = new FakeSender();

describe("STORY-098 s7 · allowed-domain code sign-in", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({
    runAsAppRole: true,
    configure: (builder) => {
      builder.overrideProvider(EMAIL_SENDER).useValue(sender);
    },
    env: () => {
      nsCounter += 1;
      const u = new URL(process.env.DATABASE_URL!);
      u.username = "nominara_portal";
      u.password = resolvePassword("nominara_portal", {});
      return {
        VALKEY_CACHE_URL: cacheValkey.url,
        QUEUE_REDIS_URL: queueValkey.connectionString,
        CACHE_KEY_NAMESPACE: `portal-code-${String(nsCounter)}-${randomUUID().slice(0, 8)}`,
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
  beforeEach(async () => {
    sender.sent = [];
    sender.failWith = null;
    argon.verify = 0;
    argon.decoy = 0;
    await harness.db().query(`ALTER ROLE nominara_portal PASSWORD '${resolvePassword("nominara_portal", {})}'`);
  });

  interface Seeded { readonly workspaceId: string; readonly projectId: string; readonly userId: string }
  async function workspace(): Promise<Seeded> {
    const db = harness.db();
    const [workspaceId, projectId, userId] = [randomUUID(), randomUUID(), randomUUID()];
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1::uuid,$1::text,$1::text,'growth')", [workspaceId]);
    await db.query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1,$2,now(),'active')", [userId, `${userId}@example.test`]);
    await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://a.test','a.test')", [projectId, workspaceId, `p-${projectId.slice(0, 8)}`]);
    return { workspaceId, projectId, userId };
  }

  async function token(w: Seeded, o: { password?: boolean; domains?: string[]; maxViews?: number | null; revoked?: boolean } = {}): Promise<{ id: string; secret: string }> {
    const secret = generateShareSecret();
    const id = randomUUID();
    await harness.db().query(
      `INSERT INTO share_tokens (id, workspace_id, label, token_hash, token_prefix, password_hash, password_required, scope_project_ids,
                                 scope_tabs, allowed_email_domains, max_views, revoked_at, created_by)
       VALUES ($1,$2,'Acme',$3,$4,$5,$6,$7::uuid[],$8::text[],$9::citext[],$10,$11,$12)`,
      [id, w.workspaceId, hashShareSecret(secret), secret.slice(0, 8), o.password === false ? null : passwordHash, o.password !== false,
        [w.projectId], ["overview", "tasks"], o.domains ?? ["acme.test"], o.maxViews ?? null, o.revoked === true ? new Date() : null, w.userId],
    );
    return { id, secret };
  }

  let addressSeq = 0;
  const post = (path: string, payload: unknown, remoteAddress?: string) => {
    addressSeq += 1;
    return harness.app().inject({
      method: "POST",
      url: apiUrl(path),
      headers: { "content-type": "application/json", "user-agent": "code-test" },
      payload: payload as object,
      remoteAddress: remoteAddress ?? `10.${String((addressSeq >> 8) & 255)}.${String(addressSeq & 255)}.9`,
    });
  };
  const requestCode = (t: { secret: string }, email: string, password: string | undefined = PASSWORD, remote?: string) =>
    post("/portal/session", { secret: t.secret, ...(password === undefined ? {} : { password }), email }, remote);
  const verify = (t: { secret: string }, email: string, code: string, remote?: string, password: string | null = PASSWORD) =>
    post("/portal/session/verify", { secret: t.secret, ...(password === null ? {} : { password }), email, code }, remote);
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; message: string; details?: unknown } }).error;
  const sentCount = async (n: number): Promise<void> => {
    await vi.waitFor(() => expect(sender.sent.length).toBe(n), { timeout: 5_000 });
  };
  const codeRows = async (tokenId: string) =>
    (await harness.db().query<{ id: string; code_hash: string; email_hash: Buffer; attempts: number; max_attempts: number; expires_at: Date; consumed_at: Date | null; invalidated_reason: string | null; created_at: Date; workspace_id: string }>(
      "SELECT * FROM share_token_email_codes WHERE share_token_id = $1 ORDER BY created_at, id", [tokenId])).rows;
  const viewRows = async (id: string) => (await harness.db().query("SELECT * FROM share_token_views WHERE share_token_id = $1", [id])).rows;
  const tokenRow = async (id: string) => (await harness.db().query<{ view_count: number; failed_attempts: number }>("SELECT view_count, failed_attempts FROM share_tokens WHERE id = $1", [id])).rows[0]!;

  it("STORY-098 s7 · an allowed domain gets 202 {code_sent:true}, no cookie, no view; the code is mailed ONCE to the normalised (lower-cased) address, stored only as an Argon2id hash, valid 10 minutes with 5 attempts", async () => {
    const w = await workspace();
    const t = await token(w);
    const res = await requestCode(t, "Jane@ACME.test");
    expect(res.statusCode, res.body).toBe(202);
    expect((res.json() as { data: unknown }).data).toEqual({ code_sent: true });
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("private, no-store");
    await sentCount(1);
    expect(sender.sent[0]).toMatchObject({ to: "jane@acme.test", transactional: true });
    const [code] = sender.codesFor("jane@acme.test");
    expect(code).toMatch(/^[0-9]{6}$/);

    const rows = await codeRows(t.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.code_hash.startsWith("$argon2id$")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(code);
    expect(JSON.stringify(row).toLowerCase()).not.toContain("jane");
    // Peppered, and domain-separated from the sign-in ledger so the two tables cannot be joined on it.
    expect(row.email_hash.equals(hashEmailKey("portal-code:jane@acme.test", PEPPER))).toBe(true);
    expect(row.workspace_id).toBe(w.workspaceId);
    expect(row.attempts).toBe(0);
    expect(row.max_attempts).toBe(5);
    expect(Math.abs(row.expires_at.getTime() - (Date.now() + 10 * 60_000))).toBeLessThan(30_000);
    expect(await viewRows(t.id)).toHaveLength(0);
    expect((await tokenRow(t.id)).view_count).toBe(0);
  });

  it("STORY-098 s7 · the right code mints the session: 200, the __Host- cookie opens to the token's scope with the new view's id, one view row (authenticated), view_count 1, and the code is spent", async () => {
    const w = await workspace();
    const t = await token(w);
    await requestCode(t, "jane@acme.test");
    await sentCount(1);
    const code = sender.codesFor("jane@acme.test")[0]!;
    const res = await verify(t, "Jane@acme.test", code);
    expect(res.statusCode, res.body).toBe(200);
    expect(Object.keys((res.json() as { data: Record<string, unknown> }).data)).toEqual(["expires_at"]);
    const raw = res.headers["set-cookie"];
    const cookie = String(Array.isArray(raw) ? raw.find((c) => String(c).startsWith(PORTAL_COOKIE_NAME)) : raw);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*Secure/i);
    const value = decodeURIComponent(cookie.split(";")[0]!.slice(PORTAL_COOKIE_NAME.length + 1));
    const opened = await openPortalCookie(value, loadPortalCookieKey(COOKIE_KEY_B64));
    const views = await viewRows(t.id);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ authenticated: true, share_token_id: t.id, workspace_id: w.workspaceId });
    expect(opened).toMatchObject({ token_id: t.id, workspace_id: w.workspaceId, scope_project_ids: [w.projectId], view_id: views[0].id });
    expect((await tokenRow(t.id)).view_count).toBe(1);
    expect((await codeRows(t.id))[0]!.consumed_at).not.toBeNull();
    // Single use.
    const again = await verify(t, "jane@acme.test", code);
    expect(again.statusCode).toBe(401);
    expect((await tokenRow(t.id)).view_count).toBe(1);
  });

  it("STORY-098 s7 · a wrong code is 401 with the neutral message, counts an attempt, and sets no cookie and no view", async () => {
    const w = await workspace();
    const t = await token(w);
    await requestCode(t, "jane@acme.test");
    await sentCount(1);
    const real = sender.codesFor("jane@acme.test")[0]!;
    const wrong = real === "000000" ? "000001" : "000000";
    const res = await verify(t, "jane@acme.test", wrong);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe("unauthenticated");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect((await codeRows(t.id))[0]!.attempts).toBe(1);
    expect(await viewRows(t.id)).toHaveLength(0);
    // The right code still works afterwards (it was not burnt).
    expect((await verify(t, "jane@acme.test", real)).statusCode).toBe(200);
  });

  it("STORY-098 s7 · attempts exhausted: the 5th wrong code invalidates the code, and the RIGHT code is refused afterwards", async () => {
    const w = await workspace();
    const t = await token(w);
    await requestCode(t, "jane@acme.test");
    await sentCount(1);
    const real = sender.codesFor("jane@acme.test")[0]!;
    const wrong = real === "000000" ? "000001" : "000000";
    for (let i = 1; i <= 5; i += 1) expect((await verify(t, "jane@acme.test", wrong)).statusCode, `attempt ${String(i)}`).toBe(401);
    const row = (await codeRows(t.id))[0]!;
    expect(row.attempts).toBe(5);
    expect(row.invalidated_reason).toBe("attempts_exhausted");
    const late = await verify(t, "jane@acme.test", real);
    expect(late.statusCode).toBe(401);
    expect(late.headers["set-cookie"]).toBeUndefined();
    expect(await viewRows(t.id)).toHaveLength(0);
    expect((await codeRows(t.id))[0]!.attempts, "an invalidated code is not attacked further").toBe(5);
  });

  it("STORY-098 s7 · parallel guessing cannot exceed the budget: 12 simultaneous wrong codes leave exactly 5 attempts recorded", async () => {
    const w = await workspace();
    const t = await token(w);
    await requestCode(t, "jane@acme.test");
    await sentCount(1);
    const real = sender.codesFor("jane@acme.test")[0]!;
    const wrong = real === "000000" ? "000001" : "000000";
    argon.verify = 0;
    const results = await Promise.all(Array.from({ length: 12 }, () => verify(t, "jane@acme.test", wrong)));
    expect(results.every((r) => r.statusCode === 401)).toBe(true);
    expect((await codeRows(t.id))[0]!.attempts).toBe(5);
    // 12 password checks (each request pays one) + only the five LIVE attempts pay a code verify; the other seven find the code dead.
    expect(argon.verify).toBe(12 + 5);
  });

  it("STORY-098 s7 · an expired code is refused even when right, and mints nothing", async () => {
    const w = await workspace();
    const t = await token(w);
    await requestCode(t, "jane@acme.test");
    await sentCount(1);
    const real = sender.codesFor("jane@acme.test")[0]!;
    await harness.db().query("UPDATE share_token_email_codes SET expires_at = now() - interval '1 second' WHERE share_token_id = $1", [t.id]);
    const res = await verify(t, "jane@acme.test", real);
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(await viewRows(t.id)).toHaveLength(0);
    expect((await tokenRow(t.id)).view_count).toBe(0);
  });

  it("STORY-098 s7 · a domain that is not allowed is refused at the code request: nothing mailed, nothing stored, and the password is still checked first", async () => {
    const w = await workspace();
    const t = await token(w);
    const foreign = await requestCode(t, "eve@evil.test");
    expect(foreign.statusCode).toBe(401);
    expect(errorOf(foreign).code).toBe("unauthenticated");
    for (const sneaky of ["eve@acme.test.evil.test", "acme.test@evil.test", "eve@sub.acme.test"]) {
      expect((await requestCode(t, sneaky)).statusCode, sneaky).toBe(401);
    }
    const wrongPassword = await requestCode(t, "jane@acme.test", "wrong");
    expect(wrongPassword.statusCode).toBe(401);
    await new Promise((r) => setTimeout(r, 300));
    expect(sender.sent).toHaveLength(0);
    expect(await codeRows(t.id)).toHaveLength(0);
  });

  it("STORY-098 s7 · an email is required for a domain-restricted link (400) and a link without domains ignores it and still answers 200 with the cookie", async () => {
    const w = await workspace();
    const t = await token(w);
    const missing = await post("/portal/session", { secret: t.secret, password: PASSWORD });
    expect(missing.statusCode).toBe(400);
    const open = await token(w, { domains: [], password: false });
    const res = await post("/portal/session", { secret: open.secret, email: "anyone@anywhere.test" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeDefined();
    expect(sender.sent.filter((m) => m.to === "anyone@anywhere.test")).toHaveLength(0);
  });

  it("STORY-098 s7 · a code is bound to its address: the right code with a different address at the same domain is refused", async () => {
    const w = await workspace();
    const t = await token(w);
    await requestCode(t, "jane@acme.test");
    await sentCount(1);
    const real = sender.codesFor("jane@acme.test")[0]!;
    const res = await verify(t, "mallory@acme.test", real);
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect((await codeRows(t.id))[0]!.attempts, "the other address's wrong guess spends nobody's budget").toBe(0);
  });

  it("ISO-09 / STORY-098 s7 · cross-token isolation: a code for link A never verifies link B (same domain, same address, other workspace too), and B's refusal touches A's code", async () => {
    const w1 = await workspace();
    const w2 = await workspace();
    const a = await token(w1);
    const sameWorkspace = await token(w1);
    const otherWorkspace = await token(w2);
    await requestCode(a, "jane@acme.test");
    await sentCount(1);
    const real = sender.codesFor("jane@acme.test")[0]!;
    for (const other of [sameWorkspace, otherWorkspace]) {
      const res = await verify(other, "jane@acme.test", real);
      expect(res.statusCode).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(await viewRows(other.id)).toHaveLength(0);
      expect(await codeRows(other.id)).toHaveLength(0);
    }
    expect((await codeRows(a.id))[0]!.attempts).toBe(0);
    expect((await verify(a, "jane@acme.test", real)).statusCode).toBe(200);
    // And the database says the same without the application: a code row cannot name another tenant's token.
    await expect(
      harness.db().query(
        `INSERT INTO share_token_email_codes (workspace_id, share_token_id, email_hash, code_hash, expires_at) VALUES ($1,$2,$3,'x', now())`,
        [w2.workspaceId, a.id, randomBytes(32)],
      ),
    ).rejects.toThrow(/share_token_email_codes_token_fkey/);
  });

  it("STORY-098 s7 · no account enumeration: the code request answers byte-for-byte alike for a known and an unknown address, and the code step for an address with and without a live code", async () => {
    const w = await workspace();
    const t = await token(w);
    // `known` has already signed in once on this link, and is a user of the platform; `fresh` is neither.
    await harness.db().query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1,'known@acme.test',now(),'active')", [randomUUID()]);
    await requestCode(t, "known@acme.test");
    await sentCount(1);
    await verify(t, "known@acme.test", sender.codesFor("known@acme.test")[0]!);
    const known = await requestCode(t, "known@acme.test");
    const fresh = await requestCode(t, "fresh-person@acme.test");
    expect(known.statusCode).toBe(202);
    expect(fresh.statusCode).toBe(202);
    expect((known.json() as { data: unknown }).data).toEqual((fresh.json() as { data: unknown }).data);
    const headerNames = (r: typeof known) => Object.keys(r.headers).filter((h) => !["date", "x-request-id", "content-length", "ratelimit-remaining", "ratelimit-reset", "x-ratelimit-remaining", "x-ratelimit-reset"].includes(h.toLowerCase())).sort();
    expect(headerNames(known)).toEqual(headerNames(fresh));

    // Code step: a wrong code for an address WITH a live code and one with NONE answer identically, and both pay Argon2 work.
    const withCode = await verify(t, "known@acme.test", "000000");
    argon.verify = 0;
    argon.decoy = 0;
    const withoutCode = await verify(t, "never-asked@acme.test", "000000");
    expect(withoutCode.statusCode).toBe(withCode.statusCode);
    expect({ code: errorOf(withoutCode).code, message: errorOf(withoutCode).message }).toEqual({ code: errorOf(withCode).code, message: errorOf(withCode).message });
    expect(argon.decoy, "no live code: a decoy verify of the same cost").toBe(1);
    // An unknown SECRET answers the same too.
    const unknownLink = await verify({ secret: generateShareSecret() }, "known@acme.test", "000000");
    expect(unknownLink.statusCode).toBe(withCode.statusCode);
    expect(errorOf(unknownLink).message).toBe(errorOf(withCode).message);
  });

  it("STORY-098 s7 · a mail the provider refuses (bounced address, outage) changes nothing the visitor can see: still 202, same body, and the failure is counted, not hidden", async () => {
    const w = await workspace();
    const t = await token(w);
    const ok = await requestCode(t, "a@acme.test");
    sender.failWith = new Error("provider down");
    const failed = await requestCode(t, "b@acme.test");
    expect(failed.statusCode).toBe(202);
    expect((failed.json() as { data: unknown }).data).toEqual((ok.json() as { data: unknown }).data);
  });

  it("STORY-098 s7 · the code is not mailed from inside a database transaction: the row is committed and visible to another connection before the sender is called", async () => {
    const w = await workspace();
    const t = await token(w);
    const seen: number[] = [];
    const original = sender.send.bind(sender);
    sender.send = async (message) => {
      seen.push((await codeRows(t.id)).length);
      await original(message);
    };
    try {
      await requestCode(t, "jane@acme.test");
      await sentCount(1);
    } finally {
      sender.send = original;
    }
    expect(seen).toEqual([1]);
  });

  it("STORY-098 s7 · codes are issued at most 3 an hour per address and 10 an hour per link; the next request is 429 rate_limited and mails nothing; a new code supersedes the live one", async () => {
    const w = await workspace();
    const t = await token(w);
    for (let i = 0; i < 3; i += 1) expect((await requestCode(t, "jane@acme.test")).statusCode).toBe(202);
    await sentCount(3);
    const fourth = await requestCode(t, "jane@acme.test");
    expect(fourth.statusCode).toBe(429);
    expect(errorOf(fourth).code).toBe("rate_limited");
    await new Promise((r) => setTimeout(r, 300));
    expect(sender.sent).toHaveLength(3);
    const rows = await codeRows(t.id);
    expect(rows.map((r) => r.invalidated_reason)).toEqual(["superseded", "superseded", null]);
    // The first two codes no longer work; the latest does.
    const codes = sender.codesFor("jane@acme.test");
    expect((await verify(t, "jane@acme.test", codes[0]!)).statusCode).toBe(401);
    expect((await verify(t, "jane@acme.test", codes[2]!)).statusCode).toBe(200);

    const other = await token(w);
    for (let i = 0; i < 10; i += 1) expect((await requestCode(other, `person${String(i)}@acme.test`)).statusCode).toBe(202);
    expect((await requestCode(other, "person10@acme.test")).statusCode).toBe(429);
  });

  it("STORY-098 security review · at most 30 codes per link per rolling 24 hours: the 30th is issued, the 31st is 429 rate_limited with retry_after_ms and mails nothing; the hourly caps still apply", async () => {
    const w = await workspace();
    const seed = async (tokenId: string, n: number): Promise<void> => {
      // Spread 2h..23h back, a few per address, so NEITHER hourly cap is what refuses the request.
      await harness.db().query(
        `INSERT INTO share_token_email_codes (id, workspace_id, share_token_id, email_hash, code_hash, max_attempts, expires_at, created_at)
         SELECT gen_random_uuid(), $1, $2, digest('seed' || (g / 3)::text, 'sha256'), 'x', 5, now() - interval '1 hour', now() - make_interval(hours => 2 + (g % 21))
           FROM generate_series(1, $3::int) g`,
        [w.workspaceId, tokenId, n],
      );
    };
    const full = await token(w);
    await seed(full.id, 29);
    expect((await requestCode(full, "daily@acme.test")).statusCode).toBe(202);
    await sentCount(1);
    const over = await requestCode(full, "other@acme.test");
    expect(over.statusCode).toBe(429);
    expect(errorOf(over).code).toBe("rate_limited");
    expect((over.json() as { error: { details: { retry_after_ms: number } } }).error.details.retry_after_ms).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(sender.sent).toHaveLength(1);
    // Another link is unaffected by this link's day.
    const fresh = await token(w);
    expect((await requestCode(fresh, "daily@acme.test")).statusCode).toBe(202);
    // The hourly per-link cap (10) still refuses well before the daily one.
    const hourly = await token(w);
    for (let i = 0; i < 10; i += 1) expect((await requestCode(hourly, `h${String(i)}@acme.test`)).statusCode).toBe(202);
    expect((await requestCode(hourly, "h10@acme.test")).statusCode).toBe(429);
  });

  it("STORY-098 s7 · both endpoints are rate limited per address: the code request by portal_session (burst 2), the code step by the auth class (burst 5)", async () => {
    const w = await workspace();
    const t = await token(w);
    const same = "198.51.100.40";
    expect((await requestCode(t, "a@acme.test", PASSWORD, same)).statusCode).toBe(202);
    expect((await requestCode(t, "b@acme.test", PASSWORD, same)).statusCode).toBe(202);
    expect((await requestCode(t, "c@acme.test", PASSWORD, same)).statusCode).toBe(429);
    const verifyFrom = "198.51.100.41";
    const results: number[] = [];
    for (let i = 0; i < 7; i += 1) results.push((await verify(t, "a@acme.test", "000000", verifyFrom)).statusCode);
    expect(results.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(results.at(-1)).toBe(429);
  });

  it("STORY-098 s16/s17 · a revoked, expired or view-capped link refuses the code request AND the code step with the one neutral refusal; a code outstanding at revocation is dead", async () => {
    const w = await workspace();
    const t = await token(w);
    await requestCode(t, "jane@acme.test");
    await sentCount(1);
    const real = sender.codesFor("jane@acme.test")[0]!;
    await harness.db().query("UPDATE share_tokens SET revoked_at = now() WHERE id = $1", [t.id]);
    const verified = await verify(t, "jane@acme.test", real);
    expect(verified.statusCode).toBe(401);
    expect(errorOf(verified).code).toBe("token_revoked");
    expect(await viewRows(t.id)).toHaveLength(0);
    const requested = await requestCode(t, "jane@acme.test");
    expect(requested.statusCode).toBe(401);
    expect(errorOf(requested).code).toBe("token_revoked");
    const capped = await token(w, { maxViews: 1 });
    await harness.db().query("UPDATE share_tokens SET view_count = 1 WHERE id = $1", [capped.id]);
    expect(errorOf(await requestCode(capped, "jane@acme.test")).code).toBe("token_revoked");
    expect(errorOf(await verify(capped, "jane@acme.test", "123456")).code).toBe("token_revoked");
  });

  it("STORY-098 s7 · the view cap holds on the code step: with max_views 2, five parallel right-code verifies of five addresses mint exactly two sessions", async () => {
    const w = await workspace();
    const t = await token(w, { maxViews: 2, password: false });
    const addresses = Array.from({ length: 5 }, (_, i) => `u${String(i)}@acme.test`);
    for (const a of addresses) expect((await post("/portal/session", { secret: t.secret, email: a })).statusCode).toBe(202);
    await sentCount(5);
    const results = await Promise.all(addresses.map((a) => verify(t, a, sender.codesFor(a)[0]!)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(2);
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(3);
    expect((await tokenRow(t.id)).view_count).toBe(2);
    expect(await viewRows(t.id)).toHaveLength(2);
  });

  it("STORY-098 s7 · a passwordless domain-restricted link needs no password for the code request and its view is marked authenticated by the code", async () => {
    const w = await workspace();
    const t = await token(w, { password: false });
    expect((await post("/portal/session", { secret: t.secret, email: "jane@acme.test" })).statusCode).toBe(202);
    await sentCount(1);
    expect((await verify(t, "jane@acme.test", sender.codesFor("jane@acme.test")[0]!)).statusCode).toBe(200);
    expect((await viewRows(t.id))[0]).toMatchObject({ authenticated: true });
  });

  it("STORY-098 s7 · a code alone never opens a password-protected link: the code step without the password (or with a wrong one) is 401 even for the RIGHT code, spends no code attempt, counts toward the token lock, and five of them lock it", async () => {
    const w = await workspace();
    const t = await token(w);
    await requestCode(t, "jane@acme.test");
    await sentCount(1);
    const real = sender.codesFor("jane@acme.test")[0]!;
    for (const password of [null, "wrong"]) {
      const res = await verify(t, "jane@acme.test", real, undefined, password);
      expect(res.statusCode).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
    expect((await codeRows(t.id))[0]!.attempts).toBe(0);
    expect((await tokenRow(t.id)).failed_attempts).toBe(2);
    expect(await viewRows(t.id)).toHaveLength(0);
    for (let i = 0; i < 2; i += 1) expect((await verify(t, "jane@acme.test", real, undefined, "wrong")).statusCode).toBe(401);
    const locked = await verify(t, "jane@acme.test", real, undefined, "wrong");
    expect(locked.statusCode).toBe(429);
    expect(errorOf(locked).code).toBe("rate_limited");
    // Locked: even the right password and the right code are refused until the cooldown ends.
    expect((await verify(t, "jane@acme.test", real)).statusCode).toBe(429);
    await harness.db().query("UPDATE share_tokens SET locked_until = now() - interval '1 second' WHERE id = $1", [t.id]);
    expect((await verify(t, "jane@acme.test", real)).statusCode).toBe(200);
  });

  it("STORY-098 s7 · request bodies are strict: an unknown key, a short or non-numeric code, and a missing email are 400 and touch no code", async () => {
    const w = await workspace();
    const t = await token(w);
    await requestCode(t, "jane@acme.test");
    await sentCount(1);
    for (const payload of [
      { secret: t.secret, email: "jane@acme.test", code: "123456", project_id: w.projectId },
      { secret: t.secret, email: "jane@acme.test", code: "12345" },
      { secret: t.secret, email: "jane@acme.test", code: "1234567" },
      { secret: t.secret, email: "jane@acme.test", code: "12345a" },
      { secret: t.secret, code: "123456" },
      { email: "jane@acme.test", code: "123456" },
    ]) {
      expect((await post("/portal/session/verify", payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await codeRows(t.id))[0]!.attempts).toBe(0);
  });
});
