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

// STORY-098 part A (NEW-E-098a) — /v1/share-tokens through the REAL ApiModule.
// Scenario numbers are the story's Test scenarios table; scenarios 5-19 and 21-22
// belong to the portal (NEW-E-099), and 20 (ownership transfer) is deferred:
// no ownership-transfer flow exists to hook into yet.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

describe("STORY-098 · share tokens (agency side) over HTTP", () => {
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

  async function owner(plan: "starter" | "growth" | "business"): Promise<Actor> {
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

  async function member(workspaceId: string, role: "manager" | "analyst" | "viewer", projectScope: string[] | null = null): Promise<Actor> {
    const userId = await newUser();
    await harness.db().query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, project_scope, status) VALUES ($1,$2,$3,$4,$5,'active')`,
      [uuidV7(), workspaceId, userId, role, projectScope],
    );
    const tokens = await sessions.createSession(userId);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, role, null, 2);
    return { userId, workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  async function project(workspaceId: string): Promise<string> {
    const id = uuidV7();
    await harness.db().query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,$3,$4,'https://acme.test','acme.test')`,
      [id, workspaceId, `P-${id.slice(-6)}`, `p-${id.slice(-12)}`],
    );
    return id;
  }

  async function theme(workspaceId: string): Promise<string> {
    const id = uuidV7();
    await harness.db().query(`INSERT INTO brand_themes (id, workspace_id, name, is_default) VALUES ($1,$2,'T',true)`, [id, workspaceId]);
    return id;
  }

  const body = (projectIds: string[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
    label: "Acme Q3",
    scope_project_ids: projectIds,
    scope_tabs: ["overview"],
    hide_competitors: false,
    hide_costs: true,
    timeframe_lock: null,
    password: null,
    acknowledge_no_password: true,
    allowed_email_domains: [],
    max_views: null,
    expires_at: null,
    ...over,
  });

  const mint = (a: Actor, payload: unknown) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl("/share-tokens"),
      headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" },
      payload: payload as object,
    });
  const list = (a: Actor) => harness.app().inject({ method: "GET", url: apiUrl("/share-tokens"), headers: { cookie: a.cookie } });
  const views = (a: Actor, id: string) => harness.app().inject({ method: "GET", url: apiUrl(`/share-tokens/${id}/views`), headers: { cookie: a.cookie } });
  const revoke = (a: Actor, id: string) =>
    harness.app().inject({ method: "DELETE", url: apiUrl(`/share-tokens/${id}`), headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf } });
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; details?: Record<string, unknown> } }).error;
  type Minted = { token: { id: string; token_prefix: string; password_required: boolean }; secret: string; url: string };

  it("STORY-098 scenario 1 · mint shows the secret once; only sha256(secret) and an 8-char prefix are stored", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    const res = await mint(a, body([p], { password: "correct horse battery", acknowledge_no_password: false }));
    expect(res.statusCode, res.body).toBe(201);
    const m = data<Minted>(res);
    expect(m.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(m.url).toContain(m.secret);
    expect(m.token.token_prefix).toBe(m.secret.slice(0, 8));

    const row = (await harness.db().query(`SELECT token_hash, token_prefix, password_hash, password_required FROM share_tokens WHERE id = $1`, [m.token.id])).rows[0] as {
      token_hash: Buffer;
      token_prefix: string;
      password_hash: string;
      password_required: boolean;
    };
    expect(row.token_hash.equals(createHash("sha256").update(m.secret).digest())).toBe(true);
    expect(row.token_prefix).toBe(m.secret.slice(0, 8));
    expect(row.password_required).toBe(true);
    // Argon2id, m=64 MiB, t=3, p=1 (integrations-and-sharing.md §3)
    expect(row.password_hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(row.password_hash).not.toContain("correct horse");
    // the secret is nowhere in the database: not in the token row, not in the audit trail
    const dump = JSON.stringify((await harness.db().query(`SELECT * FROM share_tokens WHERE id = $1`, [m.token.id])).rows);
    const audit = JSON.stringify((await harness.db().query(`SELECT * FROM audit_log WHERE workspace_id = $1`, [a.workspaceId])).rows);
    expect(dump).not.toContain(m.secret);
    expect(audit).not.toContain(m.secret);
    expect(audit).not.toContain("correct horse");
  }, 60_000);

  it("STORY-098 scenario 2 · no endpoint returns the secret or hash after mint (response scan across list, views, revoke)", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    const m = data<Minted>(await mint(a, body([p])));
    const responses = [await list(a), await views(a, m.token.id), await revoke(a, m.token.id), await list(a)];
    for (const r of responses) {
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).not.toContain(m.secret);
      expect(r.body).not.toContain(m.secret.slice(8));
      expect(r.body).not.toMatch(/token_hash|password_hash|"secret"/);
      expect(r.body).not.toContain(createHash("sha256").update(m.secret).digest("hex"));
      expect(r.body).not.toContain(createHash("sha256").update(m.secret).digest("base64"));
    }
    expect(Object.keys(data<Record<string, unknown>>(responses[2]!)).sort()).not.toContain("secret");
  });

  it("STORY-098 scenario 3 · password is required by default: omitting it, or null without acknowledgement, is 400", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    const { password: _omitted, ...noPasswordKey } = body([p]);
    const omitted = await mint(a, noPasswordKey);
    expect(omitted.statusCode, omitted.body).toBe(400);
    const unacked = await mint(a, body([p], { password: null, acknowledge_no_password: false }));
    expect(unacked.statusCode, unacked.body).toBe(400);
    expect(errorOf(unacked).code).toBe("validation_failed");
    const rows = await harness.db().query(`SELECT count(*)::int AS n FROM share_tokens WHERE workspace_id = $1`, [a.workspaceId]);
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("STORY-098 scenario 4 · a passwordless mint with acknowledgement writes a notice-severity audit row; a passworded one does not", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    const open = data<Minted>(await mint(a, body([p])));
    expect(open.token.password_required).toBe(false);
    const stored = (await harness.db().query(`SELECT password_hash, password_required FROM share_tokens WHERE id = $1`, [open.token.id])).rows[0];
    expect(stored).toEqual({ password_hash: null, password_required: false });
    const rows = (
      await harness.db().query(`SELECT action, severity, resource_id, actor_id FROM audit_log WHERE workspace_id = $1 AND action LIKE 'share_token.%' AND severity = 'notice'`, [a.workspaceId])
    ).rows;
    expect(rows).toEqual([{ action: "share_token.minted_without_password", severity: "notice", resource_id: open.token.id, actor_id: a.userId }]);

    await mint(a, body([p], { password: "a-long-enough-password", acknowledge_no_password: false }));
    const after = await harness.db().query(`SELECT count(*)::int AS n FROM audit_log WHERE workspace_id = $1 AND action LIKE 'share_token.%' AND severity = 'notice'`, [a.workspaceId]);
    expect((after.rows[0] as { n: number }).n).toBe(1);
  }, 60_000);

  it("STORY-098 · every mint and revoke has an info-level audit row naming the token", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    const m = data<Minted>(await mint(a, body([p])));
    await revoke(a, m.token.id);
    const rows = (await harness.db().query(`SELECT action, resource_id FROM audit_log WHERE workspace_id = $1 AND action LIKE 'share_token.%' AND severity = 'info' ORDER BY seq`, [a.workspaceId])).rows;
    expect(rows).toEqual([
      { action: "share_token.minted", resource_id: m.token.id },
      { action: "share_token.revoked", resource_id: m.token.id },
    ]);
  });

  it("STORY-098 · share_links.enabled = false is 403 feature_not_in_plan, and nothing is stored", async () => {
    const a = await owner("starter");
    const p = await project(a.workspaceId);
    const res = await mint(a, body([p]));
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res)).toMatchObject({ code: "feature_not_in_plan", details: { key: "share_links.enabled" } });
    const rows = await harness.db().query(`SELECT count(*)::int AS n FROM share_tokens WHERE workspace_id = $1`, [a.workspaceId]);
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("STORY-098 · exceeding N_active is 403 entitlement_exceeded with {key,limit,current}; revoked and expired tokens do not count", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    const insert = (extra: string) =>
      harness.db().query(
        `INSERT INTO share_tokens (workspace_id, label, token_hash, token_prefix, password_required, scope_project_ids, created_by ${extra.split("|")[0]})
         VALUES ($1,'x',$2,'abcdefgh',false,$3,$4 ${extra.split("|")[1] ?? ""})`,
        [a.workspaceId, createHash("sha256").update(uuidV7()).digest(), [p], a.userId],
      );
    for (let i = 0; i < 10; i += 1) await insert("");
    // an expired and a revoked token are not "active"
    await insert(", expires_at|, now() - interval '1 day'");
    await insert(", revoked_at|, now()");
    const res = await mint(a, body([p]));
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res)).toMatchObject({ code: "entitlement_exceeded", details: { key: "share_links.enabled", limit: 10, current: 10 } });

    // revoking one through the API frees a slot
    const live = data<Array<{ id: string; revoked_at: string | null; expires_at: string | null }>>(await list(a)).find(
      (t) => t.revoked_at === null && t.expires_at === null,
    );
    expect((await revoke(a, live!.id)).statusCode).toBe(200);
    expect((await mint(a, body([p]))).statusCode).toBe(201);
  }, 60_000);

  it("STORY-098 · viewer and analyst are 403 naming share_token:mint / share_token:revoke", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    const m = data<Minted>(await mint(a, body([p])));
    for (const role of ["viewer", "analyst"] as const) {
      const x = await member(a.workspaceId, role);
      const minted = await mint(x, body([p]));
      expect(minted.statusCode, `${role}: ${minted.body}`).toBe(403);
      expect(minted.body).toContain("share_token:mint");
      const revoked = await revoke(x, m.token.id);
      expect(revoked.statusCode, `${role}: ${revoked.body}`).toBe(403);
      expect(revoked.body).toContain("share_token:revoke");
    }
  });

  it("STORY-098 · a scoped manager can mint only inside their scope, and sees and revokes only tokens inside it", async () => {
    const a = await owner("growth");
    const [p1, p2] = [await project(a.workspaceId), await project(a.workspaceId)];
    const mgr = await member(a.workspaceId, "manager", [p1]);
    const own = await mint(mgr, body([p1]));
    expect(own.statusCode, own.body).toBe(201);
    const outside = await mint(mgr, body([p1, p2]));
    expect(outside.statusCode, outside.body).toBe(403);
    expect(errorOf(outside).code).toBe("project_out_of_scope");

    const ownerToken = data<Minted>(await mint(a, body([p2])));
    const seen = data<Array<{ id: string }>>(await list(mgr)).map((t) => t.id);
    expect(seen).toEqual([data<Minted>(own).token.id]);
    expect((await revoke(mgr, ownerToken.token.id)).statusCode).toBe(403);
    expect((await views(mgr, ownerToken.token.id)).statusCode).toBe(403);
    const still = await harness.db().query(`SELECT revoked_at FROM share_tokens WHERE id = $1`, [ownerToken.token.id]);
    expect((still.rows[0] as { revoked_at: unknown }).revoked_at).toBeNull();
    // an unrestricted manager (project_scope NULL) is not narrowed
    const free = await member(a.workspaceId, "manager", null);
    expect((await mint(free, body([p2]))).statusCode).toBe(201);
  }, 60_000);

  it("STORY-098 · scope_project_ids must name projects of this workspace: an unknown project is 400 and stores nothing", async () => {
    const a = await owner("growth");
    const mine = await project(a.workspaceId);
    for (const ids of [[uuidV7()], [mine, uuidV7()]]) {
      const res = await mint(a, body(ids));
      expect(res.statusCode, res.body).toBe(400);
      expect(errorOf(res).code).toBe("validation_failed");
    }
    const rows = await harness.db().query(`SELECT count(*)::int AS n FROM share_tokens`);
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("STORY-098 FR-AGY-01i · an unknown theme pin is 400; the workspace's own theme is stored (the foreign-workspace case is in share-tokens-rls.spec.ts)", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    const refused = await mint(a, body([p], { theme_id: uuidV7() }));
    expect(refused.statusCode, refused.body).toBe(400);
    expect(errorOf(refused).code).toBe("validation_failed");
    const mine = await theme(a.workspaceId);
    const ok = data<Minted & { token: { theme_id: string } }>(await mint(a, body([p], { theme_id: mine })));
    expect(ok.token.theme_id).toBe(mine);
  });

  it("STORY-098 · unknown request keys (workspace_id, token_hash) are 400, not silently dropped", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    for (const extra of [{ workspace_id: uuidV7() }, { token_hash: "x" }, { secret: "x" }]) {
      const res = await mint(a, body([p], extra));
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
  });

  it("STORY-098 · revoke sets revoked_at, answers 200 with the token, and is idempotent (the first timestamp is kept)", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    const m = data<Minted>(await mint(a, body([p])));
    const one = await revoke(a, m.token.id);
    expect(one.statusCode, one.body).toBe(200);
    const t1 = data<{ id: string; revoked_at: string }>(one);
    expect(t1.id).toBe(m.token.id);
    expect(t1.revoked_at).toBeTruthy();
    const two = await revoke(a, m.token.id);
    expect(two.statusCode, two.body).toBe(200);
    expect(data<{ revoked_at: string }>(two).revoked_at).toBe(t1.revoked_at);
  });

  it("STORY-098 scenario 19 (agency half) · views list the telemetry fields; pages/duration/geo are null (not 0) until recorded", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    const m = data<Minted>(await mint(a, body([p])));
    expect(data<unknown[]>(await views(a, m.token.id))).toEqual([]);
    await harness.db().query(
      `INSERT INTO share_token_views (workspace_id, share_token_id, ip, user_agent, country, authenticated, viewed_at) VALUES ($1,$2,'203.0.113.9','UA/1',NULL,true,'2026-10-01T10:00:00Z')`,
      [a.workspaceId, m.token.id],
    );
    await harness.db().query(
      `INSERT INTO share_token_views (workspace_id, share_token_id, ip, user_agent, country, authenticated, pages_viewed, duration_ms, viewed_at) VALUES ($1,$2,'203.0.113.10','UA/2','DE',true,'{overview,tasks}',90500,'2026-10-02T10:00:00Z')`,
      [a.workspaceId, m.token.id],
    );
    const res = await views(a, m.token.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(data<unknown[]>(res)).toEqual([
      { at: "2026-10-02T10:00:00.000Z", ip: "203.0.113.10", geo: "DE", user_agent: "UA/2", authenticated: true, pages: 2, duration_s: 90.5 },
      { at: "2026-10-01T10:00:00.000Z", ip: "203.0.113.9", geo: null, user_agent: "UA/1", authenticated: true, pages: null, duration_s: null },
    ]);
  });

  it("STORY-098 · a malformed id is 400, an unknown one 404", async () => {
    const a = await owner("growth");
    expect((await revoke(a, "not-a-uuid")).statusCode).toBe(400);
    expect((await revoke(a, uuidV7())).statusCode).toBe(404);
    expect((await views(a, uuidV7())).statusCode).toBe(404);
  });

  it("STORY-098 observability · a mint and a revoke each log one line carrying the workspace ID and token ID, never the secret, label or name", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => {
      lines.push(typeof m === "string" ? m : JSON.stringify(m));
    });
    try {
      const a = await owner("growth");
      const p = await project(a.workspaceId);
      const m = data<Minted>(await mint(a, body([p], { label: "Very Private Client Label" })));
      await revoke(a, m.token.id);
      const mine = lines.filter((l) => l.startsWith("share token "));
      expect(mine).toHaveLength(2);
      for (const l of mine) {
        expect(l).toContain(`workspace_id=${a.workspaceId}`);
        expect(l).toContain(`share_token_id=${m.token.id}`);
        expect(l).not.toContain(m.secret);
        expect(l).not.toContain(m.token.token_prefix);
        expect(l).not.toContain("Very Private Client Label");
        expect(l).not.toContain("Acme");
      }
      const metrics = lines.filter((l) => l.includes("nominara_share_token_"));
      expect(metrics.some((l) => l.includes("nominara_share_token_mints_total"))).toBe(true);
      expect(metrics.some((l) => l.includes("nominara_share_token_revocations_total"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
