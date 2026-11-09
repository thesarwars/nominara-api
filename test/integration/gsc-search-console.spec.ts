import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GSC_READ_ONLY_SCOPE } from "../../contracts/integrations/index.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME, OAUTH_BINDING_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { buildAuthorizationUrl } from "../../src/lib/gsc/http-client.js";
import {
  GSC_CLIENT,
  GscQuotaError,
  GscSourceError,
  GscUnauthorizedError,
  type GscClient,
  type GscPropertyListing,
  type GscReportRequest,
  type GscReportRow,
} from "../../src/lib/gsc/port.js";
import { GSC_BACKFILL_MONTHS, GSC_SLICE_DAYS, addDays, availableThrough } from "../../src/lib/gsc/sync-plan.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { createGscSyncHandler } from "../../src/lib/queue/handlers/gsc-sync.handler.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";

// STORY-115 - Search Console connection, sync and correlation, through the REAL ApiModule on a real Postgres with the application
// running as nominara_app. Google is faked at the GSC_CLIENT port: nothing here can reach a real provider. Scenario numbers are the
// story's Test scenarios table (S115-n).

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;
const today = (): string => new Date().toISOString().slice(0, 10);
const KEYS = { current: { kid: "k1", key: Buffer.from("gsc-sync-test-signing-key-32byte") } };
const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "gsc.sync")!;

class FakeGoogle implements GscClient {
  properties: GscPropertyListing[] = [];
  scopes: string[] = [GSC_READ_ONLY_SCOPE];
  reportCalls: GscReportRequest[] = [];
  refreshCalls = 0;
  /** Per call: rows to answer, or an error to raise. */
  onReport: (request: GscReportRequest) => readonly GscReportRow[] | Error = (request) => defaultRows(request);
  reset(): void {
    this.properties = [{ siteUrl: "sc-domain:shop.example.com", permissionLevel: "siteOwner" }, { siteUrl: "https://shop.example.com/", permissionLevel: "siteOwner" }];
    this.scopes = [GSC_READ_ONLY_SCOPE];
    this.reportCalls = [];
    this.refreshCalls = 0;
    this.exchangeCode.mockClear();
    this.onReport = (request) => defaultRows(request);
  }
  authorizationUrl(input: { state: string; redirectUri: string }): string {
    return buildAuthorizationUrl({ clientId: "cid", ...input });
  }
  exchangeCode = vi.fn(async () => ({ accessToken: "ACCESS-TOKEN-ONE", refreshToken: "REFRESH-TOKEN-ONE", expiresInSeconds: 3600, scopes: this.scopes }));
  async refresh(): Promise<{ accessToken: string; expiresInSeconds: number }> {
    this.refreshCalls += 1;
    return { accessToken: "ACCESS-TOKEN-TWO", expiresInSeconds: 3600 };
  }
  async listProperties(): Promise<readonly GscPropertyListing[]> {
    return this.properties;
  }
  async fetchReport(request: GscReportRequest): Promise<readonly GscReportRow[]> {
    this.reportCalls.push(request);
    const answer = this.onReport(request);
    if (answer instanceof Error) throw answer;
    return answer;
  }
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** One row per day for the requested window: a page row for `page`, a query row for `query`. */
function defaultRows(request: GscReportRequest): GscReportRow[] {
  return eachDay(request.startDate, request.endDate).map((date) => ({
    date,
    page: request.dimension === "page" ? "https://shop.example.com/guide" : null,
    query: request.dimension === "query" ? "best crm for startups" : null,
    device: "desktop" as const,
    country: null,
    impressions: 10,
    clicks: request.report === "ai_surface" ? null : 2,
    ctr: request.report === "ai_surface" ? null : 0.2,
    position: request.report === "ai_surface" ? null : 3,
  }));
}

describe("STORY-115 - Search Console", () => {
  const google = new FakeGoogle();
  const enqueued: Array<{ queue: string; payload: Record<string, unknown>; key: string }> = [];
  const harness = useApiHarness({
    runAsAppRole: true,
    configure: (builder) => {
      builder.overrideProvider(GSC_CLIENT).useValue(google);
      builder
        .overrideProvider(QueueProducer)
        .useValue({ enqueueTenantJob: async (queue: string, _w: string, payload: Record<string, unknown>, options: { idempotencyKey: string }) => void enqueued.push({ queue, payload, key: options.idempotencyKey }) });
    },
  });
  let pool: Pool;
  let sessions: SessionService;

  beforeEach(() => {
    google.reset();
    enqueued.length = 0;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    sessions = new SessionService(pool, new MembershipService(new MembershipCacheService()), new InMemoryCacheAdapter());
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.end();
  });

  interface Actor {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly userId: string;
    readonly cookie: string;
    readonly csrf: string;
  }
  const db = (): Client => harness.db();
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  const bare = (a: { cookie: string; csrf: string }) => ({ cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf });
  const headersOf = (a: { cookie: string; csrf: string }) => ({ cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" });

  async function newUser(): Promise<string> {
    const userId = uuidV7();
    await db().query(`INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`, [userId, `${userId}@example.test`]);
    return userId;
  }
  async function project(workspaceId: string, opts: { verified?: boolean; domain?: string } = {}): Promise<string> {
    const id = uuidV7();
    const domain = opts.domain ?? "shop.example.com";
    await db().query(
      "INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, domain_verified_at) VALUES ($1,$2,'P',$3,$4,$5,$6)",
      [id, workspaceId, `p-${id}`, `https://${domain}`, domain, opts.verified === false ? null : new Date()],
    );
    return id;
  }
  async function owner(plan: "growth" | "starter" = "growth", stepUp = true): Promise<Actor> {
    const userId = await newUser();
    const tokens = await sessions.createSession(userId);
    const created = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      headers: headersOf({ cookie: cookieOf(tokens), csrf: tokens.csrfToken }),
      payload: { name: "Acme", org_type: "in_house", region: "us-east-1", timezone: "UTC" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspaceId = data<{ id: string }>(created).id;
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => applyPlanChange(tx, workspaceId, planKeyOnly(plan), { requestId: "R", operator: "test", reason: "test" }));
    } finally {
      client.release();
    }
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 2);
    if (stepUp) await sessions.recordStrongAuth(tokens.sid, "webauthn");
    return { workspaceId, userId, projectId: await project(workspaceId), cookie: cookieOf(entered), csrf: entered.csrfToken };
  }
  async function viewer(workspaceId: string): Promise<Actor> {
    const userId = await newUser();
    await db().query(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'viewer','active')`, [uuidV7(), workspaceId, userId]);
    const tokens = await sessions.createSession(userId);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "viewer", null, 2);
    return { workspaceId, userId, projectId: "", cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  const start = (a: Actor, payload: unknown) => harness.app().inject({ method: "POST", url: apiUrl("/integrations/gsc/oauth/start"), headers: headersOf(a), payload: payload as object });
  const callback = (state: string, binding: string | undefined, extra = "&code=auth-code-1") =>
    harness.app().inject({
      method: "GET",
      url: apiUrl(`/integrations/gsc/oauth/callback?state=${encodeURIComponent(state)}${extra}`),
      headers: binding === undefined ? {} : { cookie: `${OAUTH_BINDING_COOKIE_NAME}=${binding}` },
    });
  type Connection = { id: string; project_id: string; property_url: string; property_type: string; health_status: string; last_error: string | null; last_sync_date: string | null; backfill_completed: boolean; frontier_note: string };

  async function connect(a: Actor, property = "sc-domain:shop.example.com"): Promise<Connection> {
    const started = await start(a, { project_id: a.projectId, property_url: property });
    expect(started.statusCode, started.body).toBe(200);
    const url = new URL(data<{ authorization_url: string }>(started).authorization_url);
    const binding = started.cookies.find((c) => c.name === OAUTH_BINDING_COOKIE_NAME)?.value;
    const done = await callback(url.searchParams.get("state")!, binding);
    expect(done.statusCode, done.body).toBe(200);
    return data<Connection>(done);
  }
  const gscRows = async (a: Actor) => (await db().query("SELECT * FROM gsc_connections WHERE project_id = $1 ORDER BY created_at", [a.projectId])).rows as Array<Record<string, unknown>>;

  // -- processing ------------------------------------------------------------------------------------------------------------------
  async function runSync(a: Actor, connectionId: string, enqueue = vi.fn(async () => undefined)): Promise<void> {
    const context = { pool, env: { NODE_ENV: "test" } } as unknown as QueueHandlerContext;
    const handler = createGscSyncHandler(context, { client: google, enqueue });
    const process = createJobProcessor(ENTRY, {
      keys: KEYS,
      getClient: () => pool.connect(),
      releaseClient: (client) => (client as PoolClient).release(),
      process: handler,
    });
    await process({ data: signQueueJobPayload({ workspaceId: a.workspaceId, kid: "k1", connectionId }, KEYS.current.key) } as unknown as Job);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const dailyCount = async (a: Actor) => Number((await db().query("SELECT count(*)::int AS n FROM gsc_daily WHERE project_id = $1", [a.projectId])).rows[0].n);

  // ===================================================================================================================================
  describe("connection", () => {
    it("S115-1 - authorisation requests the read-only scope set and no write scope", async () => {
      const a = await owner();
      const res = await start(a, { project_id: a.projectId, property_url: "sc-domain:shop.example.com" });
      expect(res.statusCode, res.body).toBe(200);
      const url = new URL(data<{ authorization_url: string }>(res).authorization_url);
      expect((url.searchParams.get("scope") ?? "").split(" ")).toEqual([GSC_READ_ONLY_SCOPE]);
      expect(url.searchParams.get("redirect_uri")).toContain("/v1/integrations/gsc/oauth/callback");
      expect(res.body).not.toMatch(/ACCESS-TOKEN|REFRESH-TOKEN/);
    });

    it("S115-1b - a grant that carries any scope beyond the read-only one is refused and nothing is stored", async () => {
      const a = await owner();
      google.scopes = [GSC_READ_ONLY_SCOPE, "https://www.googleapis.com/auth/webmasters"];
      const started = await start(a, { project_id: a.projectId, property_url: "sc-domain:shop.example.com" });
      const url = new URL(data<{ authorization_url: string }>(started).authorization_url);
      const done = await callback(url.searchParams.get("state")!, started.cookies.find((c) => c.name === OAUTH_BINDING_COOKIE_NAME)?.value);
      expect(done.statusCode).toBe(400);
      expect(await gscRows(a)).toHaveLength(0);
    });

    it("S115-2 - a property that does not match the verified domain is rejected at start and again at the callback, and never synced", async () => {
      const a = await owner();
      const wrong = await start(a, { project_id: a.projectId, property_url: "sc-domain:other-site.example.org" });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.body).not.toContain("authorization_url");
      // The domain matches but the Google account has no such property.
      google.properties = [{ siteUrl: "sc-domain:other-site.example.org", permissionLevel: "siteOwner" }];
      const started = await start(a, { project_id: a.projectId, property_url: "sc-domain:shop.example.com" });
      const url = new URL(data<{ authorization_url: string }>(started).authorization_url);
      const done = await callback(url.searchParams.get("state")!, started.cookies.find((c) => c.name === OAUTH_BINDING_COOKIE_NAME)?.value);
      expect(done.statusCode).toBe(400);
      expect(await gscRows(a)).toHaveLength(0);
      expect(google.reportCalls).toHaveLength(0);
    });

    it("S115-2b - a project whose domain is not verified cannot connect", async () => {
      const a = await owner();
      const unverified = await project(a.workspaceId, { verified: false });
      const res = await start(a, { project_id: unverified, property_url: "sc-domain:shop.example.com" });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: { code: "domain_not_verified" } });
    });

    it("S115-3 - both property types are handled and the type is recorded", async () => {
      const a = await owner();
      const domain = await connect(a, "sc-domain:shop.example.com");
      expect(domain).toMatchObject({ property_type: "domain", property_url: "sc-domain:shop.example.com", health_status: "unknown" });
      const b = { ...a, projectId: await project(a.workspaceId) };
      const prefix = await connect(b, "https://shop.example.com/");
      expect(prefix).toMatchObject({ property_type: "url_prefix", property_url: "https://shop.example.com/" });
      const stored = await db().query("SELECT property_type, scopes FROM gsc_connections WHERE id = ANY($1::uuid[]) ORDER BY property_type", [[domain.id, prefix.id]]);
      expect(stored.rows.map((r) => r.property_type)).toEqual(["domain", "url_prefix"]);
      expect(stored.rows[0].scopes).toEqual([GSC_READ_ONLY_SCOPE]);
    });

    it("S115-4 - credentials are envelope-encrypted and never returned on connect, reload or sync", async () => {
      const a = await owner();
      const connected = await connect(a);
      const reload = await harness.app().inject({ method: "GET", url: apiUrl(`/integrations/gsc/${connected.id}`), headers: { cookie: a.cookie } });
      expect(reload.statusCode, reload.body).toBe(200);
      expect(reload.body).not.toMatch(/ACCESS-TOKEN|REFRESH-TOKEN|credentials|refresh_enc|dek_id/);
      expect(Object.keys(data<object>(reload)).sort()).toEqual(
        ["backfill_completed", "created_at", "frontier_note", "health_status", "id", "last_error", "last_sync_at", "last_sync_date", "project_id", "property_type", "property_url"].sort(),
      );
      const row = (await gscRows(a))[0]!;
      expect(String(row.credentials_enc)).toMatch(/^v1/);
      expect(String(row.credentials_enc)).not.toContain("ACCESS-TOKEN");
      expect(String(row.refresh_enc)).toMatch(/^v1/);
      expect(String(row.refresh_enc)).not.toContain("REFRESH-TOKEN");
    });

    it("S115-5 - a second connection for one project is refused while the first is active", async () => {
      const a = await owner();
      await connect(a);
      const again = await start(a, { project_id: a.projectId, property_url: "https://shop.example.com/" });
      expect(again.statusCode).toBe(409);
      expect(await gscRows(a)).toHaveLength(1);
    });

    it("S115-5b - the callback refuses a missing or foreign binding cookie, a tampered state and a replay, and stores nothing", async () => {
      const a = await owner();
      const started = await start(a, { project_id: a.projectId, property_url: "sc-domain:shop.example.com" });
      const state = new URL(data<{ authorization_url: string }>(started).authorization_url).searchParams.get("state")!;
      const binding = started.cookies.find((c) => c.name === OAUTH_BINDING_COOKIE_NAME)!.value;
      expect((await callback(state, undefined)).statusCode).toBe(400);
      expect((await callback(state, "someone-elses-binding-value")).statusCode).toBe(400);
      expect((await callback(`${state}x`, binding)).statusCode).toBe(400);
      expect((await callback(state, binding, "&error=access_denied")).statusCode).toBe(400);
      expect(await gscRows(a)).toHaveLength(0);
      expect(google.exchangeCode).not.toHaveBeenCalled();
      expect((await callback(state, binding)).statusCode).toBe(200);
      // A second use of the same grant meets the one-active-connection rule.
      expect((await callback(state, binding)).statusCode).toBe(409);
    });

    it("S115-5g - starting needs a fresh step-up: a stale session is 401 step_up_required and nothing is signed", async () => {
      const a = await owner("growth", false);
      const res = await start(a, { project_id: a.projectId, property_url: "sc-domain:shop.example.com" });
      expect(res.statusCode, res.body).toBe(401);
      expect((res.json() as { error: { code: string } }).error.code).toBe("step_up_required");
      expect(res.cookies.find((c) => c.name === OAUTH_BINDING_COOKIE_NAME)).toBeUndefined();
    });

    it("S115-2c - a listing the account holds only as an unverified user is refused at the callback and nothing is stored", async () => {
      const a = await owner();
      google.properties = [{ siteUrl: "sc-domain:shop.example.com", permissionLevel: "siteUnverifiedUser" }];
      const started = await start(a, { project_id: a.projectId, property_url: "sc-domain:shop.example.com" });
      expect(started.statusCode, started.body).toBe(200);
      const url = new URL(data<{ authorization_url: string }>(started).authorization_url);
      const binding = started.cookies.find((c) => c.name === OAUTH_BINDING_COOKIE_NAME)?.value;
      const done = await callback(url.searchParams.get("state")!, binding);
      expect(done.statusCode).toBeGreaterThanOrEqual(400);
      expect(await gscRows(a)).toHaveLength(0);
    });

    it("S115-5c - a viewer cannot start, read the sync or disconnect: 403 naming the permission", async () => {
      const a = await owner();
      const connected = await connect(a);
      const v = await viewer(a.workspaceId);
      const res = await start(v, { project_id: a.projectId, property_url: "sc-domain:shop.example.com" });
      expect(res.statusCode).toBe(403);
      expect(JSON.stringify(res.json())).toContain("workspace:update");
      const del = await harness.app().inject({ method: "DELETE", url: apiUrl(`/integrations/gsc/${connected.id}`), headers: bare(v) });
      expect(del.statusCode).toBe(403);
      const sync = await harness.app().inject({ method: "POST", url: apiUrl(`/integrations/gsc/${connected.id}/sync`), headers: bare(v) });
      expect(sync.statusCode).toBe(403);
    });

    it("S115-5d - the plan must include Search Console: 403 feature_not_in_plan", async () => {
      const a = await owner("starter");
      const res = await start(a, { project_id: a.projectId, property_url: "sc-domain:shop.example.com" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "feature_not_in_plan" } });
    });

    it("S115-5e - the request is strict: an unknown key is a 400", async () => {
      const a = await owner();
      const res = await start(a, { project_id: a.projectId, property_url: "sc-domain:shop.example.com", scope: "write" });
      expect(res.statusCode).toBe(400);
    });

    it("S115-5f - another workspace's connection is a 404 and cannot be disconnected or synced", async () => {
      const a = await owner();
      const connected = await connect(a);
      const stranger = await owner();
      enqueued.length = 0;
      const get = await harness.app().inject({ method: "GET", url: apiUrl(`/integrations/gsc/${connected.id}`), headers: { cookie: stranger.cookie } });
      expect(get.statusCode).toBe(404);
      const del = await harness.app().inject({ method: "DELETE", url: apiUrl(`/integrations/gsc/${connected.id}`), headers: bare(stranger) });
      expect(del.statusCode).toBe(404);
      const sync = await harness.app().inject({ method: "POST", url: apiUrl(`/integrations/gsc/${connected.id}/sync`), headers: bare(stranger) });
      expect(sync.statusCode).toBe(404);
      expect(enqueued).toHaveLength(0);
    });

    it("S115-6a - disconnecting revokes the connection, wipes the credential and keeps every synced row", async () => {
      const a = await owner();
      const connected = await connect(a);
      await runSync(a, connected.id);
      const before = await dailyCount(a);
      expect(before).toBeGreaterThan(0);
      const del = await harness.app().inject({ method: "DELETE", url: apiUrl(`/integrations/gsc/${connected.id}`), headers: bare(a) });
      expect(del.statusCode, del.body).toBe(204);
      const row = (await gscRows(a))[0]!;
      expect(row.revoked_at).not.toBeNull();
      expect(row.health_status).toBe("revoked");
      expect(row.refresh_enc).toBeNull();
      expect(String(row.credentials_enc)).toBe("");
      expect(await dailyCount(a)).toBe(before);
      // Disconnected means a new connection may be made, and the old one syncs nothing more.
      google.reportCalls = [];
      await runSync(a, connected.id);
      expect(google.reportCalls).toHaveLength(0);
      await connect(a);
      expect(await gscRows(a)).toHaveLength(2);
    });

    it("S115-6b - manual sync queues one signed-tenant gsc.sync job, costs nothing, and is keyed per connection and day", async () => {
      const a = await owner();
      const connected = await connect(a);
      enqueued.length = 0;
      const res = await harness.app().inject({ method: "POST", url: apiUrl(`/integrations/gsc/${connected.id}/sync`), headers: bare(a) });
      expect(res.statusCode, res.body).toBe(202);
      expect(data<{ queued: boolean }>(res).queued).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ queue: "gsc.sync", payload: { connectionId: connected.id }, key: `gsc:${connected.id}:${today()}` });
      // No network in the request: Google was not asked anything.
      expect(google.reportCalls).toHaveLength(0);
    });

    it("S115-6c - a disconnected connection cannot be synced by hand", async () => {
      const a = await owner();
      const connected = await connect(a);
      await harness.app().inject({ method: "DELETE", url: apiUrl(`/integrations/gsc/${connected.id}`), headers: bare(a) });
      enqueued.length = 0;
      const res = await harness.app().inject({ method: "POST", url: apiUrl(`/integrations/gsc/${connected.id}/sync`), headers: bare(a) });
      expect(res.statusCode).toBe(409);
      expect(enqueued).toHaveLength(0);
    });
  });

  // ===================================================================================================================================
  describe("sync", () => {
    it("S115-7 - backfill runs to the documented depth in slices, an interruption resumes from the watermark, completion is recorded", async () => {
      const a = await owner();
      const c = await connect(a);
      const enqueue = vi.fn(async () => undefined);
      await runSync(a, c.id, enqueue);
      const first = google.reportCalls[0]!;
      const oldest = ((): string => {
        const d = new Date();
        d.setUTCMonth(d.getUTCMonth() - GSC_BACKFILL_MONTHS);
        return d.toISOString().slice(0, 10);
      })();
      expect(Math.abs((Date.parse(first.startDate) - Date.parse(oldest)) / 86_400_000)).toBeLessThanOrEqual(3);
      expect(first.endDate).toBe(addDays(first.startDate, GSC_SLICE_DAYS - 1));
      let row = (await gscRows(a))[0]!;
      expect(String(row.last_sync_date)).toBeTruthy();
      expect(row.backfill_completed).toBe(false);
      expect(row.health_status).toBe("healthy");
      // The next slice is asked for after commit.
      expect(enqueue).toHaveBeenCalledTimes(1);
      const watermark = (await db().query("SELECT last_sync_date::text AS d FROM gsc_connections WHERE id = $1", [c.id])).rows[0].d as string;
      expect(watermark).toBe(first.endDate);
      // Interrupted: the source fails on the next slice. The watermark must not move.
      google.onReport = () => new GscSourceError("http_503");
      google.reportCalls = [];
      await expect(runSync(a, c.id)).rejects.toThrow();
      expect((await db().query("SELECT last_sync_date::text AS d FROM gsc_connections WHERE id = $1", [c.id])).rows[0].d).toBe(watermark);
      // Resumed: it starts inside the lag window of the stored watermark, not at the beginning, and runs to the frontier.
      google.onReport = (request) => defaultRows(request);
      google.reportCalls = [];
      for (let guard = 0; guard < 40; guard += 1) {
        await runSync(a, c.id);
        row = (await gscRows(a))[0]!;
        if (row.backfill_completed === true) break;
      }
      expect(google.reportCalls[0]!.startDate).toBe(addDays(watermark, -2));
      expect(row.backfill_completed).toBe(true);
      expect(String((await db().query("SELECT last_sync_date::text AS d FROM gsc_connections WHERE id = $1", [c.id])).rows[0].d)).toBe(availableThrough(today()));
    });

    it("S115-8 - running the incremental sync twice stores each row key once", async () => {
      const a = await owner();
      const c = await connect(a);
      for (let i = 0; i < 40 && (await gscRows(a))[0]!.backfill_completed !== true; i += 1) await runSync(a, c.id);
      const sum = async () => (await db().query("SELECT count(*)::int AS n, sum(impressions)::int AS i FROM gsc_daily WHERE project_id = $1", [a.projectId])).rows[0];
      const once = await sum();
      await runSync(a, c.id);
      const twice = await sum();
      expect(twice).toEqual(once);
      const dup = await db().query("SELECT 1 FROM (SELECT project_id, metric_date, report, dimension, page_url_hash, query_hash, country, device FROM gsc_daily GROUP BY 1,2,3,4,5,6,7,8 HAVING count(*) > 1) d");
      expect(dup.rowCount).toBe(0);
    });

    it("S115-9 - a figure revised inside the lag window is picked up on the next sync, a removed row is removed, older days stay", async () => {
      const a = await owner();
      const c = await connect(a);
      for (let i = 0; i < 40 && (await gscRows(a))[0]!.backfill_completed !== true; i += 1) await runSync(a, c.id);
      const frontier = availableThrough(today());
      const insideLag = frontier;
      const older = addDays(frontier, -10);
      const impressionsOn = async (date: string, report = "ai_surface") =>
        (await db().query("SELECT impressions FROM gsc_daily WHERE project_id = $1 AND metric_date = $2 AND report = $3 AND dimension = 'page'", [a.projectId, date, report])).rows.map((r) => r.impressions as number);
      expect(await impressionsOn(insideLag)).toEqual([10]);
      google.onReport = (request) =>
        defaultRows(request)
          .filter((row) => !(request.report === "classic" && request.dimension === "page" && row.date === insideLag))
          .map((row) => ({ ...row, impressions: 99 }));
      await runSync(a, c.id);
      expect(await impressionsOn(insideLag)).toEqual([99]);
      expect(await impressionsOn(insideLag, "classic")).toEqual([]);
      // Outside the re-sync window nothing is rewritten.
      expect(await impressionsOn(older)).toEqual([10]);
    });

    it("S115-10 - the two reports are stored with a discriminator and never conflated", async () => {
      const a = await owner();
      const c = await connect(a);
      await runSync(a, c.id);
      const rows = (await db().query("SELECT report, dimension, page_url, query_text, clicks, ctr, avg_position FROM gsc_daily WHERE project_id = $1", [a.projectId])).rows as Array<Record<string, unknown>>;
      const ai = rows.filter((r) => r.report === "ai_surface");
      const classic = rows.filter((r) => r.report === "classic");
      expect(ai.length).toBeGreaterThan(0);
      expect(classic.length).toBeGreaterThan(0);
      // The AI-surface report has no query dimension, no clicks and no position.
      expect(ai.every((r) => r.dimension === "page" && r.query_text === null && r.clicks === 0 && r.avg_position === null)).toBe(true);
      expect(classic.some((r) => r.dimension === "query" && r.query_text === "best crm for startups")).toBe(true);
      expect(classic.some((r) => r.dimension === "page" && r.page_url !== null)).toBe(true);
      expect(google.reportCalls.filter((r) => r.report === "ai_surface").every((r) => r.dimension === "page")).toBe(true);
    });

    it("S115-12a - an exhausted quota degrades the sync and sets health; the project and every stored row are untouched", async () => {
      const a = await owner();
      const c = await connect(a);
      await runSync(a, c.id);
      const before = await dailyCount(a);
      const watermark = (await gscRows(a))[0]!.last_sync_date;
      google.onReport = () => new GscQuotaError();
      await expect(runSync(a, c.id)).resolves.toBeUndefined();
      const row = (await gscRows(a))[0]!;
      expect(row).toMatchObject({ health_status: "degraded", last_error: "quota_exhausted" });
      expect(row.last_sync_date).toEqual(watermark);
      expect(await dailyCount(a)).toBe(before);
      expect((await db().query("SELECT status FROM projects WHERE id = $1", [a.projectId])).rows[0].status).toBe("active");
      // Resumes at the next run and clears the degradation.
      google.onReport = (request) => defaultRows(request);
      await runSync(a, c.id);
      expect(await gscRows(a)).toMatchObject([{ health_status: "healthy", last_error: null }]);
    });

    it("S115-12b - a report the source cannot serve degrades with its own reason, and the classic data it CAN serve is still stored", async () => {
      const a = await owner();
      const c = await connect(a);
      google.onReport = (request) => (request.report === "ai_surface" ? new GscSourceError("ai_surface_report_unavailable") : defaultRows(request));
      await expect(runSync(a, c.id)).resolves.toBeUndefined();
      expect(await gscRows(a)).toMatchObject([{ health_status: "degraded", last_error: "ai_surface_report_unavailable" }]);
      expect((await gscRows(a))[0]!.last_sync_date).not.toBeNull();
      expect(await dailyCount(a)).toBeGreaterThan(0);
      const byReport = (await db().query("SELECT report, count(*)::int AS n FROM gsc_daily WHERE project_id = $1 GROUP BY report", [a.projectId])).rows as Array<{ report: string; n: number }>;
      expect(byReport.map((r) => r.report)).toEqual(["classic"]);
    });

    it("S115-6d - a revoked credential sets health, notifies, stops syncing, and keeps the historical data", async () => {
      const a = await owner();
      const c = await connect(a);
      await runSync(a, c.id);
      const before = await dailyCount(a);
      google.onReport = () => new GscUnauthorizedError();
      await expect(runSync(a, c.id)).resolves.toBeUndefined();
      const row = (await gscRows(a))[0]!;
      expect(row).toMatchObject({ health_status: "unauthorized", last_error: "credential_revoked" });
      expect(row.revoked_at).toBeNull();
      const notes = await db().query("SELECT kind, severity, project_id, body FROM notifications WHERE workspace_id = $1 AND kind = 'integration_unauthorized'", [a.workspaceId]);
      expect(notes.rowCount).toBe(1);
      expect(notes.rows[0].project_id).toBe(a.projectId);
      expect(JSON.stringify(notes.rows[0])).not.toMatch(/ACCESS-TOKEN|REFRESH-TOKEN|shop\.example\.com/);
      expect(await dailyCount(a)).toBe(before);
      // Stopped: a later run asks Google nothing.
      google.onReport = (request) => defaultRows(request);
      google.reportCalls = [];
      await runSync(a, c.id);
      expect(google.reportCalls).toHaveLength(0);
      expect(google.refreshCalls).toBe(0);
      // Redelivery of the same revocation does not notify twice.
      google.onReport = () => new GscUnauthorizedError();
      await runSync(a, c.id);
      expect((await db().query("SELECT 1 FROM notifications WHERE workspace_id = $1 AND kind = 'integration_unauthorized'", [a.workspaceId])).rowCount).toBe(1);
      // An unauthorized connection may be re-authorised in place, keeping the synced history.
      const again = await connect(a);
      expect(again.id).toBe(c.id);
      expect(again.health_status).toBe("unknown");
      expect(await dailyCount(a)).toBe(before);
      expect(await gscRows(a)).toHaveLength(1);
    });

    it("S115-6e - an expired access token is refreshed before the pull and the new token is stored encrypted", async () => {
      const a = await owner();
      const c = await connect(a);
      const before = String((await gscRows(a))[0]!.credentials_enc);
      await db().query("UPDATE gsc_connections SET token_expires_at = now() - interval '1 hour' WHERE id = $1", [c.id]);
      await runSync(a, c.id);
      expect(google.refreshCalls).toBe(1);
      expect(google.reportCalls.every((r) => r.accessToken === "ACCESS-TOKEN-TWO")).toBe(true);
      const row = (await gscRows(a))[0]!;
      expect(String(row.credentials_enc)).not.toBe(before);
      expect(String(row.credentials_enc)).toMatch(/^v1/);
      expect(String(row.credentials_enc)).not.toContain("ACCESS-TOKEN");
    });

    it("S115-13 - the stored frontier is a past date: no pull reaches today, and the connection states it", async () => {
      const a = await owner();
      const c = await connect(a);
      for (let i = 0; i < 40 && (await gscRows(a))[0]!.backfill_completed !== true; i += 1) await runSync(a, c.id);
      expect(google.reportCalls.every((r) => r.endDate <= availableThrough(today()))).toBe(true);
      expect(google.reportCalls.every((r) => r.endDate < today())).toBe(true);
      const read = await harness.app().inject({ method: "GET", url: apiUrl(`/integrations/gsc/${c.id}`), headers: { cookie: a.cookie } });
      const shown = data<Connection>(read);
      expect(shown.last_sync_date).toBe(availableThrough(today()));
      expect(shown.frontier_note).toMatch(/lags/i);
    });

    it("S115-7z - a job for another workspace's connection, or an unknown one, does nothing", async () => {
      const a = await owner();
      const c = await connect(a);
      const stranger = await owner();
      await runSync(stranger, c.id);
      await runSync(a, randomUUID());
      expect(google.reportCalls).toHaveLength(0);
    });
  });

  // ===================================================================================================================================
  describe("correlation", () => {
    const PAGE = "https://shop.example.com/guide";
    const url = (a: Actor, tf = "30d") => apiUrl(`/projects/${a.projectId}/gsc/correlation?timeframe=${tf}`);
    const read = (a: Actor, tf?: string) => harness.app().inject({ method: "GET", url: url(a, tf), headers: { cookie: a.cookie } });
    type Correlation = {
      connected: boolean; health_status: string | null; window_days: number; window_start: string | null; window_end: string | null; frontier: string | null; frontier_note: string;
      signals: Array<{ key: string; label: string; source: string; frontier: string | null; limits: string }>; independence_note: string; correlation_note: string;
      pages: Array<{ url: string; citations: number; gsc_ai_impressions: number | null; ai_sessions: number | null }>;
      search_queries: Array<{ query: string; report: string; label: string; impressions: number; clicks: number; match: null | { prompt_id: string; method: string; confidence: number; exact: boolean; low_confidence: boolean } }>;
    };

    async function seedConnection(a: Actor, frontier: string): Promise<string> {
      const id = uuidV7();
      await db().query(
        `INSERT INTO gsc_connections (id, workspace_id, project_id, property_url, property_type, credentials_enc, dek_id, scopes, last_sync_date, backfill_completed, health_status)
         VALUES ($1,$2,$3,'sc-domain:shop.example.com','domain','x','k',ARRAY[$4],$5,true,'healthy')`,
        [id, a.workspaceId, a.projectId, GSC_READ_ONLY_SCOPE, frontier],
      );
      return id;
    }
    async function gsc(a: Actor, report: "ai_surface" | "classic", dimension: "page" | "query", date: string, key: string, figures: { impressions: number; clicks?: number }): Promise<void> {
      await db().query(
        `INSERT INTO gsc_daily (workspace_id, project_id, metric_date, report, dimension, page_url, page_url_hash, query_text, query_hash, impressions, clicks, country, device)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ZZ','desktop')`,
        [
          a.workspaceId, a.projectId, date, report, dimension,
          dimension === "page" ? key : null,
          dimension === "page" ? Buffer.from(key) : Buffer.alloc(0),
          dimension === "query" ? key : null,
          dimension === "query" ? Buffer.from(key) : Buffer.alloc(0),
          figures.impressions, figures.clicks ?? 0,
        ],
      );
    }
    async function cite(a: Actor, pageUrl: string, date: string, n = 1): Promise<void> {
      for (let i = 0; i < n; i += 1) {
        await db().query(
          `INSERT INTO citation_facts (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url, url_hash, domain, is_owned, position_weight)
           VALUES ($1,$2,$3,$4,'gemini',$5,$6,$7::text,$7::text,sha256(convert_to($7::text,'UTF8')),'shop.example.com',true,1)`,
          [a.workspaceId, a.projectId, uuidV7(), uuidV7(), `${date}T10:00:00Z`, i, pageUrl],
        );
      }
    }
    async function prompt(a: Actor, text: string): Promise<string> {
      const id = uuidV7();
      await db().query(
        `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status) VALUES ($1,$2,$3,$4,sha256(convert_to($4,'UTF8')),'recommendation','consideration','active')`,
        [id, a.workspaceId, a.projectId, text],
      );
      return id;
    }

    it("S115-14 - the page join is exact on the shared normalised hash: variants of one URL meet, a different URL does not", async () => {
      const a = await owner();
      const frontier = availableThrough(today());
      await seedConnection(a, frontier);
      await cite(a, "https://shop.example.com/guide/", addDays(frontier, -2), 3);
      await cite(a, "https://SHOP.example.com:443/guide?utm_source=chatgpt.com", addDays(frontier, -3), 2);
      await cite(a, "https://shop.example.com/pricing", addDays(frontier, -2), 4);
      await gsc(a, "ai_surface", "page", addDays(frontier, -2), "https://www.shop.example.com/guide#top", { impressions: 700 });
      await gsc(a, "ai_surface", "page", addDays(frontier, -4), PAGE, { impressions: 300 });
      const res = await read(a);
      expect(res.statusCode, res.body).toBe(200);
      const body = data<Correlation>(res);
      const guide = body.pages.find((p) => p.url === PAGE)!;
      expect(guide).toMatchObject({ citations: 5, gsc_ai_impressions: 1000 });
      const pricing = body.pages.find((p) => p.url === "https://shop.example.com/pricing")!;
      // Cited by us, no AI-surface row from Google: unknown, never zero.
      expect(pricing).toMatchObject({ citations: 4, gsc_ai_impressions: null });
    });

    it("S115-10b - no figure is served from a mixture: AI impressions come only from the AI-surface report, search queries only from the classic one", async () => {
      const a = await owner();
      const frontier = availableThrough(today());
      await seedConnection(a, frontier);
      const day = addDays(frontier, -1);
      await gsc(a, "classic", "page", day, PAGE, { impressions: 5000, clicks: 400 });
      await gsc(a, "ai_surface", "page", day, PAGE, { impressions: 40 });
      await gsc(a, "classic", "query", day, "best crm for startups", { impressions: 90, clicks: 9 });
      const body = data<Correlation>(await read(a));
      expect(body.pages.find((p) => p.url === PAGE)!.gsc_ai_impressions).toBe(40);
      expect(body.search_queries).toHaveLength(1);
      expect(body.search_queries[0]).toMatchObject({ query: "best crm for startups", report: "classic", impressions: 90, clicks: 9 });
      expect(JSON.stringify(body)).not.toContain("5000");
      // Only classic page rows exist for this page: it must read as no AI-surface figure, not as the classic impressions.
      const other = await owner();
      await seedConnection(other, frontier);
      await gsc(other, "classic", "page", day, PAGE, { impressions: 5000, clicks: 400 });
      await cite(other, PAGE, day, 1);
      const alone = data<Correlation>(await read(other));
      expect(alone.pages.find((p) => p.url === PAGE)).toMatchObject({ citations: 1, gsc_ai_impressions: null });
    });

    it("S115-11 - classic-report queries are labelled as search queries, not AI prompts", async () => {
      const a = await owner();
      const frontier = availableThrough(today());
      await seedConnection(a, frontier);
      await gsc(a, "classic", "query", addDays(frontier, -1), "cheap flights to lisbon", { impressions: 12 });
      const body = data<Correlation>(await read(a));
      expect(body.search_queries[0]!.label).toMatch(/search query/i);
      expect(body.search_queries[0]!.label).toMatch(/not an AI prompt/i);
      expect(body.search_queries[0]).not.toHaveProperty("prompt_id");
    });

    it("S115-15 - a joined query carries its method and confidence and is never labelled exact", async () => {
      const a = await owner();
      const frontier = availableThrough(today());
      await seedConnection(a, frontier);
      const promptId = await prompt(a, "best crm for small business");
      await gsc(a, "classic", "query", addDays(frontier, -1), "best crm for small businesses", { impressions: 30 });
      const q = data<Correlation>(await read(a)).search_queries[0]!;
      expect(q.match).toMatchObject({ prompt_id: promptId, method: "trigram", exact: false });
      expect(q.match!.confidence).toBeGreaterThanOrEqual(0.8);
      expect(q.match!.confidence).toBeLessThanOrEqual(1);
      expect(typeof q.match!.low_confidence).toBe("boolean");
    });

    it("S115-17 - a fuzzy match below the floor is not joined at all", async () => {
      const a = await owner();
      const frontier = availableThrough(today());
      await seedConnection(a, frontier);
      await prompt(a, "best crm for startups");
      await gsc(a, "classic", "query", addDays(frontier, -1), "best crm for enterprises", { impressions: 30 });
      const q = data<Correlation>(await read(a)).search_queries[0]!;
      expect(q.match).toBeNull();
    });

    it("S115-13b - the window ends at the stored frontier: data after it is never counted, and an unsynced project has no window", async () => {
      const a = await owner();
      const frontier = addDays(today(), -10);
      await seedConnection(a, frontier);
      await cite(a, PAGE, addDays(frontier, -1), 2);
      await cite(a, PAGE, addDays(frontier, 3), 7);
      await gsc(a, "ai_surface", "page", addDays(frontier, -1), PAGE, { impressions: 10 });
      await gsc(a, "ai_surface", "page", addDays(frontier, 3), PAGE, { impressions: 9999 });
      const body = data<Correlation>(await read(a, "7d"));
      expect(body.window_end).toBe(frontier);
      expect(body.window_start).toBe(addDays(frontier, -6));
      expect(body.frontier).toBe(frontier);
      expect(body.pages.find((p) => p.url === PAGE)).toMatchObject({ citations: 2, gsc_ai_impressions: 10 });
      const fresh = await owner();
      await db().query(
        `INSERT INTO gsc_connections (workspace_id, project_id, property_url, property_type, credentials_enc, dek_id, scopes) VALUES ($1,$2,'sc-domain:shop.example.com','domain','x','k',ARRAY['r'])`,
        [fresh.workspaceId, fresh.projectId],
      );
      await cite(fresh, PAGE, addDays(today(), -1), 3);
      const empty = data<Correlation>(await read(fresh));
      expect(empty).toMatchObject({ connected: true, frontier: null, window_start: null, window_end: null, pages: [], search_queries: [] });
    });

    it("S115-18/19/20 - impressions sit beside our citations with their own limitation note; three independent signals; correlation only; every figure states source, frontier and limits", async () => {
      const a = await owner();
      const frontier = availableThrough(today());
      await seedConnection(a, frontier);
      await cite(a, PAGE, addDays(frontier, -1), 2);
      await gsc(a, "ai_surface", "page", addDays(frontier, -1), PAGE, { impressions: 80 });
      const body = data<Correlation>(await read(a));
      expect(body.signals.map((s) => s.key)).toEqual(["citations", "ai_surface_impressions", "ai_sessions"]);
      for (const signal of body.signals) {
        expect(signal.source.length).toBeGreaterThan(0);
        expect(signal.limits.length).toBeGreaterThan(0);
        expect(signal.label.length).toBeGreaterThan(0);
      }
      expect(body.signals.find((s) => s.key === "ai_surface_impressions")).toMatchObject({ frontier });
      expect(body.signals.find((s) => s.key === "ai_surface_impressions")!.limits).toMatch(/no query|not a measure of citation/i);
      expect(new Set(body.signals.map((s) => s.limits)).size).toBe(3);
      expect(body.independence_note).toMatch(/three independent measurements/i);
      expect(body.independence_note).toMatch(/none .* answers the outcome question/i);
      expect(body.correlation_note).toMatch(/correlation only/i);
      expect(JSON.stringify(body)).not.toMatch(/\b(caused|causes|causing|because of|drove|driven by|led to)\b/i);
      expect(body.frontier_note).toMatch(/lags/i);
      // A figure of ours and Google's never share a field.
      const row = body.pages[0]!;
      expect(Object.keys(row).sort()).toEqual(["ai_sessions", "citations", "gsc_ai_impressions", "url"]);
    });

    it("S115-18b - with no AI-surface row ever stored the AI-surface signal claims no frontier, however healthy the connection", async () => {
      const a = await owner();
      const frontier = availableThrough(today());
      await seedConnection(a, frontier);
      await cite(a, PAGE, addDays(frontier, -1), 2);
      const body = data<Correlation>(await read(a));
      expect(body.signals.find((s) => s.key === "ai_surface_impressions")).toMatchObject({ frontier: null });
      expect(body.signals.find((s) => s.key === "citations")).toMatchObject({ frontier });
      expect(body.pages[0]!.gsc_ai_impressions).toBeNull();
    });

    it("S115-14b - a query on a cited or reported page does not split it from the beacon's query-free row: one page, the real session count", async () => {
      const a = await owner();
      const frontier = availableThrough(today());
      await seedConnection(a, frontier);
      await cite(a, "https://shop.example.com/guide?id=5", addDays(frontier, -1), 2);
      await gsc(a, "ai_surface", "page", addDays(frontier, -1), "https://shop.example.com/guide?id=6", { impressions: 10 });
      await db().query(
        `INSERT INTO attribution_configs (id, workspace_id, project_id, method, site_token, site_token_hash, allowed_origins, status) VALUES ($1,$2,$3,'script','tok',sha256(convert_to($4::text,'UTF8')),ARRAY['https://shop.example.com'],'receiving')`,
        [uuidV7(), a.workspaceId, a.projectId, uuidV7()],
      );
      await db().query(
        `INSERT INTO attribution_daily (workspace_id, project_id, metric_date, landing_url_hash, landing_url, referrer_class, sessions, conversions, country, device)
         VALUES ($1,$2,$3,sha256(convert_to($4::text,'UTF8')),$4::text,'chatgpt',50,0,'ZZ','desktop')`,
        [a.workspaceId, a.projectId, addDays(frontier, -1), PAGE],
      );
      const pages = data<Correlation>(await read(a)).pages;
      expect(pages).toHaveLength(1);
      expect(pages[0]).toMatchObject({ url: PAGE, citations: 2, gsc_ai_impressions: 10, ai_sessions: 50 });
    });

    it("S115-20b - sessions are null without a beacon and a number with one; they never include unattributed direct", async () => {
      const a = await owner();
      const frontier = availableThrough(today());
      await seedConnection(a, frontier);
      await cite(a, PAGE, addDays(frontier, -1), 1);
      expect(data<Correlation>(await read(a)).pages[0]!.ai_sessions).toBeNull();
      await db().query(
        `INSERT INTO attribution_configs (id, workspace_id, project_id, method, site_token, site_token_hash, allowed_origins, status) VALUES ($1,$2,$3,'script','tok',sha256(convert_to($4::text,'UTF8')),ARRAY['https://shop.example.com'],'receiving')`,
        [uuidV7(), a.workspaceId, a.projectId, uuidV7()],
      );
      await db().query(
        `INSERT INTO attribution_daily (workspace_id, project_id, metric_date, landing_url_hash, landing_url, referrer_class, sessions, conversions, country, device)
         VALUES ($1,$2,$3,sha256(convert_to($4::text,'UTF8')),$4::text,'chatgpt',30,0,'ZZ','desktop'), ($1,$2,$3,sha256(convert_to($4::text,'UTF8')),$4::text,'unattributed_direct',900,0,'ZZ','desktop')`,
        [a.workspaceId, a.projectId, addDays(frontier, -1), PAGE],
      );
      expect(data<Correlation>(await read(a)).pages.find((p) => p.url === PAGE)!.ai_sessions).toBe(30);
    });

    it("S115-20c - not connected: nothing is invented", async () => {
      const a = await owner();
      await cite(a, PAGE, addDays(today(), -5), 2);
      const body = data<Correlation>(await read(a));
      expect(body).toMatchObject({ connected: false, health_status: null, frontier: null, window_start: null, window_end: null, pages: [], search_queries: [] });
      expect(body.signals).toHaveLength(3);
    });

    it("S115-20d - an unknown project is a 404, another workspace's project is not readable, a bad timeframe is a 400", async () => {
      const a = await owner();
      const stranger = await owner();
      const foreign = await harness.app().inject({ method: "GET", url: apiUrl(`/projects/${a.projectId}/gsc/correlation`), headers: { cookie: stranger.cookie } });
      expect([403, 404]).toContain(foreign.statusCode);
      const bad = await harness.app().inject({ method: "GET", url: url(a, "1y"), headers: { cookie: a.cookie } });
      expect(bad.statusCode).toBe(400);
      const none = await harness.app().inject({ method: "GET", url: apiUrl(`/projects/${randomUUID()}/gsc/correlation`), headers: { cookie: a.cookie } });
      expect([403, 404]).toContain(none.statusCode);
    });
  });
});
