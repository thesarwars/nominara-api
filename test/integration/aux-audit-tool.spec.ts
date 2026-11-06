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
import type { GuardedResponse } from "../../src/lib/net/guarded-fetch.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { UrlGuard } from "../../src/lib/net/url-guard.service.js";
import { createLookupExecuteHandler } from "../../src/lib/queue/handlers/lookup-execute.handler.js";
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

import type { Renderer } from "../../src/lib/aux/renderer.js";
import type { ToolAuditDeps } from "../../src/lib/tools/aux-audit-run.js";

// STORY-082 - the AUX audit tool through the REAL ApiModule: the route, the guards, the ledger, the cache and the worker handler.
// Scenario numbers are the story's Test scenarios table. The queue is the one seam replaced: `enqueueTenantJob` is captured and the worker handler
// is run in-process against a fake site, so no network is touched.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;
interface Actor { readonly workspaceId: string; readonly userId: string; readonly cookie: string; readonly csrf: string; readonly plan: "free" | "starter" | "growth" | "business" }
// The included grant of each tier (plan-entitlements.ts): a wallet is provisioned by its first debit, so before one the balance is the grant.
const GRANT = { free: 60, starter: 450, growth: 1200, business: 3000 } as const;



const ORIGIN = "https://acme.example";
const URL_ = `${ORIGIN}/`;
const BROKEN_JSONLD = `<html><head><title>Acme</title><script type="application/ld+json">{ "@context": "https://schema.org", "@type": </script></head><body><main><h1>Acme</h1><p>Acme makes widgets for teams.</p></main></body></html>`;
const GOOD = `<html><head><title>Acme widgets</title></head><body><main><h1>Acme widgets</h1><p>Acme makes widgets for teams.</p></main></body></html>`;
const ROBOTS = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nSitemap: https://acme.example/sitemap.xml\n";
const SITEMAP = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${ORIGIN}/a</loc></url><url><loc>${ORIGIN}/b</loc></url></urlset>`;
const reply = (status: number, body: string): GuardedResponse => ({ status, headers: { "content-type": "text/html" }, body: Buffer.from(body), finalUrl: ORIGIN });

// The production class lets one user start 10 audits an hour; the scenarios here start more than that, so they run on a widened document. That the route IS in
// the class is asserted on the handler (src/modules/tools/tools.spec.ts). x10 is the widest document the rate-limit envelope allows.
function widenedDocument(): string {
  return JSON.stringify(
    RATE_LIMIT_DEFAULTS.map((entry) =>
      entry.route_class === "project_aux_audits" ? { route_class: "project_aux_audits", burst: 30, buckets: [{ scope: "user", limit: 100, window: "rolling", window_ms: 3_600_000 }, { scope: "workspace", limit: 600, window: "rolling", window_ms: 3_600_000 }] } : entry,
    ),
  );
}

describe("STORY-082 - the AUX audit tool", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const sharedCache = new InMemoryCacheAdapter();
  const harness = useApiHarness({ cache: () => sharedCache, env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }) });
  let pool: Pool;
  let sessions: SessionService;
  let site: Record<string, GuardedResponse | "throw">;
  let fetched: string[];
  let auditDeps: ToolAuditDeps;
  let enqueued: { workspaceId: string; payload: Record<string, unknown> }[];
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
    site = { "/robots.txt": reply(200, ROBOTS), "/llms.txt": reply(404, ""), "/.well-known/llms.txt": reply(404, ""), "/sitemap.xml": reply(200, SITEMAP), "/": reply(200, BROKEN_JSONLD), "/a": reply(200, GOOD), "/b": reply(200, GOOD) };
    fetched = [];
    let clock = 0;
    const renderer: Renderer = { render: async (url) => ({ html: GOOD, finalUrl: url, status: 200 }) };
    auditDeps = {
      fetch: async (url) => {
        fetched.push(new URL(url).pathname);
        const hit = site[new URL(url).pathname] ?? reply(404, "");
        if (hit === "throw") throw new Error("connect ECONNREFUSED 10.0.0.5:443");
        return hit;
      },
      renderer,
      nowMs: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    };
    enqueued = [];
    workers = [];
    attemptsMade = 0;
    viaProcessor = false;
    sharedCache.clear();
    await harness.app().get<Cache>(CACHE).set(rateLimitConfigKey(cacheKeyNamespace()), widenedDocument(), { ttlMs: 3_600_000 });
    vi.spyOn(UrlGuard.prototype, "validateAndNormalize").mockImplementation(async (url: string) => ({ rootDomain: new URL(url).hostname }));
    vi.spyOn(QueueProducer.prototype, "enqueueTenantJob").mockImplementation(async (name, workspaceId, payload) => {
      enqueued.push({ workspaceId, payload });
      if (name === "lookup.execute") workers.push(runWorker(workspaceId, payload));
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
    const handler = createLookupExecuteHandler(context, { cache: sharedCache, auxAudit: { audit: auditDeps } });
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

  async function verifyDomain(a: Actor, domain: string): Promise<void> {
    const id = uuidV7();
    await harness.db().query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, status, cadence) VALUES ($1,$2,'P',$3,$4,$5,'active','weekly')`, [id, a.workspaceId, `p-${id.slice(0, 8)}`, `https://${domain}`, domain]);
    await harness.db().query(`INSERT INTO domain_verifications (workspace_id, project_id, domain, method, nonce, verified_at) VALUES ($1,$2,$3,'dns_txt','n',now())`, [a.workspaceId, id, domain]);
  }

  const post = (a: Actor, over: { body?: unknown; confirmed?: number | null; key?: string | null } = {}) => {
    const headers: Record<string, string> = { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" };
    if (over.confirmed !== undefined && over.confirmed !== null) headers["x-nominara-confirmed-credits"] = String(over.confirmed);
    headers["idempotency-key"] = over.key ?? uuidV7();
    return harness.app().inject({ method: "POST", url: apiUrl("/tools/aux-audit"), headers, payload: (over.body ?? { mode: "full", url: URL_, pages: 3 }) as object });
  };
  const full = (a: Actor, over: { pages?: number; confirmed?: number | null } = {}) => post(a, { body: { mode: "full", url: URL_, pages: over.pages ?? 3 }, confirmed: over.confirmed === undefined ? 10 : over.confirmed });
  const siteFiles = (a: Actor, url = URL_) => post(a, { body: { mode: "site_files", url } });
  const get = (a: Actor, path: string) => harness.app().inject({ method: "GET", url: apiUrl(path), headers: { cookie: a.cookie } });
  const available = async (actor: Actor): Promise<number> => {
    const w = (await harness.db().query<{ included_balance: number; purchased_balance: number; reserved: number }>("SELECT included_balance, purchased_balance, reserved FROM credit_wallets WHERE workspace_id = $1", [actor.workspaceId])).rows[0];
    return w === undefined ? GRANT[actor.plan] : w.included_balance + w.purchased_balance - w.reserved;
  };
  const count = async (sql: string, args: unknown[] = []): Promise<number> => (await harness.db().query<{ n: number }>(sql, args)).rows[0]!.n;
  interface Detail {
    status: string;
    credits_charged: number;
    error_code: string | null;
    cache_layer: string;
    headline: { aux_score: number | null; pages_scanned: number | null };
    presentation: { not_tracked: boolean; did_not_check: string };
    conversion: { state: string; prefill: { root_url: string | null } };
    result: {
      scope: string;
      domain_verified: boolean;
      site_files: { agents: { agent: string; access: string }[]; summary: string };
      audit: null | {
        score: { value: number | null; partial: boolean; label: string; excluded_weight_points: number };
        excluded_rules: { rule_code: string }[];
        scope_note: string | null;
        findings: { rule_code: string; consequence: string | null; patch: { free: boolean; credits_charged: number } | null }[];
        patches_included: number;
        pages: { raw_fetched: number; rendered_fetched: number; judged: number; unreachable: { url: string }[] };
        charge: { credits: number; band_label: string; site_files_included: boolean; patches_credits: number };
      };
    } | null;
  }
  const detail = async (a: Actor, id: string): Promise<Detail> => ((await get(a, `/tools/runs/${id}`)).json() as { data: Detail }).data;
  const settle = async (): Promise<void> => {
    await Promise.all(workers);
  };
  const lastRun = (): string => enqueued[enqueued.length - 1]!.payload["toolRunId"] as string;
  const refunds = (a: Actor, id: string): Promise<number> => count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 AND entry_type = 'refund'", [a.workspaceId, id]);

  it("scenario 1 - site-files mode on the LOWEST tier is free and available: 202, 0 credits, an AI-agent reading (scenario 3), no score", async () => {
    const a = await owner("free");
    const before = await available(a);
    const res = await siteFiles(a);
    expect(res.statusCode, res.body).toBe(202);
    expect((res.json() as { data: Record<string, unknown> }).data).toMatchObject({ mode: "site_files", status: "running", cached: false, credits_charged: 0 });
    await settle();
    const d = await detail(a, lastRun());
    expect(d.status).toBe("completed");
    expect(d.credits_charged).toBe(0);
    expect(await available(a)).toBe(before);
    expect(d.result!.audit).toBeNull();
    expect(d.headline).toMatchObject({ aux_score: null, pages_scanned: null });
    expect(d.presentation.not_tracked).toBe(true);
    expect(d.presentation.did_not_check.length).toBeGreaterThan(0);
    expect(d.result!.site_files.agents.find((x) => x.agent === "GPTBot")?.access).toBe("blocked");
    expect(d.result!.site_files.summary).toMatch(/AI agents/u);
    expect(fetched.every((p) => ["/robots.txt", "/llms.txt", "/.well-known/llms.txt", "/sitemap.xml"].includes(p))).toBe(true);
  });

  it("scenario 2 - a repeat on the same host is served from the cache: completed in the request, no job, no fetch, no charge - even for another workspace", async () => {
    const a = await owner("free");
    await siteFiles(a);
    await settle();
    const fetchedBefore = fetched.length;
    const again = await siteFiles(a);
    expect(again.statusCode, again.body).toBe(202);
    expect((again.json() as { data: Record<string, unknown> }).data).toMatchObject({ status: "completed", cached: true, credits_charged: 0 });
    expect(enqueued).toHaveLength(1);
    expect(fetched.length).toBe(fetchedBefore);
    const d = await detail(a, (again.json() as { data: { tool_run_id: string } }).data.tool_run_id);
    expect(d.status).toBe("completed");
    expect(d.cache_layer).toBe("l1");
    expect(d.result!.site_files.agents.find((x) => x.agent === "GPTBot")?.access).toBe("blocked");
    const b = await owner("starter");
    const other = await siteFiles(b);
    expect((other.json() as { data: Record<string, unknown> }).data).toMatchObject({ status: "completed", cached: true });
    expect(enqueued).toHaveLength(1);
  });

  it("scenario 4, 5, 6, 8 - a full audit: 202, charged the band price once, raw AND rendered for each page, score, findings (consequence first) and free patches", async () => {
    const a = await owner("starter");
    await verifyDomain(a, "acme.example");
    const before = await available(a);
    const res = await full(a);
    expect(res.statusCode, res.body).toBe(202);
    expect((res.json() as { data: Record<string, unknown> }).data).toMatchObject({ mode: "full", status: "running", credits_charged: 10, pages_requested: 3 });
    await settle();
    expect(await available(a)).toBe(before - 10);
    const d = await detail(a, lastRun());
    expect(d.status).toBe("completed");
    expect(d.credits_charged).toBe(10);
    const audit = d.result!.audit!;
    expect(audit.pages).toMatchObject({ raw_fetched: 3, rendered_fetched: 3, judged: 3 });
    expect(audit.charge).toEqual({ credits: 10, band_label: "up to 25 pages", site_files_included: true, patches_credits: 0 });
    expect(audit.findings.length).toBeGreaterThan(0);
    // Postgres jsonb does not keep key order, so "leads with" is the field's presence and text (the renderer's key order is asserted in tool-audit.test.ts).
    expect(audit.findings.every((f) => typeof f.consequence === "string" && f.consequence.length > 0)).toBe(true);
    expect(audit.patches_included).toBeGreaterThan(0);
    for (const f of audit.findings.filter((x) => x.patch !== null)) expect(f.patch).toMatchObject({ free: true, credits_charged: 0 });
    expect(d.headline.aux_score).toBe(audit.score.value);
    expect(d.headline.pages_scanned).toBe(3);
    // ONE charge for the whole audit: nothing for the site files and nothing for the patches.
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 AND entry_type = 'commit'", [a.workspaceId, lastRun()])).toBeGreaterThan(0);
    expect(await count("SELECT coalesce(sum(credits),0)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 AND entry_type = 'commit'", [a.workspaceId, lastRun()])).toBe(10);
  });

  it("the price is confirmed: absent is 400, a wrong figure is 409 price_changed (shown, recomputed), an unknown key is 400 - and nothing is charged or queued", async () => {
    const a = await owner("starter");
    const before = await available(a);
    expect((await full(a, { confirmed: null })).statusCode).toBe(400);
    const wrong = await full(a, { confirmed: 11 });
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(wrong.json()).toMatchObject({ error: { code: "price_changed", details: { shown: 11, recomputed: 10 } } });
    expect((await post(a, { body: { mode: "full", url: URL_, engine: "chatgpt" }, confirmed: 10 })).statusCode).toBe(400);
    const extra = await post(a, { body: { mode: "site_files", url: URL_, pages: 5 } });
    expect(extra.statusCode, extra.body).toBe(400);
    expect(await available(a)).toBe(before);
    expect(enqueued).toHaveLength(0);
  });

  it("scenario 7 - the free estimate names the page band and recomputes for the requested page count; a count above the plan's cap is refused", async () => {
    const a = await owner("starter");
    const est = (q: string) => get(a, `/tools/aux-audit/estimate${q}`);
    const five = await est("?pages=5");
    expect(five.statusCode, five.body).toBe(200);
    expect((five.json() as { data: Record<string, unknown> }).data).toMatchObject({ pages: 5, credits: 10, band: { label: "up to 25 pages", beyond_first_band: false }, site_files_included: true, patches_free: true, price_depends_on_verification: false, credits_charged: 0 });
    expect((await est("?pages=25")).json()).toMatchObject({ data: { pages: 25, credits: 10 } });
    expect((await est("")).json()).toMatchObject({ data: { pages: 25, credits: 10 } });
    expect((await est("?pages=26")).statusCode).toBe(400);
    expect((await post(a, { body: { mode: "full", url: URL_, pages: 26 }, confirmed: 11 })).statusCode).toBe(400);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(0);
  });

  it("scenario 9, 10, 11 - an unverified domain is audited at the same price with its limits stated; verifying it and re-auditing widens the scope and does not change the price", async () => {
    const a = await owner("starter");
    const start = await available(a);
    await full(a);
    await settle();
    const first = await detail(a, lastRun());
    expect(first.result).toMatchObject({ scope: "public_surface", domain_verified: false });
    expect(first.result!.audit!.pages.judged).toBe(1);
    expect(first.result!.audit!.excluded_rules.length).toBeGreaterThan(0);
    expect(first.result!.audit!.score.excluded_weight_points).toBeGreaterThan(0);
    expect(first.result!.audit!.score.partial).toBe(true);
    expect(first.result!.audit!.score.label).toMatch(/^Partial score/u);
    expect(first.result!.audit!.scope_note).toMatch(/not verified/iu);
    expect(await available(a)).toBe(start - 10);

    await verifyDomain(a, "acme.example");
    const again = await full(a);
    expect((again.json() as { data: Record<string, unknown> }).data).toMatchObject({ credits_charged: 10, scope: "key_pages", domain_verified: true });
    await settle();
    const second = await detail(a, lastRun());
    expect(second.result).toMatchObject({ scope: "key_pages", domain_verified: true });
    expect(second.result!.audit!.pages.judged).toBeGreaterThan(first.result!.audit!.pages.judged);
    expect(second.result!.audit!.scope_note).toBeNull();
    expect(second.credits_charged).toBe(first.credits_charged);
    expect(await available(a)).toBe(start - 20);
  });

  it("scenario 12 - an internal address is refused by the existing forgery guard (422 unsafe_target) before anything is charged, queued or written", async () => {
    const a = await owner("starter");
    vi.mocked(UrlGuard.prototype.validateAndNormalize).mockRestore();
    const before = await available(a);
    for (const body of [{ mode: "full", url: "http://127.0.0.1/admin", pages: 3 }, { mode: "site_files", url: "http://127.0.0.1/" }]) {
      const res = await post(a, { body, confirmed: 10 });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json()).toMatchObject({ error: { code: "unsafe_target" } });
    }
    expect(await available(a)).toBe(before);
    expect(enqueued).toHaveLength(0);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(0);
  });

  it("scenario 13 - every page unreachable: the run fails with the named reason and the charge is refunded in full, exactly once, even on redelivery", async () => {
    const a = await owner("starter");
    site["/"] = "throw";
    site["/a"] = "throw";
    site["/b"] = "throw";
    const before = await available(a);
    await full(a);
    await settle();
    const d = await detail(a, lastRun());
    expect(d.status).toBe("failed");
    expect(d.error_code).toBe("no_page_reachable");
    expect(d.credits_charged).toBe(0);
    expect(await available(a)).toBe(before);
    expect(await refunds(a, lastRun())).toBe(1);
    await runWorker(a.workspaceId, enqueued[0]!.payload);
    expect(await available(a)).toBe(before);
    expect(await refunds(a, lastRun())).toBe(1);
  });

  it("scenario 14 - some pages unreachable: charged in full, the unreachable page is named", async () => {
    const a = await owner("starter");
    await verifyDomain(a, "acme.example");
    site["/b"] = "throw";
    const before = await available(a);
    await full(a);
    await settle();
    const d = await detail(a, lastRun());
    expect(d.status).toBe("completed");
    expect(d.credits_charged).toBe(10);
    expect(await available(a)).toBe(before - 10);
    expect(d.result!.audit!.pages.unreachable.map((p) => new URL(p.url).pathname)).toEqual(["/b"]);
  });

  it("scenario 15 - after a run the fact and audit tables hold zero rows; the conversion prefill carries the audited URL", async () => {
    const a = await owner("starter");
    await full(a);
    await settle();
    for (const table of ["aux_audits", "aux_findings", "patches", "citation_facts", "answer_captures", "capture_runs", "projects"]) {
      expect(await count(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`, [a.workspaceId]), table).toBe(0);
    }
    const d = await detail(a, lastRun());
    expect(d.presentation.not_tracked).toBe(true);
    expect(d.conversion).toMatchObject({ state: "available", prefill: { root_url: URL_ } });
    const preview = await get(a, `/tools/runs/${lastRun()}/convert`);
    expect(preview.json()).toMatchObject({ data: { state: "available", prefill: { root_url: URL_ } } });
  });

  it("at-least-once - the same job delivered again after it settled fetches nothing and charges nothing more", async () => {
    const a = await owner("starter");
    const before = await available(a);
    await full(a);
    await settle();
    const after = fetched.length;
    await runWorker(a.workspaceId, enqueued[0]!.payload);
    expect(fetched.length).toBe(after);
    expect(await available(a)).toBe(before - 10);
  });

  it("final attempt - an unexpected error on the last delivery settles the run failed as audit_job_failed and returns the charge exactly once; an earlier delivery is retried", async () => {
    const a = await owner("starter");
    viaProcessor = true;
    auditDeps = { ...auditDeps, now: () => { throw new Error("boom"); } };
    const before = await available(a);
    attemptsMade = 0;
    await full(a);
    await Promise.allSettled(workers);
    workers = [];
    expect((await detail(a, lastRun())).status).toBe("running");
    expect(await available(a)).toBe(before - 10);
    attemptsMade = 2;
    await runWorker(a.workspaceId, enqueued[0]!.payload);
    const d = await detail(a, lastRun());
    expect(d.status).toBe("failed");
    expect(d.error_code).toBe("audit_job_failed");
    expect(await available(a)).toBe(before);
    expect(await refunds(a, lastRun())).toBe(1);
  });

  it("observability - the finished log line carries the workspace ID and run ID and no URL, host or page content", async () => {
    const a = await owner("starter");
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
      lines.push(message);
    });
    await full(a);
    await settle();
    const mine = lines.filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null && String((l as { event?: string }).event).startsWith("tools.aux_audit"));
    expect(mine.find((l) => l["event"] === "tools.aux_audit.finished")).toMatchObject({ workspace_id: a.workspaceId, run_id: lastRun(), mode: "full", delivered: true });
    expect(JSON.stringify(mine)).not.toContain("acme.example");
    expect(JSON.stringify(mine)).not.toContain("Acme widgets");
  });
});
