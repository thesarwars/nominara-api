import { Logger } from "@nestjs/common";
import { Pool } from "pg";
import type { Job } from "bullmq";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { RATE_LIMIT_DEFAULTS } from "../../src/api/rate-limit/defaults.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { CACHE, type Cache } from "../../src/lib/cache/cache.port.js";
import { rateLimitConfigKey } from "../../src/lib/cache/valkey-keys.js";
import { cacheKeyNamespace } from "../../src/lib/cache/key-namespace.js";
import { captureL1Key } from "../../src/lib/capture/l1-cache-key.js";
import { adapterMajorOf } from "../../src/lib/capture/l1-exact-hash.js";
import type { CaptureAdapter, CaptureContext, RawCapture } from "../../src/lib/engines/contract.js";
import { CaptureFailureError } from "../../src/lib/engines/failure-taxonomy.js";
import type { SpendMeter } from "../../src/lib/engines/spend-meter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { UrlGuard } from "../../src/lib/net/url-guard.service.js";
import { createLookupExecuteHandler, type LookupExecuteDeps } from "../../src/lib/queue/handlers/lookup-execute.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { TEST_SIGNING_KEYS } from "../support/queue-test-harness.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { VisibilityScanService } from "../../src/modules/tools/visibility-scan.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { realisedInternalCostUsd } from "../../src/lib/credits/internal-cost.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-079 - the Visibility Scan through the REAL ApiModule: the route, the guards, the ledger, the stream, and the worker handler.
// Scenario numbers are the story's Test scenarios table. The queue is the one seam replaced: `enqueueTenantJob` is captured and the worker handler
// is run in-process against a fake adapter, so no engine, no vendor and no network is touched.

const capture = vi.hoisted(() => ({ ready: ["perplexity", "chatgpt"] as string[] }));
vi.mock("../../src/lib/engines/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/engines/registry.js")>();
  return { ...actual, captureReadyEngineKeys: () => capture.ready };
});

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;
interface Actor { readonly workspaceId: string; readonly userId: string; readonly cookie: string; readonly csrf: string; readonly plan: "free" | "starter" | "growth" | "business" }
// The included grant of each tier (plan-entitlements.ts): a wallet is provisioned by its first debit, so before one the balance is the grant.
const GRANT = { free: 60, starter: 450, growth: 1200, business: 3000 } as const;
interface Frame { readonly event: string; readonly data: Record<string, unknown> }

const ANSWER = "For subscription CRM, Acme is the most common choice. HubSpot is also worth a look.\n\nSources: https://acme.test/pricing and https://reddit.com/r/crm";
// A FRESH QUERY PER SCAN: a live capture seeds the shared L1 cache (by design), so a repeated query would be answered from an earlier test's capture.
const body = (query = `best crm for startups ${uuidV7()}`) => ({ brand_name: "Acme", brand_url: "https://acme.test", query_text: query, competitors: ["HubSpot", "Zoho"] });

function raw(text = ANSWER, costUsd = 0): RawCapture {
  return { text, format: "markdown", truncated: false, responseTokensEst: 20, latencyMs: 40, costUsd };
}
function adapter(engineKey: string, capture: (ctx: CaptureContext) => Promise<RawCapture>): CaptureAdapter {
  return { engineKey: engineKey as CaptureAdapter["engineKey"], captureMode: "api", adapterVersion: "1.0.0", supportsCitations: true, concurrencyPerTask: 1, capture: async (_request, ctx) => await capture(ctx), healthProbe: async () => ({ ok: true, latencyMs: 1 }) };
}
const frames = (body: string): Frame[] =>
  body.split("\n\n").flatMap((chunk) => {
    const event = /^event: (.+)$/m.exec(chunk)?.[1];
    const data = /^data: (.+)$/m.exec(chunk)?.[1];
    return event === undefined || data === undefined ? [] : [{ event, data: JSON.parse(data) as Record<string, unknown> }];
  });

function widenedScanDocument(): string {
  return JSON.stringify(
    RATE_LIMIT_DEFAULTS.map((entry) =>
      entry.route_class === "capture_backed_tools"
        ? {
            route_class: "capture_backed_tools",
            burst: 20,
            buckets: [
              { scope: "user", limit: 50, window: "rolling", window_ms: 60_000 },
              { scope: "user", limit: 400, window: "rolling", window_ms: 86_400_000 },
              { scope: "workspace", limit: 200, window: "rolling", window_ms: 60_000 },
            ],
          }
        : entry,
    ),
  );
}

describe("STORY-079 · Visibility Scan", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  // The app and the worker share ONE cache, as they do in production (one Valkey). Under the test runner the app's own cache is a per-process in-memory
  // adapter, so a worker holding its own Valkey connection would publish events the stream could never see - and the stream would only ever be fed by the
  // stored snapshot at the end, which is exactly the path that must NOT be the only one tested.
  const sharedCache = new InMemoryCacheAdapter();
  const harness = useApiHarness({ cache: () => sharedCache, env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }) });
  let pool: Pool;
  let sessions: SessionService;
  let workerCache: Cache;
  let adapters: Record<string, (ctx: CaptureContext) => Promise<RawCapture>>;
  let workerDeps: Partial<LookupExecuteDeps>;
  let enqueued: { workspaceId: string; payload: Record<string, unknown>; options: Record<string, unknown> }[];
  let workers: Promise<unknown>[];
  let attemptsMade = 0;
  let viaProcessor = false;

  beforeAll(async () => {
    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop()]);
  });
  beforeEach(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    sessions = new SessionService(pool, new MembershipService(new MembershipCacheService()), new InMemoryCacheAdapter());
    workerCache = sharedCache;
    adapters = { perplexity: async () => raw(), chatgpt: async () => raw("HubSpot is the most common choice for this.") };
    workerDeps = {};
    attemptsMade = 0;
    viaProcessor = false;
    enqueued = [];
    workers = [];
    // The production class lets one user spend 2 scans at once (5/min). Most scenarios here make more calls than that per user, so they run on the widest
    // document the envelope allows (x10). That the route IS in the class is asserted on the handler (src/modules/tools/tools.spec.ts): the guard reads its
    // document through a 15 s memo, so a scenario that swaps documents mid-spec would have to sit out the memo.
    await harness.app().get<Cache>(CACHE).set(rateLimitConfigKey(cacheKeyNamespace()), widenedScanDocument(), { ttlMs: 3_600_000 });
    vi.spyOn(UrlGuard.prototype, "validateAndNormalize").mockImplementation(async (url: string) => ({ rootDomain: new URL(url).hostname }));
    // The queue seam: capture the job, then run the worker handler in-process (in the background, as a worker would).
    vi.spyOn(QueueProducer.prototype, "enqueueTenantJob").mockImplementation(async (name, workspaceId, payload, options) => {
      enqueued.push({ workspaceId, payload, options: options as unknown as Record<string, unknown> });
      if (name === "lookup.execute") workers.push(runWorker(workspaceId, payload));
      return {} as Job;
    });
  });
  afterEach(async () => {
    const settled = await Promise.allSettled(workers);
    vi.restoreAllMocks();
    await pool.end();
    // A worker that threw would otherwise be invisible (the stream would simply report a partial): surface it.
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed !== undefined) throw failed.reason as Error;
  });

  function runWorker(workspaceId: string, payload: Record<string, unknown>): Promise<unknown> {
    const context = { pool, env: { VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString } } as unknown as QueueHandlerContext;
    const handler = createLookupExecuteHandler(context, {
      cache: workerCache,
      spendMeter: { isCeilingReached: async () => false, recordCost: async () => ({ newAlerts: [], hardStopped: false, totalUsd: 0, ceilingUsd: 100 }) } as unknown as SpendMeter,
      engineGate: { admit: async () => ({ kind: "admit" as const }), record: async () => undefined },
      resolveAdapter: (key) => adapter(key, adapters[key] ?? (async () => { throw new CaptureFailureError("timeout", key as never); })),
      ...workerDeps,
    });
    // The REAL processor (signature check, two tenant transactions, and the recover hook on a failed attempt) when a scenario is about a failure path.
    if (viaProcessor) {
      const entry = QUEUE_TOPOLOGY.find((e) => e.name === "lookup.execute")!;
      const processor = createJobProcessor(entry, { keys: TEST_SIGNING_KEYS, getClient: () => pool.connect(), releaseClient: (client) => (client as unknown as { release(): void }).release(), process: handler });
      const envelope = signQueueJobPayload({ ...payload, workspaceId, kid: TEST_SIGNING_KEYS.current.kid } as never, TEST_SIGNING_KEYS.current.key);
      return processor({ data: envelope, opts: { attempts: 3 }, attemptsMade } as unknown as Job);
    }
    const job = { data: { payload: { ...payload, workspaceId } }, opts: { attempts: 3 }, attemptsMade } as unknown as Job;
    return (async () => {
      const client = await pool.connect();
      try {
        await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => handler(tx, job) as Promise<unknown>);
      } finally {
        client.release();
      }
    })();
  }

  async function owner(plan: "free" | "starter" | "growth" | "business" = "starter", overrides: Record<string, unknown> = {}): Promise<Actor> {
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
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => applyPlanChange(tx, workspaceId, planKeyOnly(plan), { requestId: "R", operator: "test", reason: "test" }));
    } finally {
      client.release();
    }
    // Overrides are applied BEFORE the session enters the workspace, because they bump the entitlement version the session is minted against.
    if (Object.keys(overrides).length > 0) await harness.db().query("UPDATE workspaces SET entitlement_overrides = $2::jsonb, entitlement_version = entitlement_version + 1 WHERE id = $1", [workspaceId, JSON.stringify(overrides)]);
    const version = (await harness.db().query<{ entitlement_version: number }>("SELECT entitlement_version FROM workspaces WHERE id = $1", [workspaceId])).rows[0]!.entitlement_version;
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, version);
    return { userId, workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken, plan };
  }

  const post = (a: Actor, over: { body?: unknown; confirmed?: number | null; key?: string | null } = {}) => {
    const headers: Record<string, string> = { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" };
    if (over.confirmed !== null) headers["x-nominara-confirmed-credits"] = String(over.confirmed ?? 10);
    if (over.key !== null) headers["idempotency-key"] = over.key ?? uuidV7();
    return harness.app().inject({ method: "POST", url: apiUrl("/tools/visibility-scan"), headers, payload: (over.body ?? body()) as object });
  };
  const get = (a: Actor, path: string) => harness.app().inject({ method: "GET", url: apiUrl(path), headers: { cookie: a.cookie } });
  const available = async (actor: Actor | string): Promise<number> => {
    const workspaceId = typeof actor === "string" ? actor : actor.workspaceId;
    const w = (await harness.db().query<{ included_balance: number; purchased_balance: number; reserved: number }>("SELECT included_balance, purchased_balance, reserved FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0];
    if (w === undefined) return typeof actor === "string" ? 0 : GRANT[actor.plan];
    return w.included_balance + w.purchased_balance - w.reserved;
  };
  const count = async (sql: string, args: unknown[] = []): Promise<number> => (await harness.db().query<{ n: number }>(sql, args)).rows[0]!.n;
  const runRow = async (id: string) => (await harness.db().query("SELECT * FROM tool_runs WHERE id = $1", [id])).rows[0] as { status: string };

  it("scenario 1 - a scan runs with no project in the workspace and consumes no project capacity, prompt slot or envelope", async () => {
    const a = await owner("starter");
    expect(await count("SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1", [a.workspaceId])).toBe(0);
    const res = await post(a);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const run = await runRow(enqueued[0]!.payload["toolRunId"] as string);
    expect(run.status).toBe("completed");
    for (const table of ["projects", "tracked_prompts", "capture_runs"]) {
      expect(await count(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`, [a.workspaceId]), table).toBe(0);
    }
  });

  it("scenario 2 - execute without the confirmed figure is refused (400), a wrong figure is price_changed (409), and nothing is charged or started", async () => {
    const a = await owner("starter");
    const before = await available(a);
    const missing = await post(a, { confirmed: null });
    expect(missing.statusCode, missing.body).toBe(400);
    const wrong = await post(a, { confirmed: 9 });
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(wrong.json()).toMatchObject({ error: { code: "price_changed", details: { shown: 9, recomputed: 10 } } });
    const noKey = await post(a, { key: null });
    expect(noKey.statusCode, noKey.body).toBe(400);
    expect(await available(a)).toBe(before);
    expect(enqueued).toHaveLength(0);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(0);
  });

  it("scenario 2 - an unknown body key (an engine picker) is a 400, not a silent drop", async () => {
    const a = await owner("starter");
    const res = await post(a, { body: { ...body(), engines: ["chatgpt"] } });
    expect(res.statusCode, res.body).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  it("scenario 3 - the estimate names the engines BEFORE the run, states the flat price, and offers nothing to pick", async () => {
    const a = await owner("starter");
    const res = await get(a, "/tools/visibility-scan/estimate");
    expect(res.statusCode, res.body).toBe(200);
    const body = (res.json() as { data: { engines: { engine_key: string }[] } }).data;
    expect(body).toMatchObject({ credits: 10, rate: "flat", engines_selectable: false, consumes: { project_slots: 0, prompt_slots: 0, scheduled_envelope: false } });
    expect(body.engines.map((e) => e.engine_key)).toEqual(["perplexity", "chatgpt"]);
    expect(Object.keys(body)).not.toContain("engine");
    expect(await count("SELECT count(*)::int AS n FROM tool_runs")).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it("scenario 4 - an excluded engine can never be in a run's set: the database constraint refuses the row", async () => {
    const a = await owner("starter");
    await expect(
      harness.db().query(
        `INSERT INTO tool_runs (id, workspace_id, tool_key, brand_name, query_text, input_hash, engine_keys, status, expires_at, credits_charged)
         VALUES ($1,$2,'visibility_scan','Acme','q','h',ARRAY['claude'],'running', now() + interval '1 day', 10)`,
        [uuidV7(), a.workspaceId],
      ),
    ).rejects.toThrow(/ck_tr_engine_set/);
  });

  it("scenario 5 - the stream: accepted, one result per engine with all six fields, then the terminal event; the charge is the flat price", async () => {
    const a = await owner("starter");
    const before = await available(a);
    const res = await post(a);
    const fs = frames(res.body);
    expect(fs[0]!.event).toBe("scan.accepted");
    expect(fs[0]!.data).toMatchObject({ engines: ["perplexity", "chatgpt"], one_sample_per_engine: true, credits: { reserved: 10, rate: "flat" } });
    const results = fs.filter((f) => f.event === "scan.engine_result");
    expect(results.map((f) => f.data["engine"]).sort()).toEqual(["chatgpt", "perplexity"]);
    for (const f of results) {
      for (const field of ["brand_present", "rank_position", "sov", "sentiment", "citations", "excerpt"]) expect(f.data, field).toHaveProperty(field);
      expect(f.data["estimated"]).toBe(true);
    }
    expect(fs.at(-1)!.event).toBe("scan.completed");
    expect(fs.at(-1)!.data).toMatchObject({ status: "completed", settled: true, credits: { charged: 10, refunded: 0 }, not_tracked: true });
    expect(await available(a)).toBe(before - 10);
  });

  it("scenario 6 - all engines fail: a terminal event is emitted, the run is failed and the wallet is restored exactly, with one refund entry", async () => {
    const a = await owner("starter");
    adapters = {};
    const before = await available(a);
    const res = await post(a);
    const fs = frames(res.body);
    expect(fs.map((f) => f.event)).toEqual(["scan.accepted", "scan.completed"]);
    expect(fs[1]!.data).toMatchObject({ status: "failed", credits: { charged: 0, refunded: 10 }, convert_cta: null });
    expect((fs[1]!.data["engine_failures"] as unknown[]).length).toBe(2);
    expect(await available(a)).toBe(before);
    const id = enqueued[0]!.payload["toolRunId"] as string;
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 AND entry_type = 'refund' AND credits = 10", [a.workspaceId, id])).toBe(1);
    expect((await runRow(id)).status).toBe("failed");
  });

  it("final attempt - an unexpected error escaping the run on the last delivery settles the scan failed as scan_job_failed and returns the 10 credits exactly once", async () => {
    const a = await owner("starter");
    attemptsMade = 2;
    viaProcessor = true;
    workerDeps = { now: () => { throw new Error("boom"); } };
    const before = await available(a);
    const res = await post(a);
    expect(res.statusCode, res.body).toBe(200);
    await Promise.allSettled(workers);
    const id = enqueued[0]!.payload["toolRunId"] as string;
    const row = await runRow(id);
    expect(row.status).toBe("failed");
    expect(await available(a)).toBe(before);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1 AND id = $2 AND error_code = 'scan_job_failed' AND credits_charged = 0", [a.workspaceId, id])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 AND entry_type = 'refund' AND credits = 10", [a.workspaceId, id])).toBe(1);
  });

  it("scenario 7 - a dropped connection does not abort the run; the same Idempotency-Key reattaches, replays what landed, and charges nothing more", async () => {
    const a = await owner("starter");
    const before = await available(a);
    const key = uuidV7();
    const same = body();
    const first = await post(a, { key, body: same });
    expect(frames(first.body).at(-1)!.event).toBe("scan.completed");
    const afterFirst = await available(a);
    const again = await post(a, { key, body: same });
    const fs = frames(again.body);
    expect(again.statusCode, again.body).toBe(200);
    expect(fs.filter((f) => f.event === "scan.engine_result")).toHaveLength(2);
    expect(fs.at(-1)!.event).toBe("scan.completed");
    expect(enqueued).toHaveLength(1);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(1);
    expect(await available(a)).toBe(afterFirst);
    expect(afterFirst).toBe(before - 10);
    // The same key with a different body is a conflict, never a silent attach to someone else's run.
    const clash = await post(a, { key, body: { ...body(), query_text: "something else entirely" } });
    expect(clash.statusCode, clash.body).toBe(409);
  });

  it("scenario 8 - an engine past the deadline: partial returned, charged in full, the failure named", async () => {
    const a = await owner("starter");
    adapters = { perplexity: async () => raw(), chatgpt: () => new Promise<RawCapture>(() => undefined) };
    workerDeps = { deadlineMs: 300 };
    const before = await available(a);
    const res = await post(a);
    const done = frames(res.body).at(-1)!;
    expect(done.data).toMatchObject({ status: "partial", deadline_reached: true, credits: { charged: 10, refunded: 0 } });
    expect(done.data["engine_failures"]).toEqual([expect.objectContaining({ engine: "chatgpt", code: "deadline_exceeded" })]);
    expect(frames(res.body).filter((f) => f.event === "scan.engine_result")).toHaveLength(1);
    expect(await available(a)).toBe(before - 10);
  });

  it("scenario 9 - a cached engine is served from cache and labelled with its TRUE capture age, not the run's time", async () => {
    const a = await owner("starter");
    const seeded = body();
    const engine = (await harness.db().query<{ cache_ttl_seconds: number; adapter_version: string }>("SELECT cache_ttl_seconds, adapter_version FROM engines WHERE key = 'perplexity'")).rows[0]!;
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await workerCache.set(
      captureL1Key({ env: cacheKeyNamespace(), engineKey: "perplexity", adapterMajor: adapterMajorOf(engine.adapter_version), promptText: seeded.query_text, locale: "en-US", personaHint: null, ttlSeconds: engine.cache_ttl_seconds, nowMs: Date.now() }),
      JSON.stringify({ v: 2, contentHash: "a".repeat(64), payload: { format: "markdown", text: ANSWER }, excerpt: "x", capturedAt: twoHoursAgo }),
      { ttlMs: 60_000 },
    );
    let liveCalls = 0;
    adapters = { perplexity: async () => { liveCalls += 1; return raw(); }, chatgpt: async () => raw() };
    const res = await post(a, { body: seeded });
    const cached = frames(res.body).find((f) => f.event === "scan.engine_result" && f.data["engine"] === "perplexity")!;
    expect(cached.data["cache_layer"]).toBe("l1");
    expect(cached.data["captured_at"]).toBe(twoHoursAgo);
    expect(cached.data["age_ms"] as number).toBeGreaterThanOrEqual(2 * 3_600_000);
    expect(liveCalls).toBe(0);
  });

  it("scenario 10 - the stored payload states one sample per engine, flags every estimate, and carries the not-tracked marker and the did-not-check line", async () => {
    const a = await owner("starter");
    await post(a);
    const id = enqueued[0]!.payload["toolRunId"] as string;
    const detail = ((await get(a, `/tools/runs/${id}`)).json() as { data: { result: { engines: { estimated: boolean }[] } } }).data;
    expect(detail).toMatchObject({
      presentation: { not_tracked: true, did_not_check: expect.stringMatching(/one sample per engine/i), estimated_fields: expect.arrayContaining(["sov_estimate", "citation_count", "brand_present"]) },
      result: { one_sample_per_engine: true, sample_statement: expect.stringMatching(/one sample per engine/i) },
    });
    expect(detail.result.engines.every((e) => e.estimated)).toBe(true);
  });

  it("scenario 11 - after a scan, the fact tables hold zero rows: no capture, no mention, no citation, no rollup, no task", async () => {
    const a = await owner("starter");
    await post(a);
    for (const table of ["answer_captures", "mention_facts", "citation_facts", "capture_runs", "metric_daily", "tasks"]) {
      expect(await count(`SELECT count(*)::int AS n FROM ${table}`), table).toBe(0);
    }
  });

  it("scenario 12 - re-opening the stored report is free: one GET, wallet unchanged, no queue job, no ledger row", async () => {
    const a = await owner("free");
    await post(a);
    const id = enqueued[0]!.payload["toolRunId"] as string;
    const walletBefore = await available(a);
    const ledgerBefore = await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1", [a.workspaceId]);
    const jobs = enqueued.length;
    const opened = await get(a, `/tools/runs/${id}`);
    expect(opened.statusCode).toBe(200);
    expect(await available(a)).toBe(walletBefore);
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1", [a.workspaceId])).toBe(ledgerBefore);
    expect(enqueued).toHaveLength(jobs);
  });

  it("scenario 13 + 14 - convert pre-fills brand, URL, the query as the FIRST prompt and the detected competitors, through the shared conversion route", async () => {
    const a = await owner("growth");
    const asked = body();
    const res = await post(a, { body: asked });
    const cta = frames(res.body).at(-1)!.data["convert_cta"] as { endpoint: string; prefill: Record<string, unknown> };
    const id = enqueued[0]!.payload["toolRunId"] as string;
    expect(cta.endpoint).toBe(`/v1/tools/runs/${id}/convert`);
    // Decision 108(b): the prefill also carries the engines that answered the run, in run order (display only).
    expect(cta.prefill).toEqual({ project_name: "Acme", root_url: "https://acme.test", prompts: [asked.query_text], competitors: ["HubSpot"], engines: ["perplexity", "chatgpt"] });
    const preview = ((await get(a, `/tools/runs/${id}/convert`)).json() as { data: unknown }).data;
    expect(preview).toMatchObject({ prefill: cta.prefill, project_slot: { free: true }, prompt_slots: { carried: 1 } });
  });

  it("the Gemini spend ceiling gates the Tools path: at the ceiling the engine is NOT called and the failure is named", async () => {
    const a = await owner("starter");
    let calls = 0;
    adapters = { perplexity: async () => { calls += 1; return raw(); }, chatgpt: async () => { calls += 1; return raw(); } };
    workerDeps = { spendMeter: { isCeilingReached: async () => true, recordCost: async () => ({ newAlerts: [], hardStopped: true, totalUsd: 1, ceilingUsd: 1 }) } as unknown as SpendMeter };
    const before = await available(a);
    const res = await post(a);
    expect(calls).toBe(0);
    const done = frames(res.body).at(-1)!;
    expect(done.data).toMatchObject({ status: "failed", credits: { charged: 0, refunded: 10 } });
    expect((done.data["engine_failures"] as { code: string }[]).map((f) => f.code)).toEqual(["engine_spend_ceiling_reached", "engine_spend_ceiling_reached"]);
    expect(await available(a)).toBe(before);
  });

  it("an unreadable spend meter fails closed: the engine is not called", async () => {
    const a = await owner("starter");
    let calls = 0;
    adapters = { perplexity: async () => { calls += 1; return raw(); }, chatgpt: async () => { calls += 1; return raw(); } };
    workerDeps = { spendMeter: { isCeilingReached: async () => { throw new Error("meter down"); }, recordCost: async () => undefined } as unknown as SpendMeter };
    const res = await post(a);
    expect(calls).toBe(0);
    expect(frames(res.body).at(-1)!.data).toMatchObject({ status: "failed" });
  });

  it("a scan with no engine able to capture is refused before anything is charged", async () => {
    const a = await owner("starter");
    capture.ready = [];
    try {
      const before = await available(a);
      const res = await post(a);
      expect(res.statusCode, res.body).toBe(422);
      expect(await available(a)).toBe(before);
      expect(enqueued).toHaveLength(0);
    } finally {
      capture.ready = ["perplexity", "chatgpt"];
    }
  });

  it("scenario 4 (plan set) - the free tier's set is its two engines; a refused request gives its daily allowance back, a started one keeps it", async () => {
    const a = await owner("free");
    // Three refusals must not eat the free tier's 3-per-day allowance (STORY-071 AC6) ...
    for (let i = 0; i < 3; i += 1) expect((await post(a, { confirmed: 1 })).statusCode).toBe(409);
    // ... so three real scans still fit, and the fourth is the cap.
    for (let i = 0; i < 3; i += 1) expect((await post(a)).statusCode, `scan ${i + 1}`).toBe(200);
    const fourth = await post(a);
    expect(fourth.statusCode, fourth.body).toBe(429);
    expect(fourth.json()).toMatchObject({ error: { code: "daily_limit_reached" } });
  });

  it("an insufficient wallet is a 402 and starts nothing", async () => {
    const a = await owner("starter");
    // The wallet is provisioned by the first debit: spend once, then drain it below the price.
    expect((await post(a)).statusCode).toBe(200);
    await harness.db().query("UPDATE credit_wallets SET included_balance = 5, purchased_balance = 0 WHERE workspace_id = $1", [a.workspaceId]);
    const res = await post(a);
    expect(res.statusCode, res.body).toBe(402);
    expect(enqueued).toHaveLength(1);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(1);
  });

  it("a scan is tenant-scoped: another workspace cannot re-open it or reattach to it", async () => {
    const a = await owner("starter");
    const b = await owner("starter");
    const key = uuidV7();
    const same = body();
    await post(a, { key, body: same });
    const id = enqueued[0]!.payload["toolRunId"] as string;
    expect((await get(b, `/tools/runs/${id}`)).statusCode).toBe(404);
    const attach = await post(b, { key, body: same });
    expect(attach.statusCode, attach.body).toBe(200);
    expect(enqueued).toHaveLength(2);
  });

  it("observability - the scan emits its metrics and a log line that carries the workspace ID and no brand, query or answer text", async () => {
    const a = await owner("starter");
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
      lines.push(message);
    });
    await post(a);
    const metrics = lines.filter((l): l is { metric: string } => typeof l === "object" && l !== null && "metric" in l).map((l) => l.metric);
    expect(metrics).toEqual(expect.arrayContaining(["nominara_tools_scan_requests_total", "nominara_tools_scan_streams_total", "nominara_tools_scan_engine_results_total"]));
    const accepted = lines.find((l) => typeof l === "object" && l !== null && (l as { event?: string }).event === "tools.scan.accepted") as { workspace_id: string } | undefined;
    expect(accepted?.workspace_id).toBe(a.workspaceId);
    const everything = JSON.stringify(lines);
    for (const forbidden of ["Acme", "best crm for startups", "most common choice", "acme.test"]) expect(everything, forbidden).not.toContain(forbidden);
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------
  // REVIEW ROUND 1
  // ---------------------------------------------------------------------------------------------------------------------------------------
  const l1KeyFor = async (engineKey: string, query: string): Promise<string> => {
    const engine = (await harness.db().query<{ cache_ttl_seconds: number; adapter_version: string }>("SELECT cache_ttl_seconds, adapter_version FROM engines WHERE key = $1", [engineKey])).rows[0]!;
    return captureL1Key({ env: cacheKeyNamespace(), engineKey: engineKey as never, adapterMajor: adapterMajorOf(engine.adapter_version), promptText: query, locale: "en-US", personaHint: null, ttlSeconds: engine.cache_ttl_seconds, nowMs: Date.now() });
  };

  it("no_shared_cache - a flagged workspace neither reads another tenant's cached answer nor leaves its own in the shared cache; an unflagged one does both", async () => {
    const flagged = await owner("starter", { no_shared_cache: true });
    const seeded = body();
    await workerCache.set(
      await l1KeyFor("perplexity", seeded.query_text),
      JSON.stringify({ v: 2, contentHash: "b".repeat(64), payload: { format: "markdown", text: "ANOTHER TENANT'S ANSWER about Acme" }, excerpt: "x", capturedAt: new Date(Date.now() - 3_600_000).toISOString() }),
      { ttlMs: 60_000 },
    );
    let liveCalls = 0;
    adapters = { perplexity: async () => { liveCalls += 1; return raw(); }, chatgpt: async () => { liveCalls += 1; return raw(); } };
    const res = await post(flagged, { body: seeded });
    const results = frames(res.body).filter((f) => f.event === "scan.engine_result");
    expect(results, res.body).toHaveLength(2);
    expect(results.map((f) => f.data["cache_layer"])).toEqual(["none", "none"]);
    expect(liveCalls).toBe(2);
    // The flagged workspace's own live answers were NOT written to the shared namespace: the only entry under the seeded key is still the other tenant's.
    expect(await workerCache.get(await l1KeyFor("chatgpt", seeded.query_text))).toBeUndefined();
    expect(await workerCache.get(await l1KeyFor("perplexity", seeded.query_text))).toContain("ANOTHER TENANT'S ANSWER");

    // Control: an unflagged workspace DOES seed the shared cache.
    const open = await owner("starter");
    const fresh = body();
    await post(open, { body: fresh });
    expect(await workerCache.get(await l1KeyFor("chatgpt", fresh.query_text))).toBeDefined();
  });

  it("usage_ledger - a live capture with a vendor cost is attributed to the workspace (source lookup, reference the run); a cached answer and a redelivered commit add nothing", async () => {
    const a = await owner("starter");
    adapters = { perplexity: async (ctx) => { ctx.recordCost(0.004); return raw(ANSWER, 0.004); }, chatgpt: async () => raw("HubSpot is the most common choice for this.", 0) };
    await post(a);
    const id = enqueued[0]!.payload["toolRunId"] as string;
    const rows = (await harness.db().query<{ engine_key: string; source: string; unit_cost_usd: string; cache_layer: string; reference_type: string }>("SELECT engine_key, source, unit_cost_usd, cache_layer, reference_type FROM usage_ledger WHERE workspace_id = $1 AND reference_id = $2", [a.workspaceId, id])).rows;
    expect(rows).toEqual([{ engine_key: "perplexity", source: "lookup", unit_cost_usd: "0.004000", cache_layer: "live", reference_type: "tool_run" }]);
  });

  it("STORY-073 AC9 - the scan's cost row is linked to the tool run's commit entry (the debit committed at accept, before the cost existed), and the ledger read sums it", async () => {
    const a = await owner("starter");
    adapters = { perplexity: async (ctx) => { ctx.recordCost(0.004); return raw(ANSWER, 0.004); }, chatgpt: async () => raw("HubSpot is the most common choice for this.", 0) };
    await post(a);
    const id = enqueued[0]!.payload["toolRunId"] as string;
    const commit = (await harness.db().query<{ id: string; internal_cost_usd: string | null }>("SELECT id, internal_cost_usd::text FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'commit' AND reference_type = 'tool_run' AND reference_id = $2", [a.workspaceId, id])).rows;
    expect(commit).toHaveLength(1);
    expect(commit[0]!.internal_cost_usd).toBeNull();
    const linked = (await harness.db().query<{ credit_ledger_id: string | null }>("SELECT credit_ledger_id FROM usage_ledger WHERE workspace_id = $1 AND reference_id = $2", [a.workspaceId, id])).rows;
    expect(linked).toEqual([{ credit_ledger_id: commit[0]!.id }]);
    expect(await realisedInternalCostUsd(harness.db(), commit[0]!.id)).toBe("0.004000");
  });

  it("round 2 - the spend meter's verdict on a Tools capture is reported: the call that crosses 80% logs the alert, and the crossing into the hard stop is logged", async () => {
    const a = await owner("starter");
    const warn = vi.spyOn(Logger.prototype, "warn");
    const error = vi.spyOn(Logger.prototype, "error");
    adapters = { perplexity: async (ctx) => { ctx.recordCost(0.004); return raw(ANSWER, 0.004); }, chatgpt: async () => raw("HubSpot is the most common choice for this.", 0) };
    workerDeps = { spendMeter: { isCeilingReached: async () => false, recordCost: async () => ({ newAlerts: ["warn_80"], hardStopped: true, totalUsd: 81, ceilingUsd: 100 }) } as unknown as SpendMeter };
    await post(a);
    expect(warn.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("warn_80") && c[0].includes("perplexity"))).toBe(true);
    expect(error.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("ceiling crossed"))).toBe(true);
  });

  it("round 2 - a capture that answers AFTER the scan deadline still has its vendor cost attributed to the workspace in usage_ledger", async () => {
    const a = await owner("starter");
    adapters = {
      perplexity: async () => raw(),
      chatgpt: (ctx) => new Promise<RawCapture>((resolve) => setTimeout(() => { ctx.recordCost(0.007); resolve(raw("HubSpot is the most common choice for this.", 0.007)); }, 600)),
    };
    workerDeps = { deadlineMs: 200, lateCostGraceMs: 3_000 };
    await post(a);
    const id = enqueued[0]!.payload["toolRunId"] as string;
    const rows = (await harness.db().query<{ engine_key: string; unit_cost_usd: string }>("SELECT engine_key, unit_cost_usd FROM usage_ledger WHERE workspace_id = $1 AND reference_id = $2", [a.workspaceId, id])).rows;
    expect(rows).toEqual([{ engine_key: "chatgpt", unit_cost_usd: "0.007000" }]);
  });

  it("scenario 7 (mid-run) - a client that drops while an engine is still running does not stop the run; the same Idempotency-Key reattaches, is replayed what landed, and receives the rest - one run, one debit", async () => {
    const a = await owner("starter");
    const before = await available(a);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    adapters = { perplexity: async () => raw(), chatgpt: async () => { await gate; return raw("HubSpot is the most common choice for this."); } };
    const service = harness.app().get(VisibilityScanService);
    const tenant = { workspaceId: a.workspaceId, actorId: a.userId };
    const key = uuidV7();
    const asked = body();
    const accepted = await service.accept(tenant, asked, { confirmedCredits: "10", idempotencyKey: key }, { actorType: "user", ip: null, userAgent: null, requestId: "R" });
    const chunks: string[] = [];
    let drop!: () => void;
    const first = service.stream(tenant, accepted, { write: (c) => chunks.push(c), end: () => undefined, onClose: (cb) => { drop = cb; } }, { pollMs: 20 });
    await vi.waitFor(() => expect(frames(chunks.join("")).some((f) => f.event === "scan.engine_result")).toBe(true), { timeout: 15_000 });
    drop();
    await first;
    // The first connection saw one engine and NO terminal event; the run itself is untouched.
    expect(frames(chunks.join("")).map((f) => f.event)).not.toContain("scan.completed");
    expect((await runRow(accepted.runId)).status).toBe("running");
    const reattached = post(a, { key, body: asked });
    release();
    const res = await reattached;
    const fs = frames(res.body);
    expect(res.statusCode, res.body).toBe(200);
    expect(fs.filter((f) => f.event === "scan.engine_result").map((f) => f.data["engine"]).sort()).toEqual(["chatgpt", "perplexity"]);
    expect(fs.at(-1)).toMatchObject({ event: "scan.completed", data: { status: "completed", settled: true } });
    expect(enqueued).toHaveLength(1);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'commit'", [a.workspaceId])).toBe(1);
    expect(await available(a)).toBe(before - 10);
  });

  it("concurrency - twenty simultaneous POSTs with the SAME Idempotency-Key start one run and take 10 credits once", async () => {
    const a = await owner("starter");
    const before = await available(a);
    const key = uuidV7();
    const same = body();
    const responses = await Promise.all(Array.from({ length: 20 }, () => post(a, { key, body: same })));
    for (const r of responses) {
      expect(r.statusCode, r.body).toBe(200);
      expect(frames(r.body).at(-1)!.event).toBe("scan.completed");
    }
    expect(enqueued).toHaveLength(1);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'commit'", [a.workspaceId])).toBe(1);
    expect(await available(a)).toBe(before - 10);
  }, 60_000);

  it("concurrency - nineteen simultaneous POSTs with DIFFERENT keys against a wallet that holds exactly one scan: one succeeds, eighteen are 402, the balance is 0 and never negative", async () => {
    const a = await owner("starter");
    expect((await post(a)).statusCode).toBe(200);
    await harness.db().query("UPDATE credit_wallets SET included_balance = 10, purchased_balance = 0, reserved = 0 WHERE workspace_id = $1", [a.workspaceId]);
    const runsBefore = await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId]);
    // 19, not 20: the widened rate-limit burst is 20 and the provisioning scan above has spent one token.
    const responses = await Promise.all(Array.from({ length: 19 }, () => post(a)));
    const codes = responses.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200), codes.join(",")).toHaveLength(1);
    expect(codes.filter((c) => c === 402), codes.join(",")).toHaveLength(18);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(runsBefore + 1);
    expect(await available(a)).toBe(0);
    const w = (await harness.db().query<{ included_balance: number; purchased_balance: number }>("SELECT included_balance, purchased_balance FROM credit_wallets WHERE workspace_id = $1", [a.workspaceId])).rows[0]!;
    expect(w.included_balance).toBeGreaterThanOrEqual(0);
    expect(w.purchased_balance).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("round 3 - a 402 refusal is not bound to another key's run: after a top-up the SAME refused key starts its own scan, charged once", async () => {
    const a = await owner("starter");
    const same = body();
    const first = await post(a, { body: same });
    expect(first.statusCode, first.body).toBe(200);
    await harness.db().query("UPDATE credit_wallets SET included_balance = 0, purchased_balance = 0, reserved = 0 WHERE workspace_id = $1", [a.workspaceId]);
    const refusedKey = uuidV7();
    const refused = await post(a, { key: refusedKey, body: same });
    expect(refused.statusCode, refused.body).toBe(402);
    await harness.db().query("UPDATE credit_wallets SET included_balance = 10 WHERE workspace_id = $1", [a.workspaceId]);
    const retry = await post(a, { key: refusedKey, body: same });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(frames(retry.body)[0]!.data).not.toMatchObject({ resumed: true });
    expect(enqueued).toHaveLength(2);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(2);
    expect(await available(a)).toBe(0);
  }, 60_000);

  it("round 3 - a start that threw AFTER Postgres committed (the real probe query) keeps the claim: the retry of the same key attaches, one run, one debit", async () => {
    const a = await owner("starter");
    const service = harness.app().get(VisibilityScanService) as unknown as { start: (...args: unknown[]) => Promise<unknown> };
    const real = service.start.bind(service);
    vi.spyOn(service, "start").mockImplementationOnce(async (...args: unknown[]) => {
      await real(...args);
      throw new Error("connection terminated during COMMIT");
    });
    const before = await available(a);
    const key = uuidV7();
    const same = body();
    expect((await post(a, { key, body: same })).statusCode).toBe(500);
    const retry = await post(a, { key, body: same });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'commit'", [a.workspaceId])).toBe(1);
    expect(await available(a)).toBe(before - 10);
  }, 60_000);

  it("round 3 - a capture cancelled by the scan's own abort is not recorded as an engine failure on the breaker; a real failure still is", async () => {
    const a = await owner("starter");
    const recorded: { key: string; code?: string }[] = [];
    // perplexity fails on its own, BEFORE the deadline: that is the vendor's failure and the breaker must hear it. chatgpt is only cancelled by the scan's abort.
    adapters = {
      perplexity: async () => { throw new CaptureFailureError("rate_limited", "perplexity" as never); },
      chatgpt: (ctx) => new Promise<RawCapture>((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(new CaptureFailureError("timeout", "chatgpt" as never)), { once: true })),
    };
    workerDeps = {
      deadlineMs: 300,
      engineGate: { admit: async () => ({ kind: "admit" as const }), record: async (key: string, outcome: { outcome: string; code?: string }) => { if (outcome.outcome === "failure") recorded.push({ key, ...(outcome.code !== undefined ? { code: outcome.code } : {}) }); } },
    } as Partial<LookupExecuteDeps>;
    const res = await post(a);
    expect(res.statusCode, res.body).toBe(200);
    await Promise.allSettled(workers);
    expect(recorded.filter((r) => r.key === "chatgpt")).toEqual([]);
    expect(recorded.filter((r) => r.key === "perplexity")).toEqual([{ key: "perplexity", code: "rate_limited" }]);
  }, 60_000);

  it("fix/result-document-text rules on the Tools path - a truncated EMPTY answer fails as malformed_response (breaker hears a success); a truncated, a flagged or an empty answer is never seeded into the shared cache", async () => {
    const a = await owner("starter");
    const q = body();
    const recorded: { key: string; outcome: string }[] = [];
    adapters = {
      perplexity: async () => ({ ...raw(""), truncated: true }),
      chatgpt: async () => ({ ...raw("HubSpot is a partial answer cut off"), truncated: true }),
    };
    workerDeps = { engineGate: { admit: async () => ({ kind: "admit" as const }), record: async (key: string, o: { outcome: string }) => { recorded.push({ key, outcome: o.outcome }); } } } as Partial<LookupExecuteDeps>;
    const res = await post(a, { body: q });
    expect(res.statusCode, res.body).toBe(200);
    await Promise.allSettled(workers);
    const done = frames(res.body).find((f) => f.event === "scan.completed")!;
    expect(done.data["engine_failures"]).toEqual([expect.objectContaining({ engine: "perplexity", code: "malformed_response" })]);
    expect(recorded.filter((r) => r.key === "perplexity")).toEqual([{ key: "perplexity", outcome: "success" }]);
    expect(await workerCache.get(await l1KeyFor("perplexity", q.query_text))).toBeUndefined();
    expect(await workerCache.get(await l1KeyFor("chatgpt", q.query_text))).toBeUndefined();
  }, 60_000);

  it("the job is enqueued on the dedicated interactive pool, keyed by the run", async () => {
    const a = await owner("starter");
    await post(a);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.options).toMatchObject({ priorityVariant: "interactive", idempotencyKey: `lookup:${enqueued[0]!.payload["toolRunId"] as string}` });
  });
});
