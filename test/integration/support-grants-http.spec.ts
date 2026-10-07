import { createHash } from "node:crypto";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { grantSupportAccess } from "../../src/lib/support/support-grants.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// NEW-D-5 — /v1/trust/access-grants through the REAL ApiModule.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

describe("NEW-D-5 · access grants over HTTP", () => {
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
    await pool.end();
  });

  interface Actor {
    readonly workspaceId: string;
    readonly userId: string;
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

  async function owner(plan: "starter" | "growth" | "business", opts: { stepUp?: boolean; role?: "owner" | "admin" } = {}): Promise<Actor> {
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
    if (opts.stepUp !== false) await sessions.recordStrongAuth(tokens.sid, "webauthn");
    return { userId, workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  async function member(workspaceId: string, role: "admin" | "manager" | "analyst" | "viewer", stepUp = true): Promise<Actor> {
    const userId = await newUser();
    await harness.db().query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,$4,'active')`,
      [uuidV7(), workspaceId, userId, role],
    );
    const tokens = await sessions.createSession(userId);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, role, null, 2);
    if (stepUp) await sessions.recordStrongAuth(tokens.sid, "webauthn");
    return { userId, workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  const get = (a: Actor, qs = "") => harness.app().inject({ method: "GET", url: apiUrl(`/trust/access-grants${qs}`), headers: { cookie: a.cookie } });
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;

  async function grant(workspaceId: string, over: Record<string, unknown> = {}): Promise<string> {
    const requested_by = await newUser();
    const approved_by = await newUser();
    const client = await pool.connect();
    try {
      const g = await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        grantSupportAccess(tx, {
          workspace_id: workspaceId,
          requested_by,
          approved_by,
          scope: "findings",
          allow_write: false,
          justification: "debugging a capture",
          ticket_ref: "SUP-9",
          ttl_minutes: 30,
          operator: "ops",
          ...over,
        } as never),
      );
      return g.id;
    } finally {
      client.release();
    }
  }

  it("NEW-D-5 AC1 · every role with workspace:read sees the active grant, and the body carries no staff identity", async () => {
    const a = await owner("business");
    const id = await grant(a.workspaceId);
    for (const role of ["admin", "manager", "analyst", "viewer"] as const) {
      const m = await member(a.workspaceId, role);
      const res = await get(m);
      expect(res.statusCode, `${role}: ${res.body}`).toBe(200);
      const items = data<Array<Record<string, unknown>>>(res);
      expect(items.map((g) => g["id"])).toEqual([id]);
      expect(items[0]).toMatchObject({ scope: "findings", allow_write: false, ticket_ref: "SUP-9", justification: "debugging a capture" });
      expect(res.body).not.toMatch(/requested_by|approved_by/u);
    }
  }, 120_000);

  it("NEW-D-5 AC1 · no grant means an empty list, 200, not 404", async () => {
    const a = await owner("business");
    const res = await get(a);
    expect(res.statusCode).toBe(200);
    expect(data<unknown[]>(res)).toEqual([]);
  }, 60_000);

  it("NEW-D-5 AC4 · a grant on workspace B does not appear in workspace A's response", async () => {
    const a = await owner("business");
    const b = await owner("business");
    await grant(b.workspaceId);
    expect(data<unknown[]>(await get(a))).toEqual([]);
    expect(data<unknown[]>(await get(b))).toHaveLength(1);
  }, 120_000);

  it("NEW-D-5 AC1 · an unknown query key is a 400, never silently dropped", async () => {
    const a = await owner("business");
    expect((await get(a, "?bogus=1")).statusCode).toBe(400);
  }, 60_000);

  it("NEW-D-5 AC2 · no HTTP route creates, updates or revokes a grant", async () => {
    const a = await owner("business");
    const id = await grant(a.workspaceId);
    const headers = { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" };
    for (const [method, url] of [
      ["POST", "/trust/access-grants"],
      ["PUT", `/trust/access-grants/${id}`],
      ["PATCH", `/trust/access-grants/${id}`],
      ["DELETE", `/trust/access-grants/${id}`],
    ] as const) {
      const res = await harness.app().inject({ method, url: apiUrl(url), headers, payload: method === "DELETE" ? undefined : {} });
      expect([404, 405], `${method} ${url}`).toContain(res.statusCode);
    }
    expect((await harness.db().query(`SELECT revoked_at FROM support_grants WHERE id = $1`, [id])).rows[0]).toEqual({ revoked_at: null });
  }, 60_000);

  it("NEW-D-5 AC1 · an unauthenticated request is 401", async () => {
    const res = await harness.app().inject({ method: "GET", url: apiUrl("/trust/access-grants") });
    expect(res.statusCode).toBe(401);
  }, 60_000);
});
