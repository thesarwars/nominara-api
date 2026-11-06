import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PortalCookiePayload } from "../../contracts/portal/index.js";
import { PORTAL_LOGO_MAX_BYTES, portalOverviewResponseSchema } from "../../contracts/portal/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { OBJECT_STORAGE, type ObjectHead, type ObjectStoragePort, type PutObjectRequest, type StorageBucketName } from "../../src/lib/storage/storage.port.js";
import { TenantObjectStore } from "../../src/lib/storage/tenant-object-store.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { loadPortalCookieKey, PORTAL_COOKIE_NAME, sealPortalCookie } from "../../src/modules/portal/portal-cookie.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-098 · owner decision 71 (a) — the portal shows the agency logo as an enveloped data: URL, capped at 256 KB. Only the object
// store is faked (in memory, at the OBJECT_STORAGE port); the keys are written through the real TenantObjectStore.
const COOKIE_KEY_B64 = randomBytes(32).toString("base64url");
const KEY = loadPortalCookieKey(COOKIE_KEY_B64);

class MemoryPort implements ObjectStoragePort {
  readonly objects = new Map<string, Buffer>();
  gets = 0;
  failGets = false;
  async put(r: PutObjectRequest): Promise<void> {
    this.objects.set(`${r.bucket}/${r.key}`, Buffer.from(r.body));
  }
  async get(bucket: StorageBucketName, key: string): Promise<Buffer> {
    this.gets += 1;
    if (this.failGets) throw new Error("storage is down");
    const found = this.objects.get(`${bucket}/${key}`);
    if (found === undefined) throw new Error("not found");
    return found;
  }
  async head(): Promise<ObjectHead> {
    throw new Error("unused");
  }
  async delete(): Promise<void> {}
  async presignGet(): Promise<string> {
    return "https://storage.example/never-served";
  }
}
const port = new MemoryPort();

function png(w: number, h: number, pad = 0): Buffer {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

describe("STORY-098 d.71 (a) · the portal shows the agency logo", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({
    configure: (builder) => {
      builder.overrideProvider(OBJECT_STORAGE).useValue(port);
    },
    env: () => {
      const u = new URL(process.env.DATABASE_URL!);
      u.username = "nominara_portal";
      u.password = resolvePassword("nominara_portal", {});
      return { VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString, PORTAL_COOKIE_KEY: COOKIE_KEY_B64, DATABASE_URL_PORTAL: u.toString() };
    },
  });
  beforeAll(async () => {
    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop()]);
  });
  beforeEach(async () => {
    port.objects.clear();
    port.gets = 0;
    port.failGets = false;
    await harness.db().query(`ALTER ROLE nominara_portal PASSWORD '${resolvePassword("nominara_portal", {})}'`);
  });

  interface World { ws: string; p1: string; user: string; theme: string }
  async function world(): Promise<World> {
    const db = harness.db();
    const [ws, p1, user, theme] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'Agency One',$2,'growth','UTC')", [ws, `w-${ws.slice(0, 8)}`]);
    await db.query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1,$2,now(),'active')", [user, `${user}@example.test`]);
    await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'Client One',$3,'https://a.test','a.test')", [p1, ws, `p-${p1.slice(0, 8)}`]);
    await db.query("INSERT INTO brand_themes (id, workspace_id, name, is_default) VALUES ($1,$2,'Agency',true)", [theme, ws]);
    return { ws, p1, user, theme };
  }

  /** Stores `bytes` under the workspace's own prefix through the real tenant store and points the theme's logo at it. */
  async function storeLogo(w: World, bytes: Buffer, ownerWorkspace = w.ws): Promise<string> {
    const store = harness.app().get(TenantObjectStore, { strict: false });
    const db = harness.db();
    const { Pool } = await import("pg");
    const pool = new Pool({ host: db.host, port: db.port, user: db.user, password: db.password, database: db.database });
    const client = await pool.connect();
    try {
      const key = await withTenantContext(client, { workspaceId: ownerWorkspace, actorId: SYSTEM_ACTOR_ID }, () =>
        store.put("reports", `branding/${w.theme}/logo_light-${randomUUID()}.png`, bytes, { contentType: "image/png" }),
      );
      await db.query("UPDATE brand_themes SET logo_light_key = $2 WHERE id = $1", [w.theme, key]);
      return key;
    } finally {
      client.release();
      await pool.end();
    }
  }

  async function session(w: World): Promise<string> {
    const id = randomUUID();
    await harness.db().query(
      `INSERT INTO share_tokens (id, workspace_id, label, token_hash, token_prefix, password_required, scope_project_ids, scope_tabs, theme_id, created_by)
       VALUES ($1,$2,'Client link',$3,'abcdefgh',false,$4::uuid[],$5::text[],$6,$7)`,
      [id, w.ws, randomBytes(32), [w.p1], ["overview"], w.theme, w.user],
    );
    const payload: PortalCookiePayload = { token_id: id, workspace_id: w.ws, scope_project_ids: [w.p1], scope_tabs: ["overview"], theme_id: w.theme };
    return `${PORTAL_COOKIE_NAME}=${(await sealPortalCookie(payload, KEY)).value}`;
  }
  const overview = async (cookie: string) => {
    const res = await harness.app().inject({ method: "GET", url: apiUrl("/portal/overview"), headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    return { res, theme: portalOverviewResponseSchema.parse((res.json() as { data: unknown }).data).theme };
  };

  it("STORY-098 d.71 (a) · the portal shows the logo: theme.logo_url is a data:image/png;base64 URL of exactly the stored bytes, and no storage URL, key or platform path is in the payload", async () => {
    const w = await world();
    const bytes = png(300, 90, 2_000);
    const key = await storeLogo(w, bytes);
    const { res, theme } = await overview(await session(w));
    expect(theme.logo_url).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
    for (const forbidden of [key, "storage.example", "/assets/logo_light", "branding/"]) expect(res.body).not.toContain(forbidden);
  });

  it("STORY-098 d.71 (a) · an oversize logo is refused: at 256 KB + 1 the portal serves logo_url null, and the exact cap is still shown", async () => {
    const atCap = await world();
    await storeLogo(atCap, png(300, 90, PORTAL_LOGO_MAX_BYTES - 33));
    expect((await overview(await session(atCap))).theme.logo_url).not.toBeNull();
    const over = await world();
    await storeLogo(over, png(300, 90, PORTAL_LOGO_MAX_BYTES - 33 + 1));
    const { res, theme } = await overview(await session(over));
    expect(theme.logo_url).toBeNull();
    expect(res.body).not.toContain("data:image");
  });

  it("STORY-098 d.71 (a) · the envelope gate holds: an SVG, HTML or garbage in the logo slot is never inlined", async () => {
    for (const bytes of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      Buffer.from("<html><script>alert(1)</script></html>"),
      randomBytes(400),
    ]) {
      const w = await world();
      await storeLogo(w, bytes);
      const { res, theme } = await overview(await session(w));
      expect(theme.logo_url).toBeNull();
      expect(res.body).not.toContain("data:");
      expect(res.body).not.toContain("script");
    }
  });

  it("ISO-09 / STORY-098 d.71 (a) · a logo key that points into ANOTHER workspace's prefix is never read or served", async () => {
    const mine = await world();
    const theirs = await world();
    const stolen = await storeLogo(theirs, png(100, 30, 500));
    // Their own portal serves it first, so it is in the logo cache: the forged row must still miss.
    expect((await overview(await session(theirs))).theme.logo_url).not.toBeNull();
    await harness.db().query("UPDATE brand_themes SET logo_light_key = $2 WHERE id = $1", [mine.theme, stolen]);
    const getsBefore = port.gets;
    const { res, theme } = await overview(await session(mine));
    expect(theme.logo_url).toBeNull();
    expect(res.body).not.toContain("data:image");
    expect(port.gets, "the foreign object was never fetched").toBe(getsBefore);
  });

  it("STORY-098 d.71 (a) · no logo, an unreadable object and a storage outage all serve the portal with logo_url null (a missing logo never takes the portal down)", async () => {
    const none = await world();
    expect((await overview(await session(none))).theme.logo_url).toBeNull();
    const down = await world();
    await storeLogo(down, png(100, 30, 100));
    port.failGets = true;
    expect((await overview(await session(down))).theme.logo_url).toBeNull();
    const missing = await world();
    await storeLogo(missing, png(100, 30, 100));
    port.objects.clear();
    port.failGets = false;
    expect((await overview(await session(missing))).theme.logo_url).toBeNull();
  });

  it("STORY-098 d.71 (a) · a re-uploaded logo is shown on the next request; an unchanged one is not fetched from storage again", async () => {
    const w = await world();
    const cookie = await session(w);
    const first = png(100, 30, 100);
    await storeLogo(w, first);
    expect((await overview(cookie)).theme.logo_url).toBe(`data:image/png;base64,${first.toString("base64")}`);
    const fetched = port.gets;
    await overview(cookie);
    await overview(cookie);
    expect(port.gets, "served from memory while the key is unchanged").toBe(fetched);
    const second = png(120, 40, 300);
    await storeLogo(w, second);
    expect((await overview(cookie)).theme.logo_url).toBe(`data:image/png;base64,${second.toString("base64")}`);
  });

  it("STORY-098 d.71 (a) · a theme carrying no logo never shows another theme's: two tokens on two themes never share a logo", async () => {
    const a = await world();
    const b = await world();
    await storeLogo(a, png(100, 30, 100));
    const cookieA = await session(a);
    const cookieB = await session(b);
    const [ra, rb] = [await overview(cookieA), await overview(cookieB)];
    expect(ra.theme.logo_url).not.toBeNull();
    expect(rb.theme.logo_url).toBeNull();
  });
});
