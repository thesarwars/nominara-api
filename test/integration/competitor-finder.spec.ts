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
import type { CaptureAdapter, CaptureContext, RawCapture } from "../../src/lib/engines/contract.js";
import type { GuardedResponse } from "../../src/lib/net/guarded-fetch.js";
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
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-081 - the Competitor Finder through the REAL ApiModule: the route, the guards, the ledger, the stream, and the worker handler.
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


const ANSWER = "For freelancer invoicing these come up most:\n\n1. **Billwise** — invoices ([billwise.example](https://billwise.example)).\n2. **LedgerLark**: bookkeeping.\n\nSalesforce is also widely used in this market.";
const PAGE = `<html><head><title>Acme Invoicing | Invoices</title><meta name="description" content="Acme Invoicing sends invoices and chases late payments for freelancers."></head></html>`;
const HOST = "https://acme-invoicing.example/";

function raw(text = ANSWER, costUsd = 0): RawCapture {
  return { text, format: "markdown", truncated: false, responseTokensEst: 20, latencyMs: 40, costUsd };
}
function adapter(engineKey: string, capture: (ctx: CaptureContext) => Promise<RawCapture>): CaptureAdapter {
  return { engineKey: engineKey as CaptureAdapter["engineKey"], captureMode: "api", adapterVersion: "1.0.0", supportsCitations: true, concurrencyPerTask: 1, capture: async (_request, ctx) => await capture(ctx), healthProbe: async () => ({ ok: true, latencyMs: 1 }) };
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

describe("STORY-081 · Competitor Finder", () => {
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
  let pages: (url: string) => Promise<GuardedResponse>;
  let workerDeps: Partial<LookupExecuteDeps>;
  let enqueued: { workspaceId: string; payload: Record<string, unknown>; options: Record<string, unknown> }[];
  let workers: Promise<unknown>[];
  // Which delivery of the job the worker is on (BullMQ's attemptsMade): 2 of 3 is the last attempt, where a failure must settle and refund the run.
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
    adapters = { perplexity: async () => raw() };
    pages = async (url) => (url.endsWith("/robots.txt") ? { status: 404, headers: {}, body: Buffer.from(""), finalUrl: url } : { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(PAGE), finalUrl: url });
    workerDeps = {};
    enqueued = [];
    workers = [];
    attemptsMade = 0;
    viaProcessor = false;
    // The production class lets one user spend 2 scans at once (5/min). Most scenarios here make more calls than that per user, so they run on the widest
    // document the envelope allows (x10). That the route IS in the class is asserted on the handler (src/modules/tools/tools.spec.ts): the guard reads its
    // document through a 15 s memo, so a scenario that swaps documents mid-spec would have to sit out the memo.
    await harness.app().get<Cache>(CACHE).set(rateLimitConfigKey(cacheKeyNamespace()), widenedDocument(), { ttlMs: 3_600_000 });
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
      competitorFinder: { fetchPage: async (url) => await pages(url) },
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
    if (over.confirmed !== null) headers["x-nominara-confirmed-credits"] = String(over.confirmed ?? 1);
    if (over.key !== null) headers["idempotency-key"] = over.key ?? uuidV7();
    return harness.app().inject({ method: "POST", url: apiUrl("/tools/competitor-finder"), headers, payload: (over.body ?? { url: HOST }) as object });
  };
  const get = (a: Actor, path: string) => harness.app().inject({ method: "GET", url: apiUrl(path), headers: { cookie: a.cookie } });
  const available = async (actor: Actor): Promise<number> => {
    const w = (await harness.db().query<{ included_balance: number; purchased_balance: number; reserved: number }>("SELECT included_balance, purchased_balance, reserved FROM credit_wallets WHERE workspace_id = $1", [actor.workspaceId])).rows[0];
    return w === undefined ? GRANT[actor.plan] : w.included_balance + w.purchased_balance - w.reserved;
  };
  const count = async (sql: string, args: unknown[] = []): Promise<number> => (await harness.db().query<{ n: number }>(sql, args)).rows[0]!.n;
  const detail = async (a: Actor, id: string) => (await get(a, `/tools/runs/${id}`)).json() as { data: { status: string; credits_charged: number; error_code: string | null; result: { entities: { name: string; excerpt: string; cited_domain: string | null; source_status: string }[]; scope: Record<string, string>; competitors: string[] } | null; headline: { entities_found: number | null }; presentation: { not_tracked: boolean; did_not_check: string }; conversion: { prefill: { competitors: string[] } } } };
  const runId = (): string => enqueued[0]!.payload["toolRunId"] as string;
  const settle = async (): Promise<void> => {
    await Promise.all(workers);
  };

  it("scenario 1 - a run answers 202 with the run and the plan's engine, charges 1 credit, and enqueues exactly one job", async () => {
    const a = await owner("starter");
    const before = await available(a);
    const res = await post(a);
    expect(res.statusCode, res.body).toBe(202);
    expect((res.json() as { data: Record<string, unknown> }).data).toMatchObject({ status: "running", credits_charged: 1, engine: { engine_key: "perplexity" } });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.payload).toMatchObject({ tool: "competitor_finder", engine: "perplexity", targetUrl: HOST });
    await settle();
    expect(await available(a)).toBe(before - 1);
    expect((await detail(a, runId())).data.status).toBe("completed");
  });

  it("scenario 1 - the confirmed figure is required (400) and a wrong figure is price_changed (409); nothing is charged or queued", async () => {
    const a = await owner("starter");
    const before = await available(a);
    expect((await post(a, { confirmed: null })).statusCode).toBe(400);
    const wrong = await post(a, { confirmed: 2 });
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(wrong.json()).toMatchObject({ error: { code: "price_changed", details: { shown: 2, recomputed: 1 } } });
    expect((await post(a, { body: { url: HOST, engine: "chatgpt" } })).statusCode).toBe(400);
    expect(await available(a)).toBe(before);
    expect(enqueued).toHaveLength(0);
  });

  it("scenario 2 - an internal address is refused by the existing forgery guard (422 unsafe_target) before anything is charged or queued", async () => {
    const a = await owner("starter");
    vi.mocked(UrlGuard.prototype.validateAndNormalize).mockRestore();
    const before = await available(a);
    const res = await post(a, { body: { url: "http://127.0.0.1/admin" } });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "unsafe_target" } });
    expect(await available(a)).toBe(before);
    expect(enqueued).toHaveLength(0);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(0);
  });

  it("scenario 4, 5, 7 - the stored result: rows from spans with excerpts, the unspanned prose name absent, the scope stated, not-tracked marker and did-not-check line", async () => {
    const a = await owner("starter");
    await post(a);
    await settle();
    const d = (await detail(a, runId())).data;
    expect(d.result!.entities.map((e) => e.name)).toEqual(["Billwise", "LedgerLark"]);
    expect(d.result!.entities.every((e) => e.excerpt.includes(e.name))).toBe(true);
    // Decision 67(b): the label always agrees with the domain, whichever way this fixture's citations fall.
    expect(d.result!.entities.every((e) => e.source_status === (e.cited_domain === null ? "no_source_cited" : "cited"))).toBe(true);
    expect(JSON.stringify(d.result)).not.toContain("Salesforce");
    expect(d.result!.scope).toMatchObject({ engine: "perplexity" });
    expect(d.result!.scope["statement"]!.toLowerCase()).toContain("one engine, one query, one moment");
    expect(Date.parse(d.result!.scope["captured_at"]!)).not.toBeNaN();
    expect(d.presentation).toMatchObject({ not_tracked: true });
    expect(d.presentation.did_not_check.length).toBeGreaterThan(0);
    expect(d.headline.entities_found).toBe(2);
  });

  it("scenario 8 - the workspace competitor list is unchanged after a run", async () => {
    const a = await owner("starter");
    await post(a);
    await settle();
    expect(await count("SELECT count(*)::int AS n FROM competitors WHERE workspace_id = $1", [a.workspaceId])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1", [a.workspaceId])).toBe(0);
  });

  it("scenario 9 - a capture that names nothing is an empty result, refunded in full", async () => {
    const a = await owner("starter");
    adapters = { perplexity: async () => raw("I could not name specific companies for this category.") };
    const before = await available(a);
    await post(a);
    await settle();
    const d = (await detail(a, runId())).data;
    expect(d.status).toBe("failed");
    expect(d.error_code).toBe("no_entities_named");
    expect(d.result!.entities).toEqual([]);
    expect(d.credits_charged).toBe(0);
    expect(await available(a)).toBe(before);
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 AND entry_type = 'refund' AND credits = 1", [a.workspaceId, runId()])).toBe(1);
  });

  it("scenario 9 - a page that cannot be fetched fails the run with the named reason and refunds it in full", async () => {
    const a = await owner("starter");
    pages = async (url) => ({ status: url.endsWith("/robots.txt") ? 404 : 503, headers: {}, body: Buffer.from(""), finalUrl: url });
    const before = await available(a);
    await post(a);
    await settle();
    const d = (await detail(a, runId())).data;
    expect(d.status).toBe("failed");
    expect(d.error_code).toBe("page_unreachable");
    expect(await available(a)).toBe(before);
  });

  it("scenario 10 - an engine failure after the page was read settles failed, is named, and the charge comes back exactly once (a single capture has no partial)", async () => {
    const a = await owner("starter");
    adapters = { perplexity: async () => { throw new CaptureFailureError("timeout", "perplexity" as never); } };
    const before = await available(a);
    await post(a);
    await settle();
    const d = (await detail(a, runId())).data;
    expect(d.status).toBe("failed");
    expect(d.error_code).toBe("timeout");
    expect(d.credits_charged).toBe(0);
    expect(await available(a)).toBe(before);
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 AND entry_type = 'refund'", [a.workspaceId, runId()])).toBe(1);
  });

  it("at-least-once - the same job delivered again after it settled captures nothing, refunds nothing more and writes no second cost row (completed run)", async () => {
    const a = await owner("starter");
    let calls = 0;
    adapters = { perplexity: async (ctx) => { calls += 1; ctx.recordCost(0.02); return raw(); } };
    const before = await available(a);
    await post(a);
    await settle();
    await runWorker(a.workspaceId, enqueued[0]!.payload);
    expect(calls).toBe(1);
    expect((await detail(a, runId())).data.status).toBe("completed");
    expect(await available(a)).toBe(before - 1);
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 AND entry_type = 'refund'", [a.workspaceId, runId()])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM usage_ledger WHERE workspace_id = $1 AND reference_type = 'tool_run' AND reference_id = $2", [a.workspaceId, runId()])).toBe(1);
  });

  it("at-least-once - a redelivery after a refunded run (nothing named) refunds once, not twice", async () => {
    const a = await owner("starter");
    let calls = 0;
    adapters = { perplexity: async (ctx) => { calls += 1; ctx.recordCost(0.02); return raw("I could not name specific companies."); } };
    const before = await available(a);
    await post(a);
    await settle();
    await runWorker(a.workspaceId, enqueued[0]!.payload);
    expect(calls).toBe(1);
    expect(await available(a)).toBe(before);
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 AND entry_type = 'refund'", [a.workspaceId, runId()])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM usage_ledger WHERE workspace_id = $1 AND reference_type = 'tool_run' AND reference_id = $2", [a.workspaceId, runId()])).toBe(1);
  });

  it("final attempt - an unexpected (non-engine) error on the last delivery settles the run failed as finder_job_failed and returns the charge exactly once", async () => {
    const a = await owner("starter");
    attemptsMade = 2;
    viaProcessor = true;
    adapters = { perplexity: async () => { throw new Error("boom"); } };
    const before = await available(a);
    await post(a);
    await settle();
    const d = (await detail(a, runId())).data;
    expect(d.status).toBe("failed");
    expect(d.error_code).toBe("finder_job_failed");
    expect(d.credits_charged).toBe(0);
    expect(await available(a)).toBe(before);
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 AND entry_type = 'refund'", [a.workspaceId, runId()])).toBe(1);
  });

  it("an unexpected error on an EARLIER delivery is retried, not settled: the run stays running and charged", async () => {
    const a = await owner("starter");
    attemptsMade = 0;
    viaProcessor = true;
    adapters = { perplexity: async () => { throw new Error("boom"); } };
    const before = await available(a);
    await post(a);
    await Promise.allSettled(workers);
    workers = [];
    expect((await detail(a, runId())).data.status).toBe("running");
    expect(await available(a)).toBe(before - 1);
  });

  it("a site that cannot be reached at all (robots.txt transport error) is page_unreachable, not a robots refusal; a robots 5xx is still robots_disallowed", async () => {
    const a = await owner("starter");
    pages = async (url) => { throw new Error(`ECONNREFUSED ${url}`); };
    await post(a);
    await settle();
    expect((await detail(a, runId())).data.error_code).toBe("page_unreachable");
    const b = await owner("starter");
    enqueued = [];
    pages = async (url) => ({ status: url.endsWith("/robots.txt") ? 503 : 200, headers: { "content-type": "text/html" }, body: Buffer.from(PAGE), finalUrl: url });
    await post(b);
    await settle();
    expect((await detail(b, runId())).data.error_code).toBe("robots_disallowed");
  });

  it("observability - the run increments nominara_tools_competitor_finder_runs_total and the finished log line carries the workspace ID and run ID, no answer text, query or URL", async () => {
    const a = await owner("starter");
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
      lines.push(message);
    });
    await post(a);
    await settle();
    const metric = lines.find((l) => (l as { metric?: string }).metric === "nominara_tools_competitor_finder_runs_total");
    expect(metric).toMatchObject({ value: 1, outcome: "named" });
    const finished = lines.find((l) => (l as { event?: string }).event === "tools.competitor_finder.finished") as Record<string, unknown>;
    expect(finished).toMatchObject({ workspace_id: a.workspaceId, run_id: runId(), entities: 2 });
    const text = JSON.stringify(finished);
    for (const forbidden of ["Billwise", "LedgerLark", "acme-invoicing", "Acme"]) expect(text).not.toContain(forbidden);
  });

  it("scenario 11 - after a run the fact tables and capture tables hold zero rows for the workspace", async () => {
    const a = await owner("starter");
    await post(a);
    await settle();
    for (const table of ["mention_facts", "citation_facts", "answer_captures", "capture_runs"]) {
      expect(await count(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`, [a.workspaceId]), table).toBe(0);
    }
  });

  it("scenario 12 - conversion pre-fills the detected entities as candidate competitors through the shared contract", async () => {
    const a = await owner("starter");
    await post(a);
    await settle();
    const preview = await get(a, `/tools/runs/${runId()}/convert`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect((preview.json() as { data: { prefill: { competitors: string[]; root_url: string | null } } }).data.prefill).toMatchObject({ competitors: ["Billwise", "LedgerLark"], root_url: HOST });
  });

  it("an Idempotency-Key replay returns the first answer and charges nothing more", async () => {
    const a = await owner("starter");
    const key = uuidV7();
    const first = await post(a, { key });
    const second = await post(a, { key });
    expect(second.statusCode).toBe(202);
    expect((second.json() as { data: { tool_run_id: string } }).data.tool_run_id).toBe((first.json() as { data: { tool_run_id: string } }).data.tool_run_id);
    await settle();
    expect(enqueued).toHaveLength(1);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(1);
  });

  it("a workspace whose plan has no capturable Tools engine is refused with nothing charged", async () => {
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
});
