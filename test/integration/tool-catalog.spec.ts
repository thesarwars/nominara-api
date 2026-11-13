import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { toolCatalogResponseSchema, TOOL_KEYS } from "../../contracts/tools/index.js";
import { entitlementGranted, grantedValueSql } from "../../src/lib/entitlements/granted.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-078 AC23 / scenario 23 - GET /v1/tools through the REAL ApiModule.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

interface Actor {
  readonly workspaceId: string;
  readonly userId: string;
  readonly cookie: string;
  readonly csrf: string;
}


describe("STORY-078 · scenario 23 - the tool catalog route", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({
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

  async function owner(plan: "free" | "starter" | "growth" | "business"): Promise<Actor> {
    const userId = uuidV7();
    await harness.db().query(`INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`, [userId, `${userId}@example.test`]);
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
    const version = (await harness.db().query<{ entitlement_version: number }>("SELECT entitlement_version FROM workspaces WHERE id = $1", [workspaceId])).rows[0]!.entitlement_version;
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, version);
    return { userId, workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }


  const catalog = (a: Actor) => harness.app().inject({ method: "GET", url: apiUrl("/tools"), headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf } });
  const walletRow = async (workspaceId: string) => (await harness.db().query("SELECT included_balance, purchased_balance, reserved FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0];
  const jobs = async () => (await harness.db().query<{ n: number }>("SELECT count(*)::int AS n FROM tool_runs")).rows[0]!.n;

  it("scenario 23 - a Free workspace sees all six tools, the full audit mode DISABLED and naming Starter, the lowest public plan that grants it", async () => {
    const a = await owner("free");
    const res = await catalog(a);
    expect(res.statusCode, res.body).toBe(200);
    const body = toolCatalogResponseSchema.parse((res.json() as { data: unknown }).data);
    expect(body.tools.map((t) => t.tool_key)).toEqual([...TOOL_KEYS]);
    const audit = body.tools.find((t) => t.tool_key === "aux_audit")!;
    expect(audit.enabled).toBe(true);
    expect(audit.modes.find((m) => m.mode === "site_files")).toMatchObject({ enabled: true, credits: 0, unlocked_by_plan: null });
    expect(audit.modes.find((m) => m.mode === "full")).toMatchObject({ enabled: false, unlocked_by_plan: { key: "starter", display_name: "Starter" } });
  });

  it("scenario 23 - a hidden plan, however low its sort order, is never named as the unlocking plan", async () => {
    const a = await owner("free");
    const before = (await harness.db().query<{ is_public: boolean; sort_order: number }>("SELECT is_public, sort_order FROM plans WHERE key = 'starter'")).rows[0]!;
    try {
      await harness.db().query("UPDATE plans SET is_public = false, sort_order = -10 WHERE key = 'starter'");
      const body = toolCatalogResponseSchema.parse((await catalog(a)).json().data);
      expect(body.tools.find((t) => t.tool_key === "aux_audit")!.modes.find((m) => m.mode === "full")!.unlocked_by_plan).toEqual({ key: "growth", display_name: "Growth" });
    } finally {
      await harness.db().query("UPDATE plans SET is_public = $1, sort_order = $2 WHERE key = 'starter'", [before.is_public, before.sort_order]);
    }
  });

  it("scenario 23 - the SQL grant predicate and the TypeScript one agree on every value", async () => {
    const values: unknown[] = [true, false, null, 0, 1, -1, 0.5, 450, "", "none", "none_tools_only", "unlimited", "1_per_project_per_month", {}, [], { value: true }];
    for (const value of values) {
      const row = (await harness.db().query<{ granted: boolean }>(`SELECT ${grantedValueSql("$1::jsonb")} AS granted`, [JSON.stringify(value)])).rows[0]!;
      expect(row.granted, JSON.stringify(value)).toBe(entitlementGranted(value));
    }
    expect((await harness.db().query<{ granted: boolean }>(`SELECT ${grantedValueSql("NULL::jsonb")} AS granted`)).rows[0]!.granted).toBe(false);
  });

  it("scenario 23 - a paid workspace has the full mode enabled with no unlock plan", async () => {
    const a = await owner("growth");
    const body = toolCatalogResponseSchema.parse((await catalog(a)).json().data);
    expect(body.tools.find((t) => t.tool_key === "aux_audit")!.modes.find((m) => m.mode === "full")).toMatchObject({ enabled: true, unlocked_by_plan: null });
  });

  it("scenario 23 - reading the catalog is free: the wallet and the run table are unchanged", async () => {
    const a = await owner("free");
    const before = { wallet: await walletRow(a.workspaceId), runs: await jobs() };
    expect((await catalog(a)).statusCode).toBe(200);
    expect({ wallet: await walletRow(a.workspaceId), runs: await jobs() }).toEqual(before);
  });

  // STORY-095 AC12 / owner decision 106(d): the SHARED daily lookup meter beside the catalog, at workspace:read (every role that can open a tool surface), from the
  // same helper as /billing/usage and /billing/wallet.
  const today = "(now() AT TIME ZONE 'UTC')::date";
  const dayRow = (workspaceId: string, action: string, used: number, limit: number, when = today) =>
    harness.db().query(`INSERT INTO credit_daily_counters (workspace_id, utc_date, action_code, used_count, limit_count) VALUES ($1, ${when}, $2, $3, $4)`, [workspaceId, action, used, limit]);
  const meter = async (a: Actor) => (await catalog(a)).json().data as { daily_lookups?: unknown; daily_resets_at?: string };

  it("STORY-095 AC12 - the catalog serves today's shared lookup count and the cap: 2 of 3 on Free, 0 with no use (not absent), null on a paid plan (not 0), yesterday's row is not today's", async () => {
    const a = await owner("free");
    expect((await meter(a)).daily_lookups).toEqual({ used: 0, cap: 3 });
    await dayRow(a.workspaceId, "lookup", 3, 3, `${today} - 1`);
    expect((await meter(a)).daily_lookups).toEqual({ used: 0, cap: 3 });
    await dayRow(a.workspaceId, "lookup", 2, 3);
    await dayRow(a.workspaceId, "nlp_command", 9, 20);
    const body = await meter(a);
    expect(body.daily_lookups).toEqual({ used: 2, cap: 3 });
    expect(body.daily_resets_at).toMatch(/T00:00:00\.000Z$/u);
    const paid = await owner("growth");
    await dayRow(paid.workspaceId, "lookup", 1, 3);
    expect((await meter(paid)).daily_lookups).toEqual({ used: 1, cap: null });
  });

  it("STORY-095 AC12 - a viewer (workspace:read only) reads the same meter, and the read creates no counter row", async () => {
    const a = await owner("free");
    await dayRow(a.workspaceId, "lookup", 1, 3);
    const userId = uuidV7();
    await harness.db().query(`INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`, [userId, `${userId}@example.test`]);
    await harness.db().query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'viewer')", [a.workspaceId, userId]);
    const version = (await harness.db().query<{ entitlement_version: number }>("SELECT entitlement_version FROM workspaces WHERE id = $1", [a.workspaceId])).rows[0]!.entitlement_version;
    const tokens = await sessions.createSession(userId);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, a.workspaceId, "viewer", null, version);
    const res = await harness.app().inject({ method: "GET", url: apiUrl("/tools"), headers: { cookie: cookieOf(entered), [CSRF_HEADER_NAME]: entered.csrfToken } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().data as { daily_lookups: unknown }).daily_lookups).toEqual({ used: 1, cap: 3 });
    expect((await harness.db().query("SELECT 1 FROM credit_daily_counters WHERE workspace_id = $1", [a.workspaceId])).rowCount).toBe(1);
  });

  it("STORY-089 - the notifications inbox read refuses a member who has been removed, on the very next request", async () => {
    const a = await owner("growth");
    const userId = uuidV7();
    await harness.db().query(`INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`, [userId, `${userId}@example.test`]);
    await harness.db().query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'analyst')", [a.workspaceId, userId]);
    const version = (await harness.db().query<{ entitlement_version: number }>("SELECT entitlement_version FROM workspaces WHERE id = $1", [a.workspaceId])).rows[0]!.entitlement_version;
    const tokens = await sessions.createSession(userId);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, a.workspaceId, "analyst", null, version);
    const inbox = () => harness.app().inject({ method: "GET", url: apiUrl(`/workspaces/${a.workspaceId}/notifications`), headers: { cookie: cookieOf(entered), [CSRF_HEADER_NAME]: entered.csrfToken } });
    expect((await inbox()).statusCode).toBe(200);
    await harness.app().get(MembershipService).removeMember(pool, a.workspaceId, userId);
    const refused = await inbox();
    expect(refused.statusCode).toBe(403);
    // Membership is enforced by the workspace guard on this route: the member's still-valid session is refused 403 the moment the membership row is gone.
    expect(JSON.stringify(refused.json())).toContain("forbidden");
  });

  it("scenario 23 - an unauthenticated caller is refused", async () => {
    const res = await harness.app().inject({ method: "GET", url: apiUrl("/tools") });
    expect(res.statusCode).toBe(401);
  });
});
