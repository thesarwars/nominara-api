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
import { fetchStored, reportStorageEnv } from "../support/report-storage-env.js";
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

  it("STORY-097 s11 · an uploaded logo is stored, the theme points at a platform-origin path, and the fetch route redirects to a short presign that serves the same bytes", async () => {
    const { a, themeId } = await themed();
    const file = png(300, 100);
    const res = await upload(a, themeId, { slot: "logo_light", content_type: "image/png", data_base64: b64(file) });
    expect(res.statusCode, res.body).toBe(201);
    expect(data<Record<string, unknown>>(res)).toMatchObject({ theme_id: themeId, slot: "logo_light", content_type: "image/png", width: 300, height: 100, bytes: file.length, url: `/v1/themes/${themeId}/assets/logo_light` });

    const list = await harness.app().inject({ method: "GET", url: apiUrl("/agency/theme"), headers: { cookie: a.cookie } });
    expect(data<Array<{ logo_url: string | null }>>(list)[0]!.logo_url).toBe(`/v1/themes/${themeId}/assets/logo_light`);

    const served = await fetchAsset(a, themeId, "logo_light");
    expect(served.statusCode, served.body).toBe(302);
    expect(served.headers["cache-control"]).toBe("no-store");
    const stored = await fetchStored(String(served.headers.location));
    expect(stored.equals(file)).toBe(true);
    expect(new URL(String(served.headers.location)).searchParams.get("X-Amz-Expires")).toBe("60");
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

  it("STORY-097 s9 · 1 MiB is accepted, 1 MiB + 1 is refused naming the limit; a too-wide logo is refused naming 1200", async () => {
    const { a, themeId } = await themed();
    const exact = await upload(a, themeId, { slot: "logo_dark", content_type: "image/png", data_base64: b64(png(10, 10, 1_048_576 - 33)) });
    expect(exact.statusCode, exact.body).toBe(201);
    const over = await upload(a, themeId, { slot: "logo_dark", content_type: "image/png", data_base64: b64(png(10, 10, 1_048_576 - 32)) });
    expect(over.statusCode, over.body).toBe(400);
    expect(JSON.stringify(over.json())).toContain("1048576");
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
    expect((await fetchAsset(theirs.a, theirs.themeId, "logo_light")).statusCode).toBe(302);
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
