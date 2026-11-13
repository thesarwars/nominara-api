import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineStatusResponseSchema, projectEngineHealthResponseSchema, type EngineStatusResponse, type ProjectEngineHealthResponse } from "../../contracts/engines/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { EngineBreakerRegistry } from "../../src/lib/engines/engine-breaker-registry.js";
import { healthBucketStart } from "../../src/lib/engines/engine-health.js";
import { ACTIVE_ENGINE_KEYS } from "../../src/lib/engines/registry.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { useApiHarness } from "../support/api-harness.js";
import { apiUrl } from "../support/api-url.js";
import { dataOf } from "../support/envelope.js";
import { testCacheRedisUrl } from "../support/test-valkey.js";

// STORY-031 AC11 / test scenario 10 — "Inspect the status surface: per-engine health visible and accurate." The customer-facing
// read: `GET /v1/engines/status`, any member (`workspace:read`), global data only, cacheable. The breaker state is the LIVE one
// from the shared breaker store, the catalog status is `engines.status`, the counters are `engine_health`'s trailing window.

const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };

describe("STORY-031 AC11 · GET /v1/engines/status", () => {
  const harness = useApiHarness({
    env: () => {
      const url = new URL(process.env.DATABASE_URL!);
      url.username = "nominara_app";
      url.password = resolvePassword("nominara_app", {});
      return { DATABASE_URL_POOLED: url.toString(), VALKEY_CACHE_URL: testCacheRedisUrl() };
    },
  });

  let pool: Pool;
  let redis: Redis;
  let sessions: SessionService;
  let workspaces: WorkspacesService;

  beforeEach(async () => {
    await harness.db().query(`ALTER ROLE nominara_app PASSWORD '${resolvePassword("nominara_app", {})}'`);
    redis = new Redis(testCacheRedisUrl());
    await redis.flushdb();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const membership = new MembershipService(new MembershipCacheService());
    sessions = new SessionService(pool, membership, new InMemoryCacheAdapter());
    workspaces = new WorkspacesService(pool, new LocalDekProvisioner(Buffer.alloc(32, 7), "local:dev"), new AuditChainService(), membership, sessions, new NoopRealtimePublisher());
  });

  afterEach(async () => {
    await redis.quit().catch(() => undefined);
    await pool.end();
  });

  async function viewer(): Promise<{ accessToken: string; csrfToken: string; workspaceId: string }> {
    const ownerId = (await harness.db().query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`o-${randomUUID()}@example.com`])).rows[0]!.id;
    const ws = await workspaces.create(ownerId, { name: `W ${randomUUID()}` }, meta);
    const userId = (await harness.db().query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`v-${randomUUID()}@example.com`])).rows[0]!.id;
    await harness.db().query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1,$2,'viewer','active')", [ws.id, userId]);
    const tokens = await sessions.createSession(userId);
    return { ...(await workspaces.switchTo(userId, tokens.sid, ws.id, meta)), workspaceId: ws.id };
  }

  it("a viewer sees every active engine with its catalog status, live breaker state, episode start and trailing counters", async () => {
    const actor = await viewer();
    await harness.db().query("UPDATE engines SET status = 'degraded' WHERE key = 'gemini'");
    const bucket = healthBucketStart(Date.now()).toISOString();
    await harness.db().query(
      `INSERT INTO engine_health (engine_key, bucket_start, attempts, successes, blocks, timeouts, rate_limited, p50_latency_ms, p95_latency_ms, circuit_state)
       VALUES ('gemini', $1, 10, 4, 5, 1, 0, 900, 2100, 'open')`,
      [bucket],
    );
    const before = Date.now();
    await new EngineBreakerRegistry(redis).for("gemini").recordOutcome("quota_exhausted");

    const response = await harness.app().inject({ method: "GET", url: apiUrl("/engines/status"), cookies: { [ACCESS_COOKIE_NAME]: actor.accessToken, [CSRF_COOKIE_NAME]: actor.csrfToken } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, max-age=30");
    const body = dataOf<EngineStatusResponse>(response);
    expect(engineStatusResponseSchema.safeParse(body).success).toBe(true);
    expect(body.engines.map((e) => e.engine_key)).toEqual([...ACTIVE_ENGINE_KEYS]);

    const gemini = body.engines.find((e) => e.engine_key === "gemini")!;
    expect(gemini).toMatchObject({ status: "degraded", circuit_state: "open", window_minutes: 60, attempts: 10, successes: 4, blocks: 5, timeouts: 1, rate_limited: 0, p50_latency_ms: 900, p95_latency_ms: 2100 });
    expect(Date.parse(gemini.unavailable_since!)).toBeGreaterThanOrEqual(before - 1_000);

    const chatgpt = body.engines.find((e) => e.engine_key === "chatgpt")!;
    expect(chatgpt).toMatchObject({ status: "active", circuit_state: "closed", unavailable_since: null, attempts: 0, p50_latency_ms: null });
  });

  // STORY-090 AC7/AC8 - GET /v1/projects/{id}/engine-health: the project's own enabled engines, each with a derived state and since.
  async function project(workspaceId: string): Promise<string> {
    const id = randomUUID();
    await harness.db().query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://e.test','e.test')", [id, workspaceId, `p-${id.slice(0, 8)}`]);
    return id;
  }
  const health = (actor: { accessToken: string; csrfToken: string }, projectId: string) =>
    harness.app().inject({ method: "GET", url: apiUrl(`/projects/${projectId}/engine-health`), cookies: { [ACCESS_COOKIE_NAME]: actor.accessToken, [CSRF_COOKIE_NAME]: actor.csrfToken } });

  it("STORY-090 · a project's engine health lists exactly its enabled engines, with the state the breaker and the catalog imply and when the episode began", async () => {
    const actor = await viewer();
    const projectId = await project(actor.workspaceId);
    const enabled = (await harness.db().query<{ engine_key: string }>("SELECT engine_key FROM project_entitled_engines WHERE project_id = $1 AND enabled = true ORDER BY engine_key", [projectId])).rows.map((r) => r.engine_key);
    expect(enabled.length, "the plan entitles at least one engine, or this test proves nothing").toBeGreaterThan(0);
    const [open, degraded] = enabled;
    await harness.db().query("UPDATE engines SET status = 'degraded' WHERE key = $1", [degraded]);
    const before = Date.now();
    await new EngineBreakerRegistry(redis).for(open as never).recordOutcome("quota_exhausted");

    const response = await health(actor, projectId);
    expect(response.statusCode, response.body).toBe(200);
    const body = dataOf<ProjectEngineHealthResponse>(response);
    expect(projectEngineHealthResponseSchema.safeParse(body).success).toBe(true);
    expect(body.map((e) => e.engine_key).sort()).toEqual([...enabled].sort());
    const byKey = new Map(body.map((e) => [e.engine_key, e]));
    expect(byKey.get(open!)!.state).toBe("unavailable");
    expect(Date.parse(byKey.get(open!)!.since!)).toBeGreaterThanOrEqual(before - 1_000);
    if (degraded !== open) expect(byKey.get(degraded!)).toMatchObject({ state: "degraded", since: null });
    for (const entry of body.filter((e) => e.engine_key !== open && e.engine_key !== degraded)) expect(entry).toMatchObject({ state: "healthy", since: null });
  });

  it("STORY-090 · another workspace's project is a 404, an unknown id is a 404, and no session is a 401", async () => {
    const mine = await viewer();
    const theirs = await viewer();
    const foreign = await project(theirs.workspaceId);
    expect((await health(mine, foreign)).statusCode).toBe(404);
    expect((await health(mine, randomUUID())).statusCode).toBe(404);
    expect((await harness.app().inject({ method: "GET", url: apiUrl(`/projects/${foreign}/engine-health`) })).statusCode).toBe(401);
  });

  it("refuses an anonymous caller", async () => {
    const response = await harness.app().inject({ method: "GET", url: apiUrl("/engines/status") });
    expect(response.statusCode).toBe(401);
  });
});
