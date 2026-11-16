import { createHash } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { ATTRIBUTION_INGEST_LIMIT_PER_MINUTE } from "../../src/modules/attribution/attribution-ingest.service.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-113 - attribution config (GET/POST/DELETE) and the aggregate-at-ingest beacon, through the REAL ApiModule on a real
// Postgres with the application running as nominara_app (NOBYPASSRLS), so a missing tenant context fails here rather than in
// production. Scenario numbers are the story's Test scenarios table.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;
const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();
const ORIGIN = "https://shop.example.com";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TestAgent/1.0";

describe("STORY-113 - attribution configuration and beacon", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({
    runAsAppRole: true,
    env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }),
  });
  let pool: Pool;
  let sessions: SessionService;

  beforeAll(async () => {
    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop()]);
  });
  beforeEach(() => {
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
    readonly cookie: string;
    readonly csrf: string;
  }
  const db = (): Client => harness.db();

  async function newUser(): Promise<string> {
    const userId = uuidV7();
    await db().query(`INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`, [userId, `${userId}@example.test`]);
    return userId;
  }

  async function project(workspaceId: string): Promise<string> {
    const id = uuidV7();
    await db().query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://shop.example.com','shop.example.com')", [id, workspaceId, `p-${id.slice(0, 8)}`]);
    return id;
  }

  async function owner(opts: { stepUp?: boolean } = {}): Promise<Actor> {
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
    // A plan change bumps the entitlement version the session is minted against (as every workspace-owning spec does).
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyPlanChange(tx, workspaceId, planKeyOnly("growth"), { requestId: "R", operator: "test", reason: "test" }),
      );
    } finally {
      client.release();
    }
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 2);
    if (opts.stepUp !== false) await sessions.recordStrongAuth(tokens.sid, "webauthn");
    return { workspaceId, projectId: await project(workspaceId), cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  async function viewer(workspaceId: string): Promise<Actor> {
    const userId = await newUser();
    await db().query(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'viewer','active')`, [uuidV7(), workspaceId, userId]);
    const tokens = await sessions.createSession(userId);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "viewer", null, 2);
    return { workspaceId, projectId: "", cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  const configUrl = (a: Actor): string => apiUrl(`/projects/${a.projectId}/attribution/config`);
  const create = (a: Actor, payload: unknown = { method: "script", allowed_origins: [ORIGIN], conversion_events: ["signup"] }) =>
    harness.app().inject({ method: "POST", url: configUrl(a), headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" }, payload: payload as object });
  const read = (a: Actor) => harness.app().inject({ method: "GET", url: configUrl(a), headers: { cookie: a.cookie } });
  const remove = (a: Actor) => harness.app().inject({ method: "DELETE", url: configUrl(a), headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf } });
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  type Config = { id: string; site_token: string; status: string; receiving: boolean; first_event_at: string | null; last_event_at: string | null; snippet: string | null; credentials_stored: boolean };

  const beacon = (payload: unknown, headers: Record<string, string> = {}) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl("/ingest/attribution"),
      headers: { origin: ORIGIN, "user-agent": DESKTOP_UA, "cf-ipcountry": "DE", "content-type": "application/json", ...headers },
      payload: payload as object,
    });
  const event = (token: string, over: Record<string, unknown> = {}) => ({ site_token: token, landing_url: "https://shop.example.com/guide?utm_source=chatgpt.com", referrer: "https://chatgpt.com/", ...over });
  const dailyRows = async (projectId: string) =>
    (await db().query("SELECT * FROM attribution_daily WHERE project_id = $1 ORDER BY referrer_class", [projectId])).rows as Array<Record<string, unknown>>;

  async function connected(a?: Actor): Promise<{ actor: Actor; token: string; config: Config }> {
    const actor = a ?? (await owner());
    const res = await create(actor);
    expect(res.statusCode, res.body).toBe(201);
    const config = data<Config>(res);
    return { actor, token: config.site_token, config };
  }

  // ---- configuration ----

  it("STORY-113 S1 - creates a script configuration with a public token and its stored hash; one active per project", async () => {
    const { actor, token, config } = await connected();
    expect(token).toMatch(/^nat_/);
    expect(config.status).toBe("pending");
    expect(config.snippet).toContain(token);
    const row = (await db().query("SELECT site_token, site_token_hash, method FROM attribution_configs WHERE project_id = $1", [actor.projectId])).rows[0] as { site_token: string; site_token_hash: Buffer; method: string };
    expect(row.site_token).toBe(token);
    expect(row.site_token_hash.equals(sha256(token))).toBe(true);
    expect(row.method).toBe("script");
    const again = await create(actor);
    expect(again.statusCode, again.body).toBe(409);
  }, 120_000);

  it("STORY-113 S1 - creates a ga4 configuration (no snippet) and a project may reconnect after disconnecting", async () => {
    const a = await owner();
    const res = await create(a, { method: "ga4", ga4_property_id: "123456789", ga4_credentials: '{"type":"service_account","private_key":"PLAINTEXT-SECRET-VALUE"}' });
    expect(res.statusCode, res.body).toBe(201);
    expect(data<Config>(res).snippet).toBeNull();
    expect((await remove(a)).statusCode).toBe(204);
    expect((await create(a)).statusCode).toBe(201);
  }, 120_000);

  it("STORY-113 S2 - provider credentials are encrypted at rest and never returned", async () => {
    const a = await owner();
    const secret = "PLAINTEXT-SECRET-VALUE";
    const created = await create(a, { method: "ga4", ga4_property_id: "123456789", ga4_credentials: secret });
    expect(created.body).not.toContain(secret);
    expect(data<Config>(created).credentials_stored).toBe(true);
    const reloaded = await read(a);
    expect(reloaded.body).not.toContain(secret);
    expect(reloaded.body).not.toContain("ga4_credentials");
    const stored = (await db().query("SELECT ga4_credentials_enc, dek_id FROM attribution_configs WHERE project_id = $1", [a.projectId])).rows[0] as { ga4_credentials_enc: string; dek_id: string };
    expect(stored.ga4_credentials_enc.startsWith("v1:")).toBe(true);
    expect(stored.ga4_credentials_enc).not.toContain(secret);
    expect(stored.dek_id).toBeTruthy();
    await remove(a);
    const wiped = (await db().query("SELECT ga4_credentials_enc, dek_id, status FROM attribution_configs WHERE project_id = $1", [a.projectId])).rows[0] as Record<string, unknown>;
    expect(wiped).toEqual({ ga4_credentials_enc: null, dek_id: null, status: "disabled" });
  }, 120_000);

  it("STORY-113 - a strict body: an unknown key, a credential on the script method, and a path in an origin are each a 400", async () => {
    const a = await owner();
    for (const payload of [
      { method: "script", allowed_origins: [ORIGIN], visitor_id: "v1" },
      { method: "script", allowed_origins: [ORIGIN], ga4_credentials: "x" },
      { method: "script", allowed_origins: ["https://shop.example.com/path"] },
      { method: "script", allowed_origins: [] },
    ]) {
      expect((await create(a, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
  }, 120_000);

  it("STORY-113 - the writes need workspace:update and a fresh step-up; a viewer may not even read", async () => {
    const stale = await owner({ stepUp: false });
    const refused = await create(stale);
    expect(refused.statusCode, refused.body).toBe(401);
    expect((refused.json() as { error: { code: string } }).error.code).toBe("step_up_required");
    const v = await viewer(stale.workspaceId);
    const denied = await harness.app().inject({ method: "GET", url: configUrl({ ...v, projectId: stale.projectId }), headers: { cookie: v.cookie } });
    expect(denied.statusCode).toBe(403);
  }, 120_000);

  it("STORY-113 S16 - with nothing connected the section is usable: GET answers an empty configuration, not an error", async () => {
    const a = await owner();
    const res = await read(a);
    expect(res.statusCode, res.body).toBe(200);
    expect(data<{ config: unknown }>(res)).toEqual({ config: null });
  }, 120_000);

  it("STORY-113 - a project of another workspace is a 404, not a configuration", async () => {
    const a = await owner();
    const other = await owner();
    const res = await harness.app().inject({ method: "GET", url: apiUrl(`/projects/${other.projectId}/attribution/config`), headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(404);
  }, 120_000);

  // ---- ingest ----

  it("STORY-113 S3 - a conversion is counted with its value and is never a second session; one the configuration does not list is not counted", async () => {
    const { actor, token } = await connected();
    await beacon(event(token)); // the landing: one session
    const counted = await beacon(event(token, { conversion: { name: "signup", value: 19.5 } }));
    expect(data<{ conversion_counted: boolean }>(counted).conversion_counted).toBe(true);
    const unlisted = await beacon(event(token, { conversion: { name: "something_else", value: 5 } }));
    expect(unlisted.statusCode).toBe(202);
    expect(data<{ conversion_counted: boolean }>(unlisted).conversion_counted).toBe(false);
    const rows = await dailyRows(actor.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessions: 1, conversions: 1, conversion_value: "19.50" });
  }, 120_000);

  // ---- decision 86: the tab's AI source class, carried to a later conversion ----
  const THANKS = "https://shop.example.com/signup/thanks";
  const sameSite = (token: string, over: Record<string, unknown> = {}) => event(token, { landing_url: THANKS, referrer: "https://shop.example.com/pricing", ...over });

  it("STORY-113 S3b - a listed conversion whose referrer is same-site counts for the class the tab carried: a conversion, never a session", async () => {
    const { actor, token } = await connected();
    const res = await beacon(sameSite(token, { source_class: "chatgpt", conversion: { name: "signup", value: 10 } }));
    expect(data<{ recorded: boolean; conversion_counted: boolean }>(res)).toMatchObject({ recorded: true, conversion_counted: true });
    const rows = await dailyRows(actor.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ referrer_class: "chatgpt", sessions: 0, conversions: 1, conversion_value: "10.00" });
  }, 120_000);

  it("STORY-113 S3c - an empty referrer (a stripped one) also takes the carried class for a listed conversion", async () => {
    const { actor, token } = await connected();
    const res = await beacon(sameSite(token, { referrer: "", source_class: "gemini", conversion: { name: "signup" } }));
    expect(data<{ conversion_counted: boolean }>(res).conversion_counted).toBe(true);
    expect((await dailyRows(actor.projectId))[0]).toMatchObject({ referrer_class: "gemini", sessions: 0, conversions: 1 });
  }, 120_000);

  it("STORY-113 S3d - a claimed class never turns a pageview into an AI session", async () => {
    const { actor, token } = await connected();
    const same = await beacon(sameSite(token, { source_class: "chatgpt" }));
    expect(data<{ recorded: boolean }>(same).recorded).toBe(false);
    const empty = await beacon(sameSite(token, { referrer: "", source_class: "chatgpt" }));
    expect(empty.statusCode).toBe(202);
    expect((await dailyRows(actor.projectId)).filter((r) => r.referrer_class === "chatgpt")).toHaveLength(0);
  }, 120_000);

  it("STORY-113 S3e - a claimed class does not override a real AI referrer, and an unlisted conversion or a foreign non-AI referrer takes nothing from it", async () => {
    const { actor, token } = await connected();
    await beacon(event(token, { referrer: "https://perplexity.ai/", source_class: "chatgpt", conversion: { name: "signup" } }));
    const unlisted = await beacon(sameSite(token, { source_class: "chatgpt", conversion: { name: "other_goal" } }));
    expect(data<{ conversion_counted: boolean }>(unlisted).conversion_counted).toBe(false);
    const foreign = await beacon(sameSite(token, { referrer: "https://www.google.com/", source_class: "chatgpt", conversion: { name: "signup" } }));
    expect(data<{ conversion_counted: boolean }>(foreign).conversion_counted).toBe(false);
    const rows = await dailyRows(actor.projectId);
    expect(rows.map((r) => r.referrer_class)).toEqual(["perplexity"]);
    expect(rows[0]).toMatchObject({ sessions: 0, conversions: 1 });
  }, 120_000);

  it("STORY-113 S3f - the class is a closed enum: the unattributed floor, an unknown name and a non-string are a 400", async () => {
    const { token } = await connected();
    for (const bad of ["unattributed_direct", "evil", "", 5, null]) {
      const res = await beacon(sameSite(token, { source_class: bad, conversion: { name: "signup" } }));
      expect(res.statusCode, String(bad)).toBe(400);
    }
  }, 120_000);

  it("STORY-113 S3g - an AI-referred landing answers its class for the snippet to keep; a direct visit answers none", async () => {
    const { token } = await connected();
    expect(data<{ source_class?: string }>(await beacon(event(token))).source_class).toBe("chatgpt");
    expect(data<{ source_class?: string }>(await beacon(event(token, { referrer: "" , landing_url: "https://shop.example.com/guide" }))).source_class).toBeUndefined();
  }, 120_000);

  it("STORY-113 S3h - the snippet keeps the class in sessionStorage only: no cookie, no localStorage, no visitor id", async () => {
    const { config } = await connected();
    expect(config.snippet).toContain("sessionStorage");
    expect(config.snippet).not.toMatch(/document\.cookie|localStorage|visitor/i);
  }, 120_000);

  it("STORY-113 S4c - captures EVERY write of a class-carrying conversion: only the two attribution tables, and nothing per-visitor in any parameter", async () => {
    const { token } = await connected();
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const original = Client.prototype.query as (...args: unknown[]) => unknown;
    vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
      const first = args[0];
      const text = typeof first === "string" ? first : ((first as { text?: string })?.text ?? "");
      const values = (typeof first === "string" ? args[1] : (first as { values?: unknown[] })?.values) as unknown[] | undefined;
      statements.push({ text, values: Array.isArray(values) ? values : [] });
      return original.apply(this, args);
    } as never);
    const res = await beacon(sameSite(token, { source_class: "claude", conversion: { name: "signup" } }), { cookie: "sid=SESSION-COOKIE-VALUE", "x-forwarded-for": "203.0.113.77" });
    expect(res.statusCode, res.body).toBe(202);
    const writes = statements.filter((st) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(st.text));
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.text, write.text).toMatch(/\b(attribution_daily|attribution_configs)\b/);
      for (const value of write.values) {
        const flat = Buffer.isBuffer(value) ? "" : String(value);
        for (const forbidden of ["203.0.113.77", "127.0.0.1", "TestAgent", "SESSION-COOKIE-VALUE", token, "/pricing"]) expect(flat).not.toContain(forbidden);
      }
    }
    expect(res.headers["set-cookie"]).toBeUndefined();
  }, 120_000);

  it("STORY-113 S4 - captures EVERY write during ingest: only the two attribution tables, and no address, agent, cookie or token in any parameter", async () => {
    const { token } = await connected();
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const original = Client.prototype.query as (...args: unknown[]) => unknown;
    vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
      const first = args[0];
      const text = typeof first === "string" ? first : ((first as { text?: string })?.text ?? "");
      const values = (typeof first === "string" ? args[1] : (first as { values?: unknown[] })?.values) as unknown[] | undefined;
      statements.push({ text, values: Array.isArray(values) ? values : [] });
      return original.apply(this, args);
    } as never);
    const res = await beacon(event(token), { cookie: "sid=SESSION-COOKIE-VALUE", "x-forwarded-for": "203.0.113.77" });
    expect(res.statusCode, res.body).toBe(202);
    const writes = statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s.text));
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.text, write.text).toMatch(/\b(attribution_daily|attribution_configs)\b/);
      for (const value of write.values) {
        const flat = Buffer.isBuffer(value) ? "" : String(value);
        expect(flat).not.toContain("203.0.113.77");
        expect(flat).not.toContain("127.0.0.1");
        expect(flat).not.toContain("TestAgent");
        expect(flat).not.toContain("SESSION-COOKIE-VALUE");
        expect(flat).not.toContain(token);
      }
    }
    // And the response sets no cookie.
    expect(res.headers["set-cookie"]).toBeUndefined();
  }, 120_000);

  it("STORY-113 S4b - a direct visit to a URL carrying a secret or an address in its query stores neither: the query and fragment are dropped at ingest", async () => {
    const { actor, token } = await connected();
    const statements: Array<{ values: unknown[] }> = [];
    const original = Client.prototype.query as (...args: unknown[]) => unknown;
    vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
      const first = args[0];
      const values = (typeof first === "string" ? args[1] : (first as { values?: unknown[] })?.values) as unknown[] | undefined;
      statements.push({ values: Array.isArray(values) ? values : [] });
      return original.apply(this, args);
    } as never);
    const res = await beacon(event(token, { landing_url: "https://shop.example.com/reset?token=SECRET123&email=a@b.com#frag-secret", referrer: "" }));
    expect(res.statusCode, res.body).toBe(202);
    for (const statement of statements) {
      for (const value of statement.values) {
        const flat = Buffer.isBuffer(value) ? "" : String(value);
        expect(flat).not.toContain("SECRET123");
        expect(flat).not.toContain("a@b.com");
        expect(flat).not.toContain("frag-secret");
      }
    }
    vi.restoreAllMocks();
    const row = (await dailyRows(actor.projectId))[0]!;
    expect(row).toMatchObject({ landing_url: "https://shop.example.com/reset", referrer_class: "unattributed_direct" });
  }, 120_000);

  it("STORY-113 S5 - schema inspection: no column exists for a visitor, session, cookie, fingerprint, address or agent", async () => {
    const cols = (await db().query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('attribution_daily','attribution_configs')`)).rows as Array<{ table_name: string; column_name: string }>;
    const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
    expect(names.filter((n) => /visitor|session_id|session_key|session_token|cookie|fingerprint|(^|_)ip(_|$)|address|user_agent|(^|_)ua(_|$)|device_id|client_id/i.test(n.split(".")[1]!))).toEqual([]);
    expect(cols.filter((c) => c.table_name === "attribution_daily").map((c) => c.column_name).sort()).toEqual(
      ["bounce_sessions", "conversion_value", "conversions", "country", "device", "ingested_at", "landing_url", "landing_url_hash", "metric_date", "project_id", "referrer_class", "sessions", "workspace_id"].sort(),
    );
  }, 120_000);

  it("STORY-113 S6 - a stored row holds only the landing URL, the referrer class, a coarse country and a device category", async () => {
    const { actor, token } = await connected();
    await beacon(event(token, { landing_url: "https://Shop.example.com/guide/?utm_source=chatgpt.com&gclid=abc#frag" }), { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148", "cf-ipcountry": "fr" });
    const row = (await dailyRows(actor.projectId))[0]!;
    expect(row).toMatchObject({ landing_url: "https://shop.example.com/guide", referrer_class: "chatgpt", country: "FR", device: "mobile" });
    expect(JSON.stringify(row)).not.toMatch(/gclid|Mozilla|iPhone|frag/);
  }, 120_000);

  it("STORY-113 S7 - a stripped-referrer event is recorded in the unattributed class", async () => {
    const { actor, token } = await connected();
    const res = await beacon(event(token, { landing_url: "https://shop.example.com/pricing", referrer: "" }));
    expect(res.statusCode).toBe(202);
    expect((await dailyRows(actor.projectId)).map((r) => r.referrer_class)).toEqual(["unattributed_direct"]);
  }, 120_000);

  it("STORY-113 S8 - an event from an unrecognised AI host lands in other_ai, not dropped; a non-AI referrer stores nothing", async () => {
    const { actor, token } = await connected();
    await beacon(event(token, { landing_url: "https://shop.example.com/a", referrer: "https://brand-new-engine.ai/chat" }));
    const nonAi = await beacon(event(token, { landing_url: "https://shop.example.com/b", referrer: "https://www.google.com/" }));
    expect(data<{ recorded: boolean }>(nonAi).recorded).toBe(false);
    expect((await dailyRows(actor.projectId)).map((r) => r.referrer_class)).toEqual(["other_ai"]);
  }, 120_000);

  it("STORY-113 S9 - a disallowed, absent or lookalike origin is refused and the token grants nothing", async () => {
    const { actor, token } = await connected();
    for (const origin of ["https://evil.example", "https://shop.example.com.evil.example", "http://shop.example.com"]) {
      const res = await beacon(event(token), { origin });
      expect(res.statusCode, origin).toBe(404);
    }
    const noOrigin = await harness.app().inject({ method: "POST", url: apiUrl("/ingest/attribution"), headers: { "content-type": "application/json" }, payload: event(token) });
    expect(noOrigin.statusCode).toBe(404);
    expect(await dailyRows(actor.projectId)).toHaveLength(0);
    expect((await beacon(event("nat_not-a-real-token"))).statusCode).toBe(404);
  }, 120_000);

  it("STORY-113 S9b - an origin typed in capitals is stored case-folded, so the beacon from that site is accepted rather than refused forever", async () => {
    const a = await owner();
    const created = await create(a, { method: "script", allowed_origins: ["https://Shop.Example.com"] });
    expect(created.statusCode, created.body).toBe(201);
    const token = data<Config>(created).site_token;
    expect((await db().query("SELECT allowed_origins FROM attribution_configs WHERE project_id = $1", [a.projectId])).rows[0].allowed_origins).toEqual(["https://shop.example.com"]);
    expect((await beacon(event(token))).statusCode).toBe(202);
  }, 120_000);

  it("STORY-113 - the preflight answers without a token and names only POST and content-type", async () => {
    const res = await harness.app().inject({ method: "OPTIONS", url: apiUrl("/ingest/attribution"), headers: { origin: "https://anything.example", "access-control-request-method": "POST" } });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toBe("POST");
  }, 120_000);

  it("STORY-113 S11 - flooding one configuration degrades that configuration; another is unaffected", async () => {
    const flooded = await connected();
    const calm = await connected();
    for (let i = 0; i < ATTRIBUTION_INGEST_LIMIT_PER_MINUTE; i += 1) {
      expect((await beacon(event(flooded.token))).statusCode).toBe(202);
    }
    const over = await beacon(event(flooded.token));
    expect(over.statusCode, over.body).toBe(429);
    expect((over.json() as { error: { code: string } }).error.code).toBe("rate_limited");
    expect((await beacon(event(calm.token))).statusCode).toBe(202);
  }, 240_000);

  it("STORY-113 S12 - malformed and oversized payloads are refused with no partial write", async () => {
    const { actor, token } = await connected();
    const cases: Array<[number, unknown]> = [
      [400, { ...event(token), visitor_id: "v" }],
      [400, { ...event(token), landing_url: "javascript:alert(1)" }],
      [400, { ...event(token), landing_url: "x".repeat(3000) }],
      [400, { site_token: token }],
      [400, { ...event(token), conversion: { name: "signup", value: -1 } }],
      [413, { ...event(token), referrer: "https://chatgpt.com/" + "a".repeat(20_000) }],
    ];
    for (const [status, payload] of cases) {
      const res = await beacon(payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(status);
    }
    expect(await dailyRows(actor.projectId)).toHaveLength(0);
    const cfg = (await db().query("SELECT status, first_event_at FROM attribution_configs WHERE project_id = $1", [actor.projectId])).rows[0] as { status: string; first_event_at: Date | null };
    expect(cfg).toEqual({ status: "pending", first_event_at: null });
  }, 120_000);

  it("STORY-113 S13 - a configuration whose project was deleted refuses ingest and accumulates no counter; so does a disconnected one", async () => {
    const { actor, token } = await connected();
    expect((await beacon(event(token))).statusCode).toBe(202);
    await db().query("UPDATE projects SET deleted_at = now() WHERE id = $1", [actor.projectId]);
    const res = await beacon(event(token));
    expect(res.statusCode, res.body).toBe(404);
    expect((await dailyRows(actor.projectId))[0]!.sessions).toBe(1);

    const b = await connected();
    await remove(b.actor);
    expect((await beacon(event(b.token))).statusCode).toBe(404);
    expect(await dailyRows(b.actor.projectId)).toHaveLength(0);
  }, 120_000);

  // STORY-113 AC8 / scenario 10 (owner decision 108(e)): the beacon adopts edge-cases-and-slos.md objective #5, API write latency
  // p95 <= 500 ms, measured on the server side of the request (the same quantity as the "server span" the objective names).
  // 400 events (under the per-configuration limit, so every one is a real ingest), 20 at a time, ALL on one landing URL so
  // every request upserts the same daily counter row - the contended worst case. "Asynchronous" here is the queue boundary
  // (KAD-06): the handler answers 202 and makes no network call.
  it("STORY-113 S10 - ingest latency under concurrent load is within the p95 <= 500 ms write objective, and the handler makes no network call", async () => {
    const { actor, token } = await connected();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const TOTAL = 400;
    const CONCURRENCY = 20;
    const P95_OBJECTIVE_MS = 500;
    const durations: number[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < TOTAL) {
        next += 1;
        const started = performance.now();
        const res = await beacon(event(token));
        durations.push(performance.now() - started);
        expect(res.statusCode, res.body).toBe(202);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    expect(durations).toHaveLength(TOTAL);
    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]!;
    expect(p95, `p95 ${p95.toFixed(1)} ms over ${TOTAL} events at concurrency ${CONCURRENCY}`).toBeLessThanOrEqual(P95_OBJECTIVE_MS);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Nothing was lost to the contention: the one counter row holds every event.
    const rows = await dailyRows(actor.projectId);
    expect(rows.reduce((sum, r) => sum + Number(r.sessions ?? r.events ?? r.count ?? 0), 0)).toBe(TOTAL);
  }, 240_000);

  it("STORY-113 S14 - status reads pending, then receiving with first and last event times, then stale", async () => {
    const { actor, token, config } = await connected();
    expect(config.receiving).toBe(false);
    await beacon(event(token));
    const live = data<{ config: Config }>(await read(actor)).config;
    expect(live).toMatchObject({ status: "receiving", receiving: true });
    expect(live.first_event_at).not.toBeNull();
    expect(live.last_event_at).not.toBeNull();
    await db().query("UPDATE attribution_configs SET last_event_at = now() - interval '3 days' WHERE project_id = $1", [actor.projectId]);
    const stale = data<{ config: Config }>(await read(actor)).config;
    expect(stale).toMatchObject({ status: "stale", receiving: false });
    expect(stale.first_event_at).toBe(live.first_event_at);
    await beacon(event(token));
    expect(data<{ config: Config }>(await read(actor)).config.status).toBe("receiving");
  }, 120_000);

  it("STORY-113 S15 - the portal role is admitted to neither table by any row-level-security policy, so it reads no row", async () => {
    // The role holds the schema's blanket SELECT grant; what keeps it out is that no policy admits it (FORCE ROW LEVEL SECURITY).
    const policies = await db().query(
      `SELECT tablename, policyname FROM pg_policies
        WHERE tablename IN ('attribution_configs','attribution_daily') AND ('nominara_portal' = ANY(roles) OR 'public' = ANY(roles))`,
    );
    expect(policies.rows).toEqual([]);
    const forced = await db().query("SELECT relname FROM pg_class WHERE relname IN ('attribution_configs','attribution_daily') AND relrowsecurity AND relforcerowsecurity ORDER BY relname");
    expect(forced.rows.map((r: { relname: string }) => r.relname)).toEqual(["attribution_configs", "attribution_daily"]);
  }, 120_000);
});
