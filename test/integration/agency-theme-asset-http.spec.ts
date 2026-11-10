import { Logger } from "@nestjs/common";
import { vi } from "vitest";
import { AgencyService } from "../../src/modules/agency/agency.service.js";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { OBJECT_STORAGE, type ObjectStoragePort } from "../../src/lib/storage/storage.port.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startLocalstack, type LocalstackFixture } from "../support/localstack-fixture.js";
import { reportStorageEnv } from "../support/report-storage-env.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-097 scenarios 9-11 · owner decision 67 (n): POST /v1/themes/{id}/assets and the platform-origin fetch route, through the
// REAL ApiModule and LocalStack S3.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

function png(w: number, h: number, pad = 0): Buffer {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

describe("STORY-097 · theme assets over HTTP", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  let localstack: LocalstackFixture;
  // The application runs as the real nominara_app role (NOBYPASSRLS): the cross-workspace cases below rely on RLS alone (STORY-021). `db()`
  // and the fixtures' `pool` stay the superuser.
  const harness = useApiHarness({
    runAsAppRole: true,
    env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString, ...reportStorageEnv(localstack.endpoint) }),
  });
  let pool: Pool;
  let sessions: SessionService;

  beforeAll(async () => {
    [cacheValkey, queueValkey, localstack] = await Promise.all([startValkey(), startValkeyFixture(), startLocalstack()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop(), localstack.stop()]);
  });
  beforeEach(() => {
    const c = harness.db();
    pool = new Pool({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database });
    sessions = new SessionService(pool, new MembershipService(new MembershipCacheService()), new InMemoryCacheAdapter());
  });
  afterEach(async () => {
    await pool.end();
  });

  interface Actor {
    readonly workspaceId: string;
    readonly cookie: string;
    readonly csrf: string;
  }

  async function newUser(): Promise<string> {
    const userId = uuidV7();
    await harness.db().query(
      `INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`,
      [userId, `${userId}@example.test`],
    );
    return userId;
  }

  /** An owner of a fresh workspace on `plan`. */
  async function owner(plan: "growth" | "business"): Promise<Actor & { userId: string }> {
    const userId = await newUser();
    const tokens = await sessions.createSession(userId);
    const created = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      headers: { cookie: cookieOf(tokens), [CSRF_HEADER_NAME]: tokens.csrfToken, "content-type": "application/json" },
      payload: { name: "Acme", org_type: "in_house", region: "us-east-1", timezone: "UTC" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspaceId = (created.json() as { data: { id: string } }).data.id;
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyPlanChange(tx, workspaceId, planKeyOnly(plan), { requestId: "R", operator: "test", reason: "test" }),
      );
    } finally {
      client.release();
    }
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 2);
    return { userId, workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  async function member(workspaceId: string, role: "manager" | "viewer"): Promise<Actor> {
    const userId = await newUser();
    await harness.db().query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,$4,'active')`,
      [uuidV7(), workspaceId, userId, role],
    );
    const tokens = await sessions.createSession(userId);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, role, null, 2);
    return { workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  const put = (a: Actor, payload: unknown) =>
    harness.app().inject({ method: "PUT", url: apiUrl("/agency/theme"), headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" }, payload: payload as object });
  const upload = (a: Actor, themeId: string, payload: unknown) =>
    harness.app().inject({ method: "POST", url: apiUrl(`/themes/${themeId}/assets`), headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" }, payload: payload as object });
  const fetchAsset = (a: Actor, themeId: string, slot: string) =>
    harness.app().inject({ method: "GET", url: apiUrl(`/themes/${themeId}/assets/${slot}`), headers: { cookie: a.cookie } });
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  const b64 = (b: Buffer) => b.toString("base64");
  async function themed(): Promise<{ a: Actor; themeId: string }> {
    const a = await owner("growth");
    const saved = await put(a, { name: "Acme" });
    expect(saved.statusCode, saved.body).toBe(200);
    return { a, themeId: data<{ theme_id: string }>(saved).theme_id };
  }

  it("STORY-097 s11 / decision 69 (c) · an uploaded logo is stored, the theme points at a platform-origin path, and the fetch route STREAMS the same bytes from the platform origin (no redirect, no storage host)", async () => {
    const { a, themeId } = await themed();
    const file = png(300, 100);
    const res = await upload(a, themeId, { slot: "logo_light", content_type: "image/png", data_base64: b64(file) });
    expect(res.statusCode, res.body).toBe(201);
    expect(data<Record<string, unknown>>(res)).toMatchObject({ theme_id: themeId, slot: "logo_light", content_type: "image/png", width: 300, height: 100, bytes: file.length, url: `/v1/themes/${themeId}/assets/logo_light` });

    const list = await harness.app().inject({ method: "GET", url: apiUrl("/agency/theme"), headers: { cookie: a.cookie } });
    expect(data<Array<{ logo_url: string | null }>>(list)[0]!.logo_url).toBe(`/v1/themes/${themeId}/assets/logo_light`);

    const served = await fetchAsset(a, themeId, "logo_light");
    expect(served.statusCode, served.body).toBe(200);
    expect(served.headers.location).toBeUndefined();
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["cache-control"]).toBe("private, no-store");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(served.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(served.headers["referrer-policy"]).toBe("no-referrer");
    expect(served.rawPayload.equals(file)).toBe(true);
    expect(Number(served.headers["content-length"])).toBe(file.length);
  }, 120_000);

  it("STORY-097 s11 / ADR-0003 · the streamed fetch reads storage AFTER the request transaction has ended: no transaction is open while the object is read", async () => {
    const { a, themeId } = await themed();
    expect((await upload(a, themeId, { slot: "favicon", content_type: "image/png", data_base64: b64(png(32, 32)) })).statusCode).toBe(201);
    const port = harness.app().get<ObjectStoragePort>(OBJECT_STORAGE, { strict: false });
    const real = port.get.bind(port);
    let open = -1;
    const spy = vi.spyOn(port, "get").mockImplementation(async (bucket, key) => {
      open = Number((await harness.db().query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = 'nominara_app' AND state LIKE 'idle in transaction%'")).rows[0].n);
      return real(bucket, key);
    });
    try {
      expect((await fetchAsset(a, themeId, "favicon")).statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect(open).toBe(0);
  }, 120_000);

  it("STORY-097 s11 · the fetch is observable: one span-shaped log line with the workspace ID, the slot and the outcome, and never the object key", async () => {
    const { a, themeId } = await themed();
    expect((await upload(a, themeId, { slot: "logo_light", content_type: "image/png", data_base64: b64(png(10, 10)) })).statusCode).toBe(201);
    const key = (await harness.db().query(`SELECT logo_light_key FROM brand_themes WHERE id = $1`, [themeId])).rows[0].logo_light_key as string;
    const log = vi.spyOn(Logger.prototype, "log");
    try {
      expect((await fetchAsset(a, themeId, "logo_light")).statusCode).toBe(200);
      const lines = (log.mock.calls as unknown[][]).map((c) => c[0]).filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null && (l as { span?: string }).span === "agency.theme_asset_fetch");
      expect(lines).toEqual([{ span: "agency.theme_asset_fetch", workspace_id: a.workspaceId, slot: "logo_light", outcome: "served" }]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(key);
    } finally {
      log.mockRestore();
    }
  }, 120_000);

  it("STORY-097 s11 · each slot streams its own bytes with the type the BYTES decide (a JPEG logo_dark is image/jpeg, a WebP favicon is image/webp)", async () => {
    const { a, themeId } = await themed();
    const jpeg = Buffer.alloc(2 + 18 + 19 + 2);
    jpeg.writeUInt16BE(0xffd8, 0);
    jpeg.writeUInt16BE(0xffe0, 2);
    jpeg.writeUInt16BE(16, 4);
    jpeg.write("JFIF", 6, "ascii");
    jpeg.writeUInt16BE(0xffc0, 20);
    jpeg.writeUInt16BE(17, 22);
    jpeg[24] = 8;
    jpeg.writeUInt16BE(100, 25);
    jpeg.writeUInt16BE(300, 27);
    jpeg[29] = 3;
    jpeg.writeUInt16BE(0xffd9, jpeg.length - 2);
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.writeUInt32LE(22, 4);
    webp.write("WEBP", 8, "ascii");
    webp.write("VP8L", 12, "ascii");
    webp.writeUInt32LE(10, 16);
    webp[20] = 0x2f;
    webp.writeUInt32LE((31 | (31 << 14)) >>> 0, 21);
    const up1 = await upload(a, themeId, { slot: "logo_dark", content_type: "image/jpeg", data_base64: b64(jpeg) });
    expect(up1.statusCode, up1.body).toBe(201);
    const up2 = await upload(a, themeId, { slot: "favicon", content_type: "image/webp", data_base64: b64(webp) });
    expect(up2.statusCode, up2.body).toBe(201);
    const dark = await fetchAsset(a, themeId, "logo_dark");
    expect(dark.headers["content-type"]).toBe("image/jpeg");
    expect(dark.rawPayload.equals(jpeg)).toBe(true);
    const fav = await fetchAsset(a, themeId, "favicon");
    expect(fav.headers["content-type"]).toBe("image/webp");
    expect(fav.rawPayload.equals(webp)).toBe(true);
    // A slot with no upload is 404, not an empty 200.
    const other = await themed();
    expect((await fetchAsset(other.a, other.themeId, "logo_dark")).statusCode).toBe(404);
  }, 120_000);

  it("STORY-097 s11 · a stored object whose bytes no longer validate is not served (fail closed, never a 200 with the bad bytes); a storage outage is a 5xx", async () => {
    const { a, themeId } = await themed();
    expect((await upload(a, themeId, { slot: "logo_light", content_type: "image/png", data_base64: b64(png(10, 10)) })).statusCode).toBe(201);
    const port = harness.app().get<ObjectStoragePort>(OBJECT_STORAGE, { strict: false });
    const swapped = vi.spyOn(port, "get").mockResolvedValueOnce(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    try {
      const res = await fetchAsset(a, themeId, "logo_light");
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain("<svg");
    } finally {
      swapped.mockRestore();
    }
    const down = vi.spyOn(port, "get").mockRejectedValueOnce(new Error("s3 down"));
    try {
      expect((await fetchAsset(a, themeId, "logo_light")).statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      down.mockRestore();
    }
  }, 120_000);

  it("STORY-097 s11 · a forged key naming ANOTHER workspace's object is never streamed (the bound store refuses it)", async () => {
    const mine = await themed();
    const theirs = await themed();
    expect((await upload(theirs.a, theirs.themeId, { slot: "logo_light", content_type: "image/png", data_base64: b64(png(10, 10)) })).statusCode).toBe(201);
    const foreignKey = (await harness.db().query(`SELECT logo_light_key FROM brand_themes WHERE id = $1`, [theirs.themeId])).rows[0].logo_light_key as string;
    await harness.db().query(`UPDATE brand_themes SET logo_light_key = $2 WHERE id = $1`, [mine.themeId, foreignKey]);
    const res = await fetchAsset(mine.a, mine.themeId, "logo_light");
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.rawPayload.length).not.toBe(png(10, 10).length);
  }, 120_000);

  it("STORY-097 · the editor's theme list names the logo_dark and favicon paths once uploaded (null before), so a reload can show them", async () => {
    const { a, themeId } = await themed();
    const before = data<Array<{ logo_dark_url: string | null; favicon_url: string | null }>>(await harness.app().inject({ method: "GET", url: apiUrl("/agency/theme"), headers: { cookie: a.cookie } }));
    expect(before[0]).toMatchObject({ logo_dark_url: null, favicon_url: null });
    expect((await upload(a, themeId, { slot: "logo_dark", content_type: "image/png", data_base64: b64(png(20, 20)) })).statusCode).toBe(201);
    expect((await upload(a, themeId, { slot: "favicon", content_type: "image/png", data_base64: b64(png(32, 32)) })).statusCode).toBe(201);
    const after = data<Array<{ logo_url: string | null; logo_dark_url: string | null; favicon_url: string | null }>>(await harness.app().inject({ method: "GET", url: apiUrl("/agency/theme"), headers: { cookie: a.cookie } }));
    expect(after[0]).toMatchObject({ logo_url: null, logo_dark_url: `/v1/themes/${themeId}/assets/logo_dark`, favicon_url: `/v1/themes/${themeId}/assets/favicon` });
    const saved = await put(a, { theme_id: themeId, name: "Renamed" });
    expect(data<Record<string, unknown>>(saved)).toMatchObject({ logo_dark_url: `/v1/themes/${themeId}/assets/logo_dark`, favicon_url: `/v1/themes/${themeId}/assets/favicon` });
  }, 120_000);

  it("STORY-097 s9 · an SVG is refused naming the file type; nothing is stored", async () => {
    const { a, themeId } = await themed();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
    const res = await upload(a, themeId, { slot: "logo_light", content_type: "image/svg+xml", data_base64: b64(svg) });
    expect(res.statusCode, res.body).toBe(400);
    const nope = await upload(a, themeId, { slot: "logo_light", content_type: "image/png", data_base64: b64(svg) });
    expect(nope.statusCode, nope.body).toBe(400);
    expect(JSON.stringify(nope.json())).toContain("file type");
    expect((await harness.db().query(`SELECT logo_light_key FROM brand_themes WHERE id = $1`, [themeId])).rows[0]).toMatchObject({ logo_light_key: null });
  }, 120_000);

  it("STORY-097 s9 / owner decision 72 · a logo of 256 KB is accepted, 256 KB + 1 and 1 MiB are refused naming the limit; a too-wide logo is refused naming 1200", async () => {
    const { a, themeId } = await themed();
    const exact = await upload(a, themeId, { slot: "logo_dark", content_type: "image/png", data_base64: b64(png(10, 10, 262_144 - 33)) });
    expect(exact.statusCode, exact.body).toBe(201);
    const over = await upload(a, themeId, { slot: "logo_dark", content_type: "image/png", data_base64: b64(png(10, 10, 262_144 - 32)) });
    expect(over.statusCode, over.body).toBe(400);
    expect(JSON.stringify(over.json())).toContain("262144");
    const mib = await upload(a, themeId, { slot: "logo_light", content_type: "image/png", data_base64: b64(png(10, 10, 1_048_576 - 33)) });
    expect(mib.statusCode, mib.body).toBe(400);
    expect(JSON.stringify(mib.json())).toContain("262144");
    const wide = await upload(a, themeId, { slot: "logo_light", content_type: "image/png", data_base64: b64(png(1201, 100)) });
    expect(wide.statusCode, wide.body).toBe(400);
    expect(JSON.stringify(wide.json())).toContain("1200");
  }, 120_000);

  it("STORY-097 s11 · replacing a logo points the theme at the new object and deletes the old one", async () => {
    const { a, themeId } = await themed();
    expect((await upload(a, themeId, { slot: "favicon", content_type: "image/png", data_base64: b64(png(32, 32)) })).statusCode).toBe(201);
    const first = (await harness.db().query(`SELECT favicon_key FROM brand_themes WHERE id = $1`, [themeId])).rows[0] as { favicon_key: string };
    expect((await upload(a, themeId, { slot: "favicon", content_type: "image/png", data_base64: b64(png(48, 48)) })).statusCode).toBe(201);
    const second = (await harness.db().query(`SELECT favicon_key FROM brand_themes WHERE id = $1`, [themeId])).rows[0] as { favicon_key: string };
    expect(second.favicon_key).not.toBe(first.favicon_key);
    expect(second.favicon_key).toContain(`/${a.workspaceId}/branding/${themeId}/favicon-`);
    const port = harness.app().get<ObjectStoragePort>(OBJECT_STORAGE, { strict: false });
    await expect(port.head("reports", first.favicon_key)).rejects.toThrow();
    await expect(port.head("reports", second.favicon_key)).resolves.toBeDefined();
  }, 120_000);

  it("STORY-097 · a failed storage write fails the upload (503/5xx), records no key, and is not swallowed", async () => {
    const { a, themeId } = await themed();
    const port = harness.app().get<ObjectStoragePort>(OBJECT_STORAGE, { strict: false });
    const spy = vi.spyOn(port, "put").mockRejectedValueOnce(new Error("s3 down"));
    try {
      const res = await upload(a, themeId, { slot: "logo_light", content_type: "image/png", data_base64: b64(png(10, 10)) });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      spy.mockRestore();
    }
    expect((await harness.db().query(`SELECT logo_light_key FROM brand_themes WHERE id = $1`, [themeId])).rows[0]).toMatchObject({ logo_light_key: null });
    expect((await fetchAsset(a, themeId, "logo_light")).statusCode).toBe(404);
    // The request row records the accepted request; the outcome row ("uploaded") is written only with the key, so a failed write has none.
    const actions = (await harness.db().query(`SELECT action FROM audit_log WHERE resource_id = $1`, [themeId])).rows.map((r: { action: string }) => r.action);
    expect(actions).toContain("agency.theme_asset_upload_requested");
    expect(actions).not.toContain("agency.theme_asset_uploaded");
  }, 120_000);

  it("STORY-097 · a successful upload writes the outcome audit row in the same transaction as the key; a record failure removes the object just written and records no outcome", async () => {
    const { a, themeId } = await themed();
    const ok = await upload(a, themeId, { slot: "logo_light", content_type: "image/png", data_base64: b64(png(10, 10)) });
    expect(ok.statusCode, ok.body).toBe(201);
    const outcome = await harness.db().query(`SELECT after_state FROM audit_log WHERE resource_id = $1 AND action = 'agency.theme_asset_uploaded'`, [themeId]);
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.rows[0]).toMatchObject({ after_state: { slot: "logo_light", content_type: "image/png" } });

    const port = harness.app().get<ObjectStoragePort>(OBJECT_STORAGE, { strict: false });
    const deleted = vi.spyOn(port, "delete");
    const record = vi.spyOn(harness.app().get(AgencyService, { strict: false }), "recordAssetKey").mockRejectedValueOnce(new Error("theme went away"));
    try {
      const failed = await upload(a, themeId, { slot: "favicon", content_type: "image/png", data_base64: b64(png(16, 16)) });
      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
      expect(deleted).toHaveBeenCalledTimes(1);
      await expect(port.head("reports", String(deleted.mock.calls[0]![1]))).rejects.toThrow();
    } finally {
      record.mockRestore();
      deleted.mockRestore();
    }
    expect((await harness.db().query(`SELECT count(*)::int AS n FROM audit_log WHERE resource_id = $1 AND action = 'agency.theme_asset_uploaded'`, [themeId])).rows[0]).toMatchObject({ n: 1 });
  }, 120_000);

  it("STORY-097 · a workspace never reaches another workspace's theme: a foreign upload and a foreign fetch are 404 and the foreign row's keys stay null (RLS, as nominara_app)", async () => {
    const mine = await themed();
    const theirs = await themed();
    const file = { slot: "logo_light", content_type: "image/png", data_base64: b64(png(10, 10)) };
    expect((await upload(mine.a, theirs.themeId, file)).statusCode).toBe(404);
    expect((await fetchAsset(mine.a, theirs.themeId, "logo_light")).statusCode).toBe(404);
    expect((await harness.db().query(`SELECT logo_light_key, logo_dark_key, favicon_key FROM brand_themes WHERE id = $1`, [theirs.themeId])).rows[0]).toEqual({ logo_light_key: null, logo_dark_key: null, favicon_key: null });
    // Once the owner uploads, the other workspace still cannot fetch it.
    expect((await upload(theirs.a, theirs.themeId, file)).statusCode).toBe(201);
    expect((await fetchAsset(mine.a, theirs.themeId, "logo_light")).statusCode).toBe(404);
    expect((await fetchAsset(theirs.a, theirs.themeId, "logo_light")).statusCode).toBe(200);
  }, 120_000);

  it("STORY-097 · a manager is 403 naming agency:branding; an unknown theme is 404; unknown body keys are 400", async () => {
    const { a, themeId } = await themed();
    const m = await member(a.workspaceId, "manager");
    const denied = await upload(m, themeId, { slot: "logo_light", content_type: "image/png", data_base64: b64(png(10, 10)) });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.body).toContain("agency:branding");
    expect((await upload(a, uuidV7(), { slot: "logo_light", content_type: "image/png", data_base64: b64(png(10, 10)) })).statusCode).toBe(404);
    expect((await upload(a, themeId, { slot: "logo_light", content_type: "image/png", data_base64: b64(png(10, 10)), extra: 1 })).statusCode).toBe(400);
  }, 120_000);
});
