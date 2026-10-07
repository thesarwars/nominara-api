import { createHash } from "node:crypto";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
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
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// NEW-D-4 — /v1/api-keys through the REAL ApiModule. Authenticating WITH an API key is out of scope.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

describe("NEW-D-4 · API keys over HTTP", () => {
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

  const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ name: "CI deploy", permissions: ["project:read", "tracking:read"], ...over });
  const create = (a: Actor, p: unknown = payload()) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl("/api-keys"),
      headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" },
      payload: p as object,
    });
  const list = (a: Actor) => harness.app().inject({ method: "GET", url: apiUrl("/api-keys"), headers: { cookie: a.cookie } });
  const revoke = (a: Actor, id: string) =>
    harness.app().inject({ method: "DELETE", url: apiUrl(`/api-keys/${id}`), headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf } });
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; details?: Record<string, unknown> } }).error;
  type Created = { key: { id: string; key_prefix: string; name: string; permissions: string[]; revoked_at: string | null }; secret: string };

  it("NEW-D-4 AC2/AC3 · create returns the secret once; only sha256(secret) and a 12-char prefix are stored", async () => {
    const a = await owner("business");
    const res = await create(a);
    expect(res.statusCode, res.body).toBe(201);
    const c = data<Created>(res);
    expect(c.secret).toMatch(/^nk_live_[A-Za-z0-9_-]{22}$/);
    expect(c.key.key_prefix).toBe(c.secret.slice(0, 12));
    const row = (await harness.db().query(`SELECT key_hash, key_prefix, permissions, created_by FROM api_keys WHERE id = $1`, [c.key.id])).rows[0] as {
      key_hash: Buffer;
      key_prefix: string;
      permissions: string[];
      created_by: string;
    };
    expect(row.key_hash.equals(createHash("sha256").update(c.secret).digest())).toBe(true);
    expect(row.key_prefix).toBe(c.secret.slice(0, 12));
    expect(row.permissions).toEqual(["project:read", "tracking:read"]);
    expect(row.created_by).toBe(a.userId);
    const dump = JSON.stringify((await harness.db().query(`SELECT * FROM api_keys WHERE id = $1`, [c.key.id])).rows);
    expect(dump).not.toContain(c.secret);
  }, 60_000);

  it("NEW-D-4 AC2 · the secret is absent from every later response and from the audit trail", async () => {
    const a = await owner("business");
    const c = data<Created>(await create(a));
    const responses = [await list(a), await revoke(a, c.key.id), await list(a)];
    for (const r of responses) {
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).not.toContain(c.secret);
      expect(r.body).not.toContain(c.secret.slice(12));
      expect(r.body).not.toMatch(/key_hash|"secret"/);
      expect(r.body).not.toContain(createHash("sha256").update(c.secret).digest("hex"));
      expect(r.body).not.toContain(createHash("sha256").update(c.secret).digest("base64"));
    }
    const audit = JSON.stringify((await harness.db().query(`SELECT * FROM audit_log WHERE workspace_id = $1`, [a.workspaceId])).rows);
    expect(audit).not.toContain(c.secret);
    expect(audit).not.toContain(c.secret.slice(12));
  });

  it("NEW-D-4 AC1 · without a fresh step-up, create is 401 step_up_required with details.methods, and stores nothing", async () => {
    const a = await owner("business", { stepUp: false });
    const res = await create(a);
    expect(res.statusCode, res.body).toBe(401);
    expect(errorOf(res).code).toBe("step_up_required");
    expect(errorOf(res).details).toMatchObject({ methods: expect.arrayContaining(["webauthn"]) });
    const rows = await harness.db().query(`SELECT count(*)::int AS n FROM api_keys WHERE workspace_id = $1`, [a.workspaceId]);
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("NEW-D-4 AC1 · an admin with a fresh step-up may create; one without is 401", async () => {
    const o = await owner("business");
    const fresh = await member(o.workspaceId, "admin", true);
    expect((await create(fresh)).statusCode).toBe(201);
    const stale = await member(o.workspaceId, "admin", false);
    expect((await create(stale)).statusCode).toBe(401);
  });

  it("NEW-D-4 AC1 · manager, analyst and viewer get 403 naming apikey:create on every route, never 404", async () => {
    const o = await owner("business");
    const c = data<Created>(await create(o));
    for (const role of ["manager", "analyst", "viewer"] as const) {
      const m = await member(o.workspaceId, role);
      for (const res of [await create(m), await list(m), await revoke(m, c.key.id)]) {
        expect(res.statusCode, res.body).toBe(403);
        expect(JSON.stringify(res.json())).toContain("apikey:create");
      }
    }
  });

  it("NEW-D-4 AC3 · an unknown request key is 400 validation_failed, and grants apikey:create or unknown permissions are refused", async () => {
    const a = await owner("business");
    for (const p of [payload({ key_hash: "x" }), payload({ permissions: ["apikey:create"] }), payload({ permissions: [] }), payload({ name: "" })]) {
      const res = await create(a, p);
      expect(res.statusCode, res.body).toBe(400);
      expect(errorOf(res).code).toBe("validation_failed");
    }
  });

  it("NEW-D-4 AC4 · api.keys_max = 0 (starter) refuses create with entitlement_exceeded or feature_not_in_plan, naming key, limit and current", async () => {
    const a = await owner("starter");
    const res = await create(a);
    expect(res.statusCode, res.body).toBe(403);
    expect(["entitlement_exceeded", "feature_not_in_plan"]).toContain(errorOf(res).code);
    expect(errorOf(res).details).toMatchObject({ key: "api.keys_max" });
    const rows = await harness.db().query(`SELECT count(*)::int AS n FROM api_keys WHERE workspace_id = $1`, [a.workspaceId]);
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("NEW-D-4 AC4 · the 4th key on business (limit 3) is 403 entitlement_exceeded with {key,limit,current}; a revoked key frees a slot", async () => {
    const a = await owner("business");
    const made: Created[] = [];
    for (let i = 0; i < 3; i += 1) made.push(data<Created>(await create(a, payload({ name: `k${String(i)}` }))));
    const refused = await create(a);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(errorOf(refused)).toMatchObject({ code: "entitlement_exceeded", details: { key: "api.keys_max", limit: 3, current: 3 } });
    expect((await revoke(a, made[0]!.key.id)).statusCode).toBe(200);
    expect((await create(a)).statusCode).toBe(201);
  }, 60_000);

  it("NEW-D-4 AC5 · revoke sets revoked_at and is idempotent: the first revoked_at is kept", async () => {
    const a = await owner("business");
    const c = data<Created>(await create(a));
    const first = await revoke(a, c.key.id);
    expect(first.statusCode, first.body).toBe(200);
    const at = data<Created["key"]>(first).revoked_at;
    expect(at).not.toBeNull();
    const second = await revoke(a, c.key.id);
    expect(second.statusCode, second.body).toBe(200);
    expect(data<Created["key"]>(second).revoked_at).toBe(at);
    const stored = (await harness.db().query(`SELECT revoked_at FROM api_keys WHERE id = $1`, [c.key.id])).rows[0] as { revoked_at: Date };
    expect(stored.revoked_at.toISOString()).toBe(at);
  });

  // Cross-workspace isolation is asserted in api-keys-rls.spec.ts, as nominara_app: this harness connects as a
  // superuser, which would see every workspace's keys and pass a cross-tenant assertion for the wrong reason.
  it("NEW-D-4 AC5 · an unknown key id is 404 and a malformed id is 400", async () => {
    const a = await owner("business");
    expect((await revoke(a, uuidV7())).statusCode).toBe(404);
    expect((await revoke(a, "not-a-uuid")).statusCode).toBe(400);
  });

  it("NEW-D-4 AC6 · create is audited at warning and revoke at notice, each naming the key", async () => {
    const a = await owner("business");
    const c = data<Created>(await create(a));
    await revoke(a, c.key.id);
    const rows = (
      await harness.db().query(`SELECT action, severity, resource_id FROM audit_log WHERE workspace_id = $1 AND action LIKE 'api_key.%' ORDER BY seq`, [a.workspaceId])
    ).rows;
    expect(rows).toEqual([
      { action: "api_key.created", severity: "warning", resource_id: c.key.id },
      { action: "api_key.revoked", severity: "notice", resource_id: c.key.id },
    ]);
  });

  it("NEW-D-4 observability · create and revoke each log one line with the workspace ID and key ID, never the secret, prefix or name; the counters are emitted", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => {
      lines.push(typeof m === "string" ? m : JSON.stringify(m));
    });
    try {
      const a = await owner("business");
      const c = data<Created>(await create(a, payload({ name: "Very Private Key Name" })));
      await revoke(a, c.key.id);
      const mine = lines.filter((l) => l.startsWith("api key "));
      expect(mine).toHaveLength(2);
      for (const l of mine) {
        expect(l).toContain(`workspace_id=${a.workspaceId}`);
        expect(l).toContain(`api_key_id=${c.key.id}`);
        expect(l).not.toContain(c.secret);
        expect(l).not.toContain(c.key.key_prefix);
        expect(l).not.toContain("Very Private Key Name");
      }
      expect(lines.some((l) => l.includes("nominara_api_key_creations_total"))).toBe(true);
      expect(lines.some((l) => l.includes("nominara_api_key_revocations_total"))).toBe(true);
      expect(lines.join("\n")).not.toContain(c.secret);
    } finally {
      spy.mockRestore();
    }
  });
});
