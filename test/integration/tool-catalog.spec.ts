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

  it("scenario 23 - a Free workspace sees all six tools, the full audit mode DISABLED and naming the lowest plan that grants it (read from the plans table)", async () => {
    const a = await owner("free");
    const res = await catalog(a);
    expect(res.statusCode, res.body).toBe(200);
    const body = toolCatalogResponseSchema.parse((res.json() as { data: unknown }).data);
    expect(body.tools.map((t) => t.tool_key)).toEqual([...TOOL_KEYS]);
    const lowest = (await harness.db().query<{ key: string; display_name: string }>(
      `SELECT key, display_name FROM plans WHERE (entitlements -> 'aux.scheduled_audits' -> 'value') NOT IN ('false'::jsonb, 'null'::jsonb) ORDER BY sort_order ASC LIMIT 1`,
    )).rows[0]!;
    const audit = body.tools.find((t) => t.tool_key === "aux_audit")!;
    expect(audit.enabled).toBe(true);
    expect(audit.modes.find((m) => m.mode === "site_files")).toMatchObject({ enabled: true, credits: 0, unlocked_by_plan: null });
    expect(audit.modes.find((m) => m.mode === "full")).toMatchObject({ enabled: false, unlocked_by_plan: { key: lowest.key, display_name: lowest.display_name } });
    expect(lowest.key).not.toBe("free");
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

  it("scenario 23 - an unauthenticated caller is refused", async () => {
    const res = await harness.app().inject({ method: "GET", url: apiUrl("/tools") });
    expect(res.statusCode).toBe(401);
  });
});
