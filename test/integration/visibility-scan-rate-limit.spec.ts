import { Pool } from "pg";
import type { Job } from "bullmq";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { ValkeyCacheAdapter } from "../../src/lib/cache/valkey-cache.adapter.js";
import type { CaptureAdapter, RawCapture } from "../../src/lib/engines/contract.js";
import type { SpendMeter } from "../../src/lib/engines/spend-meter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { UrlGuard } from "../../src/lib/net/url-guard.service.js";
import { createLookupExecuteHandler } from "../../src/lib/queue/handlers/lookup-execute.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-079 review round 1 - the route's rate limit, END TO END, on the SHIPPED defaults.
//
// This lives in its own file on purpose. The main scan spec installs a widened rate-limit document (most of its scenarios make more calls per user than the
// production class allows), and the guard reads its document through a 15 s memo, so a scenario that swapped documents mid-file could not be made
// deterministic. Here nothing is installed: the guard's first read is the defaults the product ships with.

vi.mock("../../src/lib/engines/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/engines/registry.js")>();
  return { ...actual, captureReadyEngineKeys: () => ["perplexity"] };
});


type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;
const ANSWER = "For subscription CRM, Acme is the most common choice.";
const raw = (): RawCapture => ({ text: ANSWER, format: "markdown", truncated: false, responseTokensEst: 20, latencyMs: 40, costUsd: 0 });
const adapter = (engineKey: string): CaptureAdapter => ({ engineKey: engineKey as CaptureAdapter["engineKey"], captureMode: "api", adapterVersion: "1.0.0", supportsCitations: true, concurrencyPerTask: 1, capture: async () => raw(), healthProbe: async () => ({ ok: true, latencyMs: 1 }) });

describe("STORY-079 review - the scan route is rate limited as a capture-backed tool (shipped defaults)", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({ env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }) });
  let pool: Pool;
  let sessions: SessionService;
  let workerCache: ValkeyCacheAdapter;
  let workers: Promise<unknown>[];

  beforeAll(async () => {
    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop()]);
  });
  beforeEach(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    sessions = new SessionService(pool, new MembershipService(new MembershipCacheService()), new InMemoryCacheAdapter());
    workerCache = new ValkeyCacheAdapter(cacheValkey.url);
    await workerCache.connect();
    workers = [];
    vi.spyOn(UrlGuard.prototype, "validateAndNormalize").mockImplementation(async (url: string) => ({ rootDomain: new URL(url).hostname }));
    vi.spyOn(QueueProducer.prototype, "enqueueTenantJob").mockImplementation(async (name, workspaceId, payload) => {
      if (name === "lookup.execute") workers.push(runWorker(workspaceId, payload));
      return {} as Job;
    });
  });
  afterEach(async () => {
    await Promise.allSettled(workers);
    vi.restoreAllMocks();
    await workerCache.onModuleDestroy();
    await pool.end();
  });

  function runWorker(workspaceId: string, payload: Record<string, unknown>): Promise<unknown> {
    const context = { pool, env: { VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString } } as unknown as QueueHandlerContext;
    const handler = createLookupExecuteHandler(context, {
      cache: workerCache,
      spendMeter: { isCeilingReached: async () => false, recordCost: async () => undefined } as unknown as SpendMeter,
      engineGate: { admit: async () => ({ kind: "admit" as const }), record: async () => undefined },
      resolveAdapter: (key) => adapter(key),
    });
    const job = { data: { payload: { ...payload, workspaceId } }, opts: { attempts: 3 }, attemptsMade: 0 } as unknown as Job;
    return (async () => {
      const client = await pool.connect();
      try {
        await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => handler(tx, job) as Promise<unknown>);
      } finally {
        client.release();
      }
    })();
  }

  async function owner() {
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
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => applyPlanChange(tx, workspaceId, planKeyOnly("business"), { requestId: "R", operator: "test", reason: "test" }));
    } finally {
      client.release();
    }
    const version = (await harness.db().query<{ entitlement_version: number }>("SELECT entitlement_version FROM workspaces WHERE id = $1", [workspaceId])).rows[0]!.entitlement_version;
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, version);
    return { cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  it("a third scan fired immediately after two is refused with 429", async () => {
    const a = await owner();
    const post = () =>
      harness.app().inject({
        method: "POST",
        url: apiUrl("/tools/visibility-scan"),
        headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json", "x-nominara-confirmed-credits": "10", "idempotency-key": uuidV7() },
        payload: { brand_name: "Acme", brand_url: "https://acme.test", query_text: `best crm ${uuidV7()}` },
      });
    const codes: number[] = [];
    for (let i = 0; i < 3; i += 1) codes.push((await post()).statusCode);
    expect(codes, codes.join(",")).toEqual([200, 200, 429]);
  }, 60_000);
});
