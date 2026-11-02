import { Logger } from "@nestjs/common";
import { Pool } from "pg";
import type { Job } from "bullmq";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { ValkeyCacheAdapter } from "../../src/lib/cache/valkey-cache.adapter.js";
import { cacheKeyNamespace } from "../../src/lib/cache/key-namespace.js";
import { captureL1Key } from "../../src/lib/capture/l1-cache-key.js";
import { adapterMajorOf } from "../../src/lib/capture/l1-exact-hash.js";
import type { CaptureAdapter, RawCapture } from "../../src/lib/engines/contract.js";
import { CaptureFailureError } from "../../src/lib/engines/failure-taxonomy.js";
import type { SpendMeter } from "../../src/lib/engines/spend-meter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { UrlGuard } from "../../src/lib/net/url-guard.service.js";
import { createLookupExecuteHandler, type LookupExecuteDeps } from "../../src/lib/queue/handlers/lookup-execute.handler.js";
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

function raw(text = ANSWER): RawCapture {
  return { text, format: "markdown", truncated: false, responseTokensEst: 20, latencyMs: 40, costUsd: 0 };
}
function adapter(engineKey: string, capture: () => Promise<RawCapture>): CaptureAdapter {
  return { engineKey: engineKey as CaptureAdapter["engineKey"], captureMode: "api", adapterVersion: "1.0.0", supportsCitations: true, concurrencyPerTask: 1, capture, healthProbe: async () => ({ ok: true, latencyMs: 1 }) };
}
const frames = (body: string): Frame[] =>
  body.split("\n\n").flatMap((chunk) => {
    const event = /^event: (.+)$/m.exec(chunk)?.[1];
    const data = /^data: (.+)$/m.exec(chunk)?.[1];
    return event === undefined || data === undefined ? [] : [{ event, data: JSON.parse(data) as Record<string, unknown> }];
  });

describe("STORY-079 · Visibility Scan", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({ env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }) });
  let pool: Pool;
  let sessions: SessionService;
  let workerCache: ValkeyCacheAdapter;
  let adapters: Record<string, () => Promise<RawCapture>>;
  let workerDeps: Partial<LookupExecuteDeps>;
  let enqueued: { workspaceId: string; payload: Record<string, unknown>; options: Record<string, unknown> }[];
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
    adapters = { perplexity: async () => raw(), chatgpt: async () => raw("HubSpot is the most common choice for this.") };
    workerDeps = {};
    enqueued = [];
    workers = [];
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
    await workerCache.onModuleDestroy();
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

  async function owner(plan: "free" | "starter" | "growth" | "business" = "starter"): Promise<Actor> {
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
    expect(fs.at(-1)!.data).toMatchObject({ status: "completed", credits: { charged: 10, refunded: 0 }, not_tracked: true });
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
      JSON.stringify({ v: 1, contentHash: "a".repeat(64), payload: { format: "markdown", text: ANSWER }, excerpt: "x", capturedAt: twoHoursAgo }),
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
    expect(cta.prefill).toEqual({ project_name: "Acme", root_url: "https://acme.test", prompts: [asked.query_text], competitors: ["HubSpot"] });
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

  it("the job is enqueued on the dedicated interactive pool, keyed by the run", async () => {
    const a = await owner("starter");
    await post(a);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.options).toMatchObject({ priorityVariant: "interactive", idempotencyKey: `lookup:${enqueued[0]!.payload["toolRunId"] as string}` });
  });
});
