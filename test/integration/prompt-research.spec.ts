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
import type { CaptureAdapter, CaptureContext, RawCapture } from "../../src/lib/engines/contract.js";
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


// STORY-080 - Prompt Research through the REAL ApiModule: the routes, the guards, the ledger and the worker handler. Scenario numbers are the story's table.
// The queue is the one seam replaced: `enqueueTenantJob` is captured and the worker handler is run in-process against fake adapters, so no engine or vendor is touched.

const capture = vi.hoisted(() => ({ ready: ["perplexity", "chatgpt"] as string[] }));
vi.mock("../../src/lib/engines/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/engines/registry.js")>();
  return { ...actual, captureReadyEngineKeys: () => capture.ready };
});

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;
interface Actor { readonly workspaceId: string; readonly userId: string; readonly cookie: string; readonly csrf: string; readonly plan: "free" | "starter" | "growth" | "business" }
const GRANT = { free: 60, starter: 450, growth: 1200, business: 3000 } as const;

const RICH = { category_slug: "crm", personas: ["marketing_director"], verticals: ["b2b_saas"], size_bands: ["mid_market"], integrations: ["slack"], compliance_terms: ["soc2"], capabilities: ["pipeline_automation"], competitors: [{ name: "Salesforce" }] };
const ANSWER = "Top picks for a small CRM:\n1. **HubSpot** - the default choice\n2. **Zoho CRM**: cheap and broad\n\nSources: https://g2.com/categories/crm and https://reddit.com/r/crm";

function raw(text = ANSWER): RawCapture {
  return { text, format: "markdown", truncated: false, responseTokensEst: 20, latencyMs: 40, costUsd: 0 };
}
function adapter(engineKey: string, run: (ctx: CaptureContext, prompt: string) => Promise<RawCapture>): CaptureAdapter {
  return { engineKey: engineKey as CaptureAdapter["engineKey"], captureMode: "api", adapterVersion: "1.0.0", supportsCitations: true, concurrencyPerTask: 1, capture: async (request, ctx) => await run(ctx, request.promptText), healthProbe: async () => ({ ok: true, latencyMs: 1 }) };
}
function widenedDocument(): string {
  return JSON.stringify(
    RATE_LIMIT_DEFAULTS.map((entry) =>
      entry.route_class === "capture_backed_tools"
        ? { route_class: "capture_backed_tools", burst: 20, buckets: [{ scope: "user", limit: 50, window: "rolling", window_ms: 60_000 }, { scope: "user", limit: 400, window: "rolling", window_ms: 86_400_000 }, { scope: "workspace", limit: 200, window: "rolling", window_ms: 60_000 }] }
        : entry,
    ),
  );
}
/** A fresh prompt set per test: a live capture seeds the shared L1 cache (by design), so a repeated prompt would be answered from an earlier test. */
const prompts = (n: number): string[] => Array.from({ length: n }, (_, i) => `best crm for a startup, variant ${String(i)} ${uuidV7()}`);

describe("STORY-080 · Prompt Research", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const sharedCache = new InMemoryCacheAdapter();
  const harness = useApiHarness({ cache: () => sharedCache, env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }) });
  let pool: Pool;
  let sessions: SessionService;
  let adapters: Record<string, (ctx: CaptureContext, prompt: string) => Promise<RawCapture>>;
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
    adapters = { perplexity: async () => raw(), chatgpt: async () => raw("1. **HubSpot** - fine\n2. **Pipedrive** - simple") };
    workerDeps = {};
    enqueued = [];
    workers = [];
    capture.ready = ["perplexity", "chatgpt"];
    await harness.app().get<Cache>(CACHE).set(rateLimitConfigKey(cacheKeyNamespace()), widenedDocument(), { ttlMs: 3_600_000 });
    vi.spyOn(UrlGuard.prototype, "validateAndNormalize").mockImplementation(async (url: string) => ({ rootDomain: new URL(url).hostname }));
    vi.spyOn(QueueProducer.prototype, "enqueueTenantJob").mockImplementation(async (name, workspaceId, payload, options) => {
      if (name === "lookup.execute") {
        enqueued.push({ workspaceId, payload, options: options as unknown as Record<string, unknown> });
        workers.push(runWorker(workspaceId, payload));
      }
      return {} as Job;
    });
  });
  afterEach(async () => {
    const settled = await Promise.allSettled(workers);
    vi.restoreAllMocks();
    await pool.end();
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed !== undefined) throw failed.reason as Error;
  });

  function runWorker(workspaceId: string, payload: Record<string, unknown>): Promise<unknown> {
    const context = { pool, env: { VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString } } as unknown as QueueHandlerContext;
    const handler = createLookupExecuteHandler(context, {
      cache: sharedCache,
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

  async function member(workspace: Actor, role: "viewer" | "analyst"): Promise<Actor> {
    const userId = uuidV7();
    await harness.db().query(`INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`, [userId, `${userId}@example.test`]);
    await harness.db().query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1,$2,$3,'active')", [workspace.workspaceId, userId, role]);
    const tokens = await sessions.createSession(userId);
    const version = (await harness.db().query<{ entitlement_version: number }>("SELECT entitlement_version FROM workspaces WHERE id = $1", [workspace.workspaceId])).rows[0]!.entitlement_version;
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspace.workspaceId, role, null, version);
    return { userId, workspaceId: workspace.workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken, plan: workspace.plan };
  }

  const send = (a: Actor, method: "GET" | "POST", path: string, over: { body?: unknown; confirmed?: number | null; key?: string | null } = {}) => {
    const headers: Record<string, string> = { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" };
    if (over.confirmed !== undefined && over.confirmed !== null) headers["x-nominara-confirmed-credits"] = String(over.confirmed);
    if (method === "POST" && over.key !== null) headers["idempotency-key"] = over.key ?? uuidV7();
    return harness.app().inject({ method, url: apiUrl(path), headers, ...(method === "POST" ? { payload: (over.body ?? {}) as object } : {}) });
  };
  const available = async (a: Actor): Promise<number> => {
    const w = (await harness.db().query<{ included_balance: number; purchased_balance: number; reserved: number }>("SELECT included_balance, purchased_balance, reserved FROM credit_wallets WHERE workspace_id = $1", [a.workspaceId])).rows[0];
    return w === undefined ? GRANT[a.plan] : w.included_balance + w.purchased_balance - w.reserved;
  };
  const count = async (sql: string, args: unknown[] = []): Promise<number> => (await harness.db().query<{ n: number }>(sql, args)).rows[0]!.n;
  const settle = async (): Promise<void> => { await Promise.all(workers); };
  const detail = async (a: Actor, id: string) => ((await send(a, "GET", `/tools/runs/${id}`)).json() as { data: Record<string, any> }).data; // eslint-disable-line @typescript-eslint/no-explicit-any
  const FACT_TABLES = ["answer_captures", "mention_facts", "citation_facts", "capture_runs", "metric_daily", "tasks"];

  it("scenarios 1, 3, 14 - Discover returns the candidates, is free, and writes no run, no debit and no fact", async () => {
    const a = await owner("starter");
    const before = await available(a);
    const res = await send(a, "POST", "/tools/prompt-research/discover", { body: { brand_name: "Acme CRM", context: RICH } });
    expect(res.statusCode, res.body).toBe(200);
    const out = (res.json() as { data: { generated: number; requested: number; credits_charged: number; candidates: unknown[]; keep: { credits_per_prompt: number } } }).data;
    expect(out).toMatchObject({ requested: 15, generated: 15, credits_charged: 0, keep: { credits_per_prompt: 1 } });
    expect(out.candidates).toHaveLength(15);
    expect(await available(a)).toBe(before);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1", [a.workspaceId])).toBe(0);
    for (const table of FACT_TABLES) expect(await count(`SELECT count(*)::int AS n FROM ${table}`), table).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it("DECISION 67a - Free plan: Keep costs 1 credit per kept prompt from the included credits; Discover and the keep estimate publish the price", async () => {
    const a = await owner("free");
    const before = await available(a);
    const res = await send(a, "POST", "/tools/prompt-research/discover", { body: { brand_name: "Acme CRM", context: RICH } });
    expect(res.statusCode, res.body).toBe(200);
    const out = (res.json() as { data: { generated: number; credits_charged: number; keep: Record<string, unknown> } }).data;
    expect(out.generated).toBeGreaterThan(0);
    expect(out).toMatchObject({ credits_charged: 0, keep: { credits_per_prompt: 1, unavailable_reason: null, max_per_save: 15 } });
    const estimate = await send(a, "GET", "/tools/prompt-research/estimate?mode=keep&prompt_count=3");
    expect(estimate.statusCode, estimate.body).toBe(200);
    expect(estimate.json()).toMatchObject({ data: { total_credits: 3, credits_per_unit: 1 } });
    const keep = await send(a, "POST", "/tools/prompt-research/keep", { body: { prompts: prompts(2) }, confirmed: 2 });
    expect(keep.statusCode, keep.body).toBe(200);
    expect(keep.json()).toMatchObject({ data: { kept_count: 2, credits_charged: 2 } });
    expect(await available(a)).toBe(before - 2);
  });

  it("DECISION 67f - a keep of 15 is stored (ck_tr_shape allows 15), a keep of 16 is a 400 and the database refuses a 16th prompt even past the service", async () => {
    const a = await owner("starter");
    const before = await available(a);
    const fifteen = await send(a, "POST", "/tools/prompt-research/keep", { body: { prompts: prompts(15) }, confirmed: 15 });
    expect(fifteen.statusCode, fifteen.body).toBe(200);
    expect(fifteen.json()).toMatchObject({ data: { kept_count: 15, credits_charged: 15 } });
    expect(await available(a)).toBe(before - 15);
    const sixteen = await send(a, "POST", "/tools/prompt-research/keep", { body: { prompts: prompts(16) }, confirmed: 16 });
    expect(sixteen.statusCode).toBe(400);
    expect(sixteen.body).toMatch(/15 prompts/u);
    const client = await pool.connect();
    try {
      const insert = (tx: { query: (sql: string, values: unknown[]) => Promise<unknown> }, n: number) =>
        tx.query(`INSERT INTO tool_runs (id, workspace_id, created_by, tool_key, prompt_texts, input_hash, engine_keys, credits_charged, status, expires_at) VALUES ($3::uuid, $1, $4, 'prompt_research', $2::text[], decode(md5($3::uuid::text), 'hex'), '{}', 0, 'running', now() + interval '1 day')`, [a.workspaceId, prompts(n), uuidV7(), SYSTEM_ACTOR_ID]);
      await expect(withTenantContext(client, { workspaceId: a.workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => insert(tx, 16))).rejects.toMatchObject({ code: "23514", constraint: "ck_tr_shape" });
      await expect(withTenantContext(client, { workspaceId: a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => { await insert(tx, 15); throw new Error("rollback"); })).rejects.toThrow("rollback");
    } finally {
      client.release();
    }
  });

  it("a viewer is refused 403 naming the permission on Discover (prompt:write), Keep (prompt:write) and Run (lookup:execute); nothing is charged or started", async () => {
    const a = await owner("starter");
    const viewer = await member(a, "viewer");
    const before = await available(a);
    for (const [path, body, confirmed, permission] of [
      ["/tools/prompt-research/discover", { brand_name: "Acme" }, null, "prompt:write"],
      ["/tools/prompt-research/keep", { prompts: prompts(1) }, 1, "prompt:write"],
      ["/tools/prompt-research/run", { prompt_texts: prompts(1) }, 10, "lookup:execute"],
    ] as const) {
      const res = await send(viewer, "POST", path, { body, confirmed });
      expect(res.statusCode, `${path} ${res.body}`).toBe(403);
      expect(res.body).toContain(permission);
    }
    expect(await available(a)).toBe(before);
    expect(enqueued).toHaveLength(0);
  });

  it("a repeated prompt is a 400 on keep and on run (ignoring case); nothing is charged", async () => {
    const a = await owner("starter");
    const before = await available(a);
    expect((await send(a, "POST", "/tools/prompt-research/keep", { body: { prompts: ["same prompt", "SAME prompt"] }, confirmed: 2 })).statusCode).toBe(400);
    expect((await send(a, "POST", "/tools/prompt-research/run", { body: { prompt_texts: ["same prompt", "same prompt "] }, confirmed: 20 })).statusCode).toBe(400);
    expect(await available(a)).toBe(before);
  });

  it("Discover is permission-gated: an unknown body key is a 400, and an empty body is a 400", async () => {
    const a = await owner("starter");
    expect((await send(a, "POST", "/tools/prompt-research/discover", { body: { brand_name: "Acme", engines: ["chatgpt"] } })).statusCode).toBe(400);
    expect((await send(a, "POST", "/tools/prompt-research/discover", { body: {} })).statusCode).toBe(400);
  });

  it("scenarios 4, 5 - Keep charges per prompt kept at the in-project rate; the run records the kept count and the ledger entry names it", async () => {
    const a = await owner("starter");
    const before = await available(a);
    const kept = prompts(3);
    const res = await send(a, "POST", "/tools/prompt-research/keep", { body: { prompts: kept, topic: "crm" }, confirmed: 3 });
    expect(res.statusCode, res.body).toBe(200);
    const out = (res.json() as { data: { tool_run_id: string } }).data;
    expect(out).toMatchObject({ kept_count: 3, credits_per_prompt: 1, credits_charged: 3 });
    expect(await available(a)).toBe(before - 3);
    const run = (await harness.db().query("SELECT status, items_kept, credits_charged, prompt_texts FROM tool_runs WHERE id = $1", [out.tool_run_id])).rows[0] as { status: string; items_kept: number; credits_charged: number; prompt_texts: string[] };
    expect(run).toMatchObject({ status: "completed", items_kept: 3, credits_charged: 3, prompt_texts: kept });
    const entry = (await harness.db().query("SELECT unit_detail, credits FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 AND entry_type = 'commit'", [a.workspaceId, out.tool_run_id])).rows[0] as { unit_detail: { prompts: number }; credits: number };
    expect(entry.unit_detail.prompts).toBe(3);
    expect(entry.credits).toBe(3);
    // The same Idempotency-Key replays: nothing more is charged.
    const key = uuidV7();
    const twoMore = { prompts: prompts(2) };
    await send(a, "POST", "/tools/prompt-research/keep", { body: twoMore, confirmed: 2, key });
    const afterFirst = await available(a);
    const again = await send(a, "POST", "/tools/prompt-research/keep", { body: twoMore, confirmed: 2, key });
    expect(again.statusCode).toBe(200);
    expect(await available(a)).toBe(afterFirst);
  });

  it("Keep needs the confirmed figure (400 absent, 409 price_changed on a mismatch, with both figures), and writes nothing when refused", async () => {
    const a = await owner("starter");
    const before = await available(a);
    expect((await send(a, "POST", "/tools/prompt-research/keep", { body: { prompts: prompts(2) } })).statusCode).toBe(400);
    const wrong = await send(a, "POST", "/tools/prompt-research/keep", { body: { prompts: prompts(2) }, confirmed: 1 });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ error: { code: "price_changed", details: { shown: 1, recomputed: 2 } } });
    expect(await available(a)).toBe(before);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(0);
  });

  it("scenario 15 - converting a kept set carries the prompts into a project and charges nothing a second time", async () => {
    const a = await owner("growth");
    const kept = prompts(3);
    const res = await send(a, "POST", "/tools/prompt-research/keep", { body: { prompts: kept, brand_name: "Acme" }, confirmed: 3 });
    const id = (res.json() as { data: { tool_run_id: string } }).data.tool_run_id;
    const afterKeep = await available(a);
    const ledgerBefore = await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1", [a.workspaceId]);
    const converted = await send(a, "POST", `/tools/runs/${id}/convert`, { body: { root_url: "https://acme.test" } });
    expect(converted.statusCode, converted.body).toBe(200);
    expect((converted.json() as { data: { slot_cost: { credits: number; prompt_slots: { carried: number } } } }).data.slot_cost).toMatchObject({ credits: 0, prompt_slots: { carried: 3 } });
    expect(await available(a)).toBe(afterKeep);
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1", [a.workspaceId])).toBe(ledgerBefore);
  });

  it("scenario 7 - the estimate recomputes for each selection size, names the engines, and flags the eleventh prompt", async () => {
    const a = await owner("starter");
    const totals: number[] = [];
    for (const n of [1, 2, 3, 4]) {
      const e = ((await send(a, "GET", `/tools/prompt-research/estimate?mode=run&prompt_count=${String(n)}`)).json() as { data: { total_credits: number; engines: { engine_key: string }[]; units: number } }).data;
      expect(e.engines.map((x) => x.engine_key)).toEqual(["perplexity", "chatgpt"]);
      expect(e.units).toBe(n * 2);
      expect(e.total_credits).toBe(n * 2 * 5);
      totals.push(e.total_credits);
    }
    expect(totals).toEqual([10, 20, 30, 40]);
    const eleven = ((await send(a, "GET", "/tools/prompt-research/estimate?mode=run&prompt_count=11")).json() as { data: { within_cap: boolean } }).data;
    expect(eleven.within_cap).toBe(false);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs")).toBe(0);
    expect((await send(a, "GET", "/tools/prompt-research/estimate?mode=run&prompt_count=3&engines=chatgpt")).statusCode).toBe(400);
  });

  it("scenario 6 - a run above the per-run cap is refused with the limit named, and nothing is charged or started", async () => {
    const a = await owner("starter");
    const before = await available(a);
    const res = await send(a, "POST", "/tools/prompt-research/run", { body: { prompt_texts: prompts(11) }, confirmed: 110 });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toMatch(/10 prompts/u);
    expect((await send(a, "POST", "/tools/prompt-research/run", { body: { prompt_texts: [] }, confirmed: 0 })).statusCode).toBe(400);
    expect(await available(a)).toBe(before);
    expect(enqueued).toHaveLength(0);
  });

  it("Run requires the restated total: 400 absent, 409 price_changed (both figures) on a stale one, and no Idempotency-Key is a 400; nothing is written", async () => {
    const a = await owner("starter");
    const before = await available(a);
    const chosen = prompts(3);
    expect((await send(a, "POST", "/tools/prompt-research/run", { body: { prompt_texts: chosen } })).statusCode).toBe(400);
    const stale = await send(a, "POST", "/tools/prompt-research/run", { body: { prompt_texts: chosen }, confirmed: 20 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "price_changed", details: { shown: 20, recomputed: 30 } } });
    expect((await send(a, "POST", "/tools/prompt-research/run", { body: { prompt_texts: chosen }, confirmed: 30, key: null })).statusCode).toBe(400);
    expect((await send(a, "POST", "/tools/prompt-research/run", { body: { prompt_texts: chosen, brand_name: "Acme" }, confirmed: 30 })).statusCode).toBe(400);
    expect(await available(a)).toBe(before);
    expect(enqueued).toHaveLength(0);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(0);
  });

  it("scenarios 8, 9, 10, 11, 14 - a run returns entities ranked by share of answer with the feeding domains and a collapsed also-mentioned group; no brand anywhere; no fact rows", async () => {
    const a = await owner("starter");
    const chosen = prompts(3);
    const before = await available(a);
    const res = await send(a, "POST", "/tools/prompt-research/run", { body: { prompt_texts: chosen }, confirmed: 30 });
    expect(res.statusCode, res.body).toBe(202);
    const accepted = (res.json() as { data: { tool_run_id: string; answers: number; engines: string[] } }).data;
    expect(accepted).toMatchObject({ answers: 6, engines: ["perplexity", "chatgpt"] });
    await settle();
    expect(await available(a)).toBe(before - 30);
    const run = await detail(a, accepted.tool_run_id);
    expect(run.status).toBe("completed");
    expect(run.credits_charged).toBe(30);
    // 3 prompts x perplexity = HubSpot, Zoho CRM in each; 3 x chatgpt = HubSpot, Pipedrive in each. HubSpot is named in 6 answers, Zoho CRM and Pipedrive in 3.
    expect(run.result.entities.map((e: { name: string; answers_named: number }) => [e.name, e.answers_named])).toEqual([["HubSpot", 6], ["Pipedrive", 3], ["Zoho CRM", 3]]);
    expect(run.result.entities[0].share_of_answer).toBeCloseTo(6 / 12, 6);
    expect(run.result.also_mentioned).toEqual([]);
    expect(run.result.domains.map((d: { domain: string }) => d.domain)).toEqual(expect.arrayContaining(["g2.com", "reddit.com"]));
    expect(JSON.stringify(run.result)).not.toMatch(/brand|owned|competitor/iu);
    expect(run.headline).toMatchObject({ entities_found: 3, brand_present: null, sov_estimate: null, items_kept: null });
    expect(run.presentation).toMatchObject({ not_tracked: true, did_not_check: expect.any(String), estimated_fields: ["entities_found"] });
    for (const table of FACT_TABLES) expect(await count(`SELECT count(*)::int AS n FROM ${table}`), table).toBe(0);
  });

  it("scenario 11 - an entity named in fewer than 3 answers is in the collapsed group, not the ranked table", async () => {
    const a = await owner("starter");
    adapters = { perplexity: async (_c, p) => raw(p.includes("variant 0") ? "1. **HubSpot** - a\n2. **Rare Tool** - b" : "1. **HubSpot** - a"), chatgpt: async () => raw("1. **HubSpot** - a") };
    const res = await send(a, "POST", "/tools/prompt-research/run", { body: { prompt_texts: prompts(3) }, confirmed: 30 });
    await settle();
    const run = await detail(a, (res.json() as { data: { tool_run_id: string } }).data.tool_run_id);
    expect(run.result.entities.map((e: { name: string }) => e.name)).toEqual(["HubSpot"]);
    expect(run.result.also_mentioned).toEqual([{ name: "Rare Tool", answers_named: 1 }]);
  });

  it("scenario 12 - every engine failing refunds the run in full, with one refund entry", async () => {
    const a = await owner("starter");
    adapters = {};
    const before = await available(a);
    const res = await send(a, "POST", "/tools/prompt-research/run", { body: { prompt_texts: prompts(2) }, confirmed: 20 });
    expect(res.statusCode, res.body).toBe(202);
    const id = (res.json() as { data: { tool_run_id: string } }).data.tool_run_id;
    await settle();
    const run = await detail(a, id);
    expect(run).toMatchObject({ status: "failed", credits_charged: 0 });
    expect(run.engines_failed).toEqual(["perplexity", "chatgpt"]);
    expect(run.headline.entities_found).toBeNull();
    expect(await available(a)).toBe(before);
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 AND entry_type = 'refund' AND credits = 20", [a.workspaceId, id])).toBe(1);
  });

  it("scenario 13 - one engine failing is a partial: charged in full, the failure named", async () => {
    const a = await owner("starter");
    adapters = { perplexity: async () => raw(), chatgpt: async () => { throw new CaptureFailureError("timeout", "chatgpt" as never); } };
    const before = await available(a);
    const res = await send(a, "POST", "/tools/prompt-research/run", { body: { prompt_texts: prompts(2) }, confirmed: 20 });
    const id = (res.json() as { data: { tool_run_id: string } }).data.tool_run_id;
    await settle();
    const run = await detail(a, id);
    expect(run).toMatchObject({ status: "partial", credits_charged: 20, engines_succeeded: ["perplexity"], engines_failed: ["chatgpt"] });
    expect(run.result.engine_failures).toEqual([expect.objectContaining({ engine: "chatgpt", code: "timeout" }), expect.objectContaining({ engine: "chatgpt", code: "timeout" })]);
    expect(await available(a)).toBe(before - 20);
  });

  it("DECISION 67g - every engine answered something but one cell failed: the run is partial, charged in full, no engine named failed", async () => {
    const a = await owner("starter");
    adapters = { perplexity: async () => raw(), chatgpt: async (_c, p) => { if (p.includes("variant 0")) throw new CaptureFailureError("timeout", "chatgpt" as never); return raw(); } };
    const before = await available(a);
    const res = await send(a, "POST", "/tools/prompt-research/run", { body: { prompt_texts: prompts(2) }, confirmed: 20 });
    const id = (res.json() as { data: { tool_run_id: string } }).data.tool_run_id;
    await settle();
    const run = await detail(a, id);
    expect(run).toMatchObject({ status: "partial", credits_charged: 20, engines_succeeded: ["perplexity", "chatgpt"], engines_failed: [] });
    expect(run.result.answers).toMatchObject({ asked: 4, answered: 3, failed: 1 });
    expect(await available(a)).toBe(before - 20);
  });

  it("a run with no engine able to capture is refused before anything is charged", async () => {
    const a = await owner("starter");
    capture.ready = [];
    const before = await available(a);
    const res = await send(a, "POST", "/tools/prompt-research/run", { body: { prompt_texts: prompts(1) }, confirmed: 0 });
    expect(res.statusCode, res.body).toBe(422);
    expect(await available(a)).toBe(before);
  });

  it("the same Idempotency-Key replays the accepted run: one run, one charge, one job", async () => {
    const a = await owner("starter");
    const key = uuidV7();
    const body = { prompt_texts: prompts(1) };
    const before = await available(a);
    const first = await send(a, "POST", "/tools/prompt-research/run", { body, confirmed: 10, key });
    const again = await send(a, "POST", "/tools/prompt-research/run", { body, confirmed: 10, key });
    await settle();
    expect(first.statusCode).toBe(202);
    expect(again.statusCode).toBe(202);
    expect(again.body).toBe(first.body);
    expect(enqueued).toHaveLength(1);
    expect(await available(a)).toBe(before - 10);
  });
});
