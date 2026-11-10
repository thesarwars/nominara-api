import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { Pool } from "pg";
import { UrlGuard } from "../../src/lib/net/url-guard.service.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schemaBuilderUrlAcceptedSchema, schemaBuilderUrlResultSchema } from "../../contracts/tools/index.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { createLookupExecuteHandler } from "../../src/lib/queue/handlers/lookup-execute.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { phasesOf, PHASES_DONE } from "../../src/lib/queue/worker-factory.js";
import type { GuardedResponse } from "../../src/lib/net/guarded-fetch.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { ToolsService } from "../../src/modules/tools/tools.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-083 AC5 / decision 82 - Schema Builder URL mode through the REAL ApiModule: the route, the guards, the free run row, the queue seam and the worker phases
// against the real database. The queue is the one seam replaced (the job is captured, then its phases are driven with a fake page), so no network is touched.
// Scenario ids are SU-Ix.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;
interface Actor { readonly workspaceId: string; readonly userId: string; readonly cookie: string; readonly csrf: string }

const PAGE_URL = "https://shop.example/products/crm";
const PRODUCT = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Acme", offers: { "@type": "Offer" } })}</script>`;
const html = `<html><head><title>x</title>${PRODUCT}</head><body><main><p>Pricing: $37 per month.</p></main></body></html>`;
const reply = (status = 200, ct = "text/html"): GuardedResponse => ({ status, headers: { "content-type": ct }, body: Buffer.from(status === 200 ? html : ""), finalUrl: PAGE_URL });

describe("STORY-083 AC5 · Schema Builder URL mode", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({ env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }) });
  let pool: Pool;
  let sessions: SessionService;
  let enqueued: { workspaceId: string; payload: Record<string, unknown>; options: Record<string, unknown> }[];
  let failEnqueue = false;

  beforeAll(async () => {
    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop()]);
  });
  beforeEach(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    sessions = new SessionService(pool, new MembershipService(new MembershipCacheService()), new InMemoryCacheAdapter());
    enqueued = [];
    failEnqueue = false;
    vi.spyOn(QueueProducer.prototype, "enqueueTenantJob").mockImplementation(async (_name, workspaceId, payload, options) => {
      if (failEnqueue) throw new Error("redis down");
      enqueued.push({ workspaceId, payload, options: options as unknown as Record<string, unknown> });
      return {} as Job;
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.end();
  });

  async function owner(plan: "free" | "starter" | "growth" | "business" = "free"): Promise<Actor> {
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
    return { userId, workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  const start = (a: Actor, payload: unknown, key: string | null = uuidV7()) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl("/tools/schema-builder/url"),
      headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }) },
      payload: payload as object,
    });
  const read = (a: Actor, id: string) => harness.app().inject({ method: "GET", url: apiUrl(`/tools/runs/${id}`), headers: { cookie: a.cookie } });
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  const wallet = async (workspaceId: string) => (await harness.db().query("SELECT included_balance, purchased_balance, reserved FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0];
  const row = async (id: string) => (await harness.db().query("SELECT status, credits_charged, target_url, error_code, result_json, tool_key FROM tool_runs WHERE id = $1", [id])).rows[0];
  const noGuardDns = () => vi.spyOn(UrlGuard.prototype, "validateAndNormalize").mockImplementation(async (u: string) => ({ rootDomain: new URL(u).hostname }));

  /** Drives the captured job's phases against the real database, as the worker would, with the page the test supplies. */
  async function runWorker(a: Actor, page: () => Promise<GuardedResponse>, over: { attemptsMade?: number } = {}): Promise<void> {
    const job = { data: { payload: { ...enqueued.at(-1)!.payload, workspaceId: a.workspaceId } }, attemptsMade: over.attemptsMade ?? 0, opts: { attempts: 3 } } as unknown as Job;
    const processor = createLookupExecuteHandler({ pool, env: {} } as unknown as QueueHandlerContext, {
      cache: new InMemoryCacheAdapter(),
      schemaBuilderUrl: { check: { fetch: page }, tools: async () => harness.app().get(ToolsService) },
    });
    const phases = phasesOf(processor)!;
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId: a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        const prepared = await phases.prepare(tx, job);
        if (prepared === PHASES_DONE) return;
        const fetched = await phases.run(prepared, job);
        await phases.commit(tx, prepared, fetched, job);
      });
    } finally {
      client.release();
    }
  }

  it("SU-I1 202: a free `running` run with a pending result is written, nothing is fetched, the job is enqueued after commit with the run's key, and the wallet is untouched", async () => {
    noGuardDns();
    const a = await owner();
    const before = await wallet(a.workspaceId);
    const res = await start(a, { url: PAGE_URL });
    expect(res.statusCode, res.body).toBe(202);
    const body = schemaBuilderUrlAcceptedSchema.parse(data(res));
    expect(await row(body.tool_run_id)).toMatchObject({ tool_key: "schema_builder", status: "running", credits_charged: 0, target_url: PAGE_URL, result_json: { schema_version: 1, source: "url", state: "pending" } });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ workspaceId: a.workspaceId, payload: { tool: "schema_builder", toolRunId: body.tool_run_id, targetUrl: PAGE_URL }, options: { idempotencyKey: `lookup:${body.tool_run_id}` } });
    expect(await wallet(a.workspaceId)).toEqual(before);
  });

  it("SU-I2 an unsafe URL is 422 unsafe_target BEFORE any run is written or job enqueued (the real guard, no stub)", async () => {
    const a = await owner();
    const res = await start(a, { url: "http://127.0.0.1/admin" });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain("unsafe_target");
    expect((await harness.db().query("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).rows[0].n).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it("SU-I3 the body is strict (pasted markup or an unknown key is 400), a non-http scheme is 400, and an Idempotency-Key is required", async () => {
    noGuardDns();
    const a = await owner();
    for (const payload of [{ url: PAGE_URL, markup: "<x>" }, { url: "ftp://shop.example/" }, {}, { url: 42 }]) expect((await start(a, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    expect((await start(a, { url: PAGE_URL }, null)).statusCode).toBe(400);
    expect((await harness.db().query("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).rows[0].n).toBe(0);
  });

  it("SU-I4 the same Idempotency-Key replays the same run and enqueues once", async () => {
    noGuardDns();
    const a = await owner();
    const key = uuidV7();
    const first = await start(a, { url: PAGE_URL }, key);
    const second = await start(a, { url: PAGE_URL }, key);
    expect(second.statusCode).toBe(202);
    expect(data<{ tool_run_id: string }>(second).tool_run_id).toBe(data<{ tool_run_id: string }>(first).tool_run_id);
    expect(enqueued).toHaveLength(1);
  });

  it("SU-I5 the worker finishes the run: findings only, free, re-openable, with the URL-mode did-not-check line and an unchanged wallet; no fact row is written", async () => {
    noGuardDns();
    const a = await owner();
    const id = data<{ tool_run_id: string }>(await start(a, { url: PAGE_URL })).tool_run_id;
    const before = await wallet(a.workspaceId);
    await runWorker(a, async () => reply());
    const stored = await row(id);
    expect(stored).toMatchObject({ status: "completed", credits_charged: 0, error_code: null });
    const result = schemaBuilderUrlResultSchema.parse(stored.result_json);
    expect(result.state).toBe("checked");
    if (result.state === "checked") {
      const catalog = new Map((await harness.db().query<{ code: string; rationale: string }>("SELECT code, rationale FROM aux_rule_catalog")).rows.map((r) => [r.code, r.rationale]));
      const f = result.findings.find((x) => x.rule_code === "AUX-R-012")!;
      expect(f.consequence).toBe(catalog.get("AUX-R-012"));
    }
    expect(JSON.stringify(stored.result_json)).not.toContain("Pricing: $37");
    const reopened = await read(a, id);
    expect(reopened.statusCode, reopened.body).toBe(200);
    const run = data<{ status: string; presentation: { did_not_check: string; not_tracked: boolean } }>(reopened);
    expect(run).toMatchObject({ status: "completed", presentation: { not_tracked: true } });
    expect(run.presentation.did_not_check).not.toContain("no live page fetch");
    expect(await wallet(a.workspaceId)).toEqual(before);
    expect((await harness.db().query("SELECT count(*)::int AS n FROM answer_captures WHERE workspace_id = $1", [a.workspaceId])).rows[0].n).toBe(0);
  });

  it("SU-I6 an unreachable page settles the run as FAILED with a reason; an HTTP error and a non-HTML page too; nothing about the page is stored", async () => {
    noGuardDns();
    const a = await owner();
    for (const [page, reason] of [
      [async () => reply(503), "http_error"],
      [async () => reply(200, "application/json"), "not_html"],
      [async () => { throw new Error("connect ECONNREFUSED 10.0.0.9:443"); }, "unreachable"],
    ] as const) {
      const id = data<{ tool_run_id: string }>(await start(a, { url: PAGE_URL })).tool_run_id;
      await runWorker(a, page);
      const stored = await row(id);
      expect(stored).toMatchObject({ status: "failed", credits_charged: 0, error_code: "page_unreachable", result_json: { schema_version: 1, source: "url", state: "unreachable", reason } });
      expect(JSON.stringify(stored.result_json)).not.toContain("10.0.0.9");
    }
  });

  it("SU-I7 a redelivery after the run settled does nothing: the stored result is unchanged and the page is not fetched again", async () => {
    noGuardDns();
    const a = await owner();
    const id = data<{ tool_run_id: string }>(await start(a, { url: PAGE_URL })).tool_run_id;
    await runWorker(a, async () => reply());
    const first = await row(id);
    const fetch = vi.fn(async () => reply());
    await runWorker(a, fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect(await row(id)).toEqual(first);
  });

  it("SU-I8 a failed enqueue settles the accepted run as failed (schema_builder_not_queued) instead of leaving it running for ever", async () => {
    noGuardDns();
    const a = await owner();
    failEnqueue = true;
    const res = await start(a, { url: PAGE_URL });
    expect(res.statusCode, res.body).toBe(202);
    const id = data<{ tool_run_id: string }>(res).tool_run_id;
    await vi.waitFor(async () => expect(await row(id)).toMatchObject({ status: "failed", error_code: "schema_builder_not_queued", result_json: { schema_version: 1, source: "url", state: "unreachable", reason: "unreachable" } }), { timeout: 5000 });
  });

  it("SU-I9 another workspace cannot read the run (404), and the worker's prepare under the wrong workspace finds no run and does nothing", async () => {
    noGuardDns();
    const a = await owner();
    const b = await owner();
    const id = data<{ tool_run_id: string }>(await start(a, { url: PAGE_URL })).tool_run_id;
    expect((await read(b, id)).statusCode).toBe(404);
    const fetch = vi.fn(async () => reply());
    const job = { data: { payload: { ...enqueued.at(-1)!.payload, workspaceId: b.workspaceId } }, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job;
    const phases = phasesOf(createLookupExecuteHandler({ pool, env: {} } as unknown as QueueHandlerContext, { cache: new InMemoryCacheAdapter(), schemaBuilderUrl: { check: { fetch }, tools: async () => harness.app().get(ToolsService) } }))!;
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId: b.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => expect(await phases.prepare(tx, job)).toBe(PHASES_DONE));
    } finally {
      client.release();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect((await row(id)).status).toBe("running");
  });

  it("SU-I10 the accepted line carries the workspace and run ids and never the URL", async () => {
    noGuardDns();
    const a = await owner();
    const logs: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(m));
    let id: string;
    try {
      id = data<{ tool_run_id: string }>(await start(a, { url: PAGE_URL })).tool_run_id;
    } finally {
      spy.mockRestore();
    }
    expect(logs).toContainEqual(expect.objectContaining({ event: "tools.schema_builder_url.accepted", workspace_id: a.workspaceId, run_id: id }));
    expect(JSON.stringify(logs.filter((l) => (l as { event?: string }).event?.startsWith("tools.schema_builder_url")))).not.toContain("shop.example");
  });
});
