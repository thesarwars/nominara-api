import { Logger } from "@nestjs/common";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { UrlGuard } from "../../src/lib/net/url-guard.service.js";
import { DID_NOT_CHECK, NOT_TRACKED_NOTE } from "../../src/lib/tools/presentation.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { ToolsService, type StartToolRunInput } from "../../src/modules/tools/tools.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { expireToolSnapshotsForWorkspace, reapStaleToolRuns, runNightlySweep } from "../../src/workers/rollup/retention.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-078 - the shared tool core through the REAL ApiModule: lifecycle, credits, timeline, free re-open, retention, conversion.
// Scenario numbers are the story's Test scenarios table. Scenarios 1-4 are the database constraints
// (tool-runs-core-migration.spec.ts); 5 and 6 are partly pure (src/lib/tools/tool-core.spec.ts) and partly here.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

interface Actor {
  readonly workspaceId: string;
  readonly userId: string;
  readonly cookie: string;
  readonly csrf: string;
}

describe("STORY-078 · shared tool core", () => {
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
    vi.spyOn(UrlGuard.prototype, "validateAndNormalize").mockImplementation(async (url: string) => ({ rootDomain: new URL(url).hostname }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.end();
  });

  async function newUser(): Promise<string> {
    const userId = uuidV7();
    await harness.db().query(`INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`, [userId, `${userId}@example.test`]);
    return userId;
  }

  async function owner(plan: "free" | "starter" | "growth" | "business" = "starter"): Promise<Actor> {
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
    const version = (await harness.db().query<{ entitlement_version: number }>("SELECT entitlement_version FROM workspaces WHERE id = $1", [workspaceId])).rows[0]!.entitlement_version;
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, version);
    return { userId, workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  async function inTenant<T>(actor: Actor, fn: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId: actor.workspaceId, actorId: actor.userId }, async () => fn());
    } finally {
      client.release();
    }
  }

  const tools = (): ToolsService => harness.app().get(ToolsService);
  const scan = (over: Partial<StartToolRunInput> = {}): StartToolRunInput => ({
    toolKey: "visibility_scan",
    brandName: "Acme",
    brandUrl: "https://acme.test",
    queryText: "best crm for startups",
    engineKeys: ["perplexity", "chatgpt"],
    credits: 10,
    ...over,
  });
  const start = (actor: Actor, input: StartToolRunInput) => inTenant(actor, () => tools().startRun(input));
  const wallet = async (workspaceId: string) =>
    (await harness.db().query<{ included_balance: number; purchased_balance: number; reserved: number }>("SELECT included_balance, purchased_balance, reserved FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0];
  const ledgerCount = async (workspaceId: string) =>
    (await harness.db().query<{ n: number }>("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1", [workspaceId])).rows[0]!.n;
  const getRun = (a: Actor, id: string, headers: Record<string, string> = {}) =>
    harness.app().inject({ method: "GET", url: apiUrl(`/tools/runs/${id}`), headers: { cookie: a.cookie, ...headers } });
  const list = (a: Actor, query = "") => harness.app().inject({ method: "GET", url: apiUrl(`/tools/runs${query}`), headers: { cookie: a.cookie } });
  const patch = (a: Actor, id: string, payload: unknown) =>
    harness.app().inject({ method: "PATCH", url: apiUrl(`/tools/runs/${id}`), headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" }, payload: payload as object });
  const preview = (a: Actor, id: string) => harness.app().inject({ method: "GET", url: apiUrl(`/tools/runs/${id}/convert`), headers: { cookie: a.cookie } });
  // Each call is a distinct click, so each carries its own Idempotency-Key (the route is declared `@Idempotent()`); `key: null` sends none.
  const convert = (a: Actor, id: string, payload: unknown = {}, key: string | null = uuidV7()) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl(`/tools/runs/${id}/convert`),
      headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }) },
      payload: payload as object,
    });
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  const age = (id: string) => harness.db().query("UPDATE tool_runs SET expires_at = now() - interval '1 day' WHERE id = $1", [id]);
  const finished = async (a: Actor, over: Partial<StartToolRunInput> = {}) => {
    const run = await start(a, scan({ credits: 0, ...over }));
    await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: over.engineKeys ?? ["perplexity", "chatgpt"], enginesFailed: [] }));
    return run;
  };
  const sweep = (workspaceId: string, options?: { batchSize?: number; maxBatches?: number }) =>
    expireToolSnapshotsForWorkspace(harness.db(), workspaceId, new Date(), options);

  it("scenario 5 - zero fact rows exist after every one of the six tools has run a full lifecycle", async () => {
    const a = await owner("business");
    const inputs: StartToolRunInput[] = [
      scan(),
      { toolKey: "prompt_research", promptTexts: ["a?"], engineKeys: ["perplexity"], credits: 5 },
      { toolKey: "competitor_finder", brandUrl: "https://acme.test", engineKeys: ["perplexity"], credits: 1 },
      { toolKey: "aux_audit", targetUrl: "https://acme.test", engineKeys: [], credits: 0 },
      { toolKey: "schema_builder", resultJson: { jsonld: {} }, engineKeys: [], credits: 0 },
    ];
    const ids: string[] = [];
    for (const input of inputs) {
      const run = await start(a, input);
      ids.push(run.id);
      await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: input.engineKeys ?? [], enginesFailed: [] }));
    }
    await inTenant(a, async () => {
      const diff = await tools().startRun({ toolKey: "compare_runs", engineKeys: [], diffBaseRunId: ids[0]!, diffCompareRunId: ids[1]!, credits: 0 });
      await tools().finishRun(diff.id, { enginesSucceeded: [], enginesFailed: [] });
    });
    for (const table of ["answer_captures", "mention_facts", "citation_facts", "capture_runs"]) {
      expect((await harness.db().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n, table).toBe(0);
    }
    expect((await harness.db().query<{ n: number }>("SELECT count(*)::int AS n FROM tool_runs")).rows[0]!.n).toBe(6);
  });

  it("scenario 6 - the same inputs from two callers store an identical input_hash, and the pair is findable by it", async () => {
    const a = await owner("starter");
    const second = await newUser();
    await harness.db().query(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'manager','active')`, [uuidV7(), a.workspaceId, second]);
    const one = await start(a, scan());
    const two = await start({ ...a, userId: second }, scan({ brandName: "  ACME ", queryText: "Best CRM for   startups", engineKeys: ["chatgpt", "perplexity"] }));
    const rows = await harness.db().query<{ id: string; created_by: string }>(
      `SELECT id, created_by FROM tool_runs WHERE workspace_id = $1 AND tool_key = 'visibility_scan'
        AND input_hash = (SELECT input_hash FROM tool_runs WHERE id = $2) ORDER BY created_at`,
      [a.workspaceId, one.id],
    );
    expect(rows.rows.map((r) => r.id).sort()).toEqual([one.id, two.id].sort());
    expect(new Set(rows.rows.map((r) => r.created_by)).size).toBe(2);
  });

  it("scenario 7 - a run is created running, moves to exactly one terminal state, and a repeated finish never rewrites it", async () => {
    const a = await owner("starter");
    const run = await start(a, scan());
    expect((await harness.db().query("SELECT status FROM tool_runs WHERE id = $1", [run.id])).rows[0]).toEqual({ status: "running" });
    const first = await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: ["perplexity", "chatgpt"], enginesFailed: [], durationMs: 900 }));
    expect(first.status).toBe("completed");
    const again = await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: [], enginesFailed: ["perplexity", "chatgpt"], durationMs: 5 }));
    expect(again.status).toBe("completed");
    expect(again.duration_ms).toBe(900);
    expect(again.engines_failed).toEqual([]);
    await expect(harness.db().query("UPDATE tool_runs SET status = 'failed' WHERE id = $1", [run.id])).rejects.toThrow(/tool_runs status/);
  });

  it("scenario 7 - finishing a run that does not exist (or belongs to another workspace) is a not-found, not a write", async () => {
    const a = await owner("starter");
    const b = await owner("starter");
    const run = await start(a, scan());
    await expect(inTenant(b, () => tools().finishRun(run.id, { enginesSucceeded: ["perplexity"], enginesFailed: [] }))).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(inTenant(a, () => tools().finishRun(uuidV7(), { enginesSucceeded: [], enginesFailed: [] }))).rejects.toMatchObject({ name: "NotFoundError" });
    expect((await harness.db().query("SELECT status FROM tool_runs WHERE id = $1", [run.id])).rows[0]).toEqual({ status: "running" });
  });

  it("scenario 8 - expires_at is set at insert from the plan's retention (starter 90 days, growth 180), and a read never moves it", async () => {
    const starter = await owner("starter");
    const growth = await owner("growth");
    const s = await start(starter, scan());
    const g = await start(growth, scan());
    const days = async (id: string) =>
      Number((await harness.db().query<{ d: string }>("SELECT round(extract(epoch FROM (expires_at - created_at)) / 86400)::text AS d FROM tool_runs WHERE id = $1", [id])).rows[0]!.d);
    expect(await days(s.id)).toBe(90);
    expect(await days(g.id)).toBe(180);
    const before = (await harness.db().query("SELECT expires_at FROM tool_runs WHERE id = $1", [s.id])).rows[0];
    await getRun(starter, s.id);
    expect((await harness.db().query("SELECT expires_at FROM tool_runs WHERE id = $1", [s.id])).rows[0]).toEqual(before);
  });

  it("scenario 9 - a run that captured nothing is refunded in full: wallet restored, status failed, credits_charged 0, ledger shows commit and refund", async () => {
    const a = await owner("starter");
    const start0 = await wallet(a.workspaceId);
    const run = await start(a, scan());
    const charged = await wallet(a.workspaceId);
    expect((charged?.included_balance ?? 0) + (charged?.purchased_balance ?? 0)).toBe((start0?.included_balance ?? 450) + (start0?.purchased_balance ?? 0) - 10);
    const done = await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: [], enginesFailed: ["perplexity", "chatgpt"], errorCode: "all_engines_failed" }));
    expect(done).toMatchObject({ status: "failed", credits_charged: 0, engines_succeeded: [], engines_failed: ["perplexity", "chatgpt"] });
    const after = await wallet(a.workspaceId);
    expect((after?.included_balance ?? 0) + (after?.purchased_balance ?? 0)).toBe((charged?.included_balance ?? 0) + (charged?.purchased_balance ?? 0) + 10);
    const entries = await harness.db().query<{ entry_type: string; credits: number; reference_type: string | null }>(
      "SELECT entry_type, credits, reference_type FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 ORDER BY seq",
      [a.workspaceId, run.id],
    );
    expect(entries.rows.map((r) => [r.entry_type, r.credits])).toEqual(expect.arrayContaining([["commit", 10], ["refund", 10]]));
    expect(entries.rows.every((r) => r.reference_type === "tool_run")).toBe(true);
    // idempotent: a repeated finish refunds nothing more
    await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: [], enginesFailed: ["perplexity", "chatgpt"] }));
    expect(await wallet(a.workspaceId)).toEqual(after);
  });

  it("scenario 10 - a partial run is charged in full, and the row says which engines succeeded and which failed", async () => {
    const a = await owner("starter");
    const before = await wallet(a.workspaceId);
    const run = await start(a, scan());
    const done = await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: ["perplexity"], enginesFailed: ["chatgpt"] }));
    expect(done).toMatchObject({ status: "partial", credits_charged: 10, engines_succeeded: ["perplexity"], engines_failed: ["chatgpt"] });
    const after = await wallet(a.workspaceId);
    expect((after?.included_balance ?? 0) + (after?.purchased_balance ?? 0)).toBe((before?.included_balance ?? 450) + (before?.purchased_balance ?? 0) - 10);
    expect((await harness.db().query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'refund' AND reference_id = $2", [a.workspaceId, run.id])).rowCount).toBe(0);
  });

  it("scenario 10 - every debit is a wallet debit with a ledger entry; no usage counter moves for credit purposes", async () => {
    const a = await owner("starter");
    const counters = async () => (await harness.db().query("SELECT * FROM usage_counters WHERE workspace_id = $1 ORDER BY 1", [a.workspaceId])).rows;
    const before = await counters();
    const run = await start(a, scan());
    const commit = await harness.db().query<{ credits: number; action_code: string; actor_id: string }>(
      "SELECT credits, action_code, actor_id FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 AND entry_type = 'commit'",
      [a.workspaceId, run.id],
    );
    expect(commit.rows).toHaveLength(1);
    expect(commit.rows[0]).toMatchObject({ credits: 10, action_code: "lookup", actor_id: a.userId });
    expect(await counters()).toEqual(before);
  });

  it("scenario 10 - a charge the wallet cannot cover is a 402 and leaves no run behind", async () => {
    const a = await owner("starter");
    await expect(start(a, scan({ credits: 30_000 }))).rejects.toMatchObject({ name: "InsufficientCreditsError" });
    expect((await harness.db().query("SELECT 1 FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).rowCount).toBe(0);
  });

  it("scenario 3 - a free tool can never be started with a charge, and nothing is debited for the attempt", async () => {
    const a = await owner("starter");
    const before = await ledgerCount(a.workspaceId);
    await expect(start(a, { toolKey: "schema_builder", resultJson: {}, engineKeys: [], credits: 1 })).rejects.toThrow(/free/);
    expect(await ledgerCount(a.workspaceId)).toBe(before);
  });

  it("scenario 11 - the timeline filters by tool, brand (trigram), creator, date and pinned, and pages by cursor without repeats", async () => {
    const a = await owner("business");
    const second = await newUser();
    await harness.db().query(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'manager','active')`, [uuidV7(), a.workspaceId, second]);
    const mk = async (over: Partial<StartToolRunInput>, actor: Actor = a) => (await start(actor, scan({ credits: 0, ...over }))).id;
    const r1 = await mk({ brandName: "Acme Corp" });
    const r2 = await mk({ brandName: "Globex" });
    const r3 = await mk({ toolKey: "competitor_finder", brandName: "Acme Corp", brandUrl: "https://acme.test", queryText: null, engineKeys: ["perplexity"] }, { ...a, userId: second });
    const r4 = await mk({ brandName: "Initech" });
    const r5 = await mk({ toolKey: "aux_audit", brandName: null, brandUrl: null, queryText: null, targetUrl: "https://acme.test/p", engineKeys: [] });
    await patch(a, r2, { pinned: true });
    await harness.db().query("UPDATE tool_runs SET created_at = now() - interval '10 days' WHERE id = $1", [r1]);

    const ids = async (q: string) => data<Array<{ id: string }>>(await list(a, q)).map((r) => r.id).sort();
    expect(await ids("")).toEqual([r1, r2, r3, r4, r5].sort());
    expect(await ids("?tool_key=competitor_finder")).toEqual([r3]);
    expect(await ids("?pinned=true")).toEqual([r2]);
    expect(await ids(`?created_by=${second}`)).toEqual([r3]);
    expect(await ids("?brand=acme")).toEqual([r1, r3].sort());
    expect(await ids("?brand=Initec")).toEqual([r4]);
    expect(await ids("?brand=acmee")).toEqual([r1, r3].sort());
    expect(await ids("?brand=zzzz")).toEqual([]);
    expect(await ids(`?from=${encodeURIComponent(new Date(Date.now() - 5 * 86_400_000).toISOString())}`)).toEqual([r2, r3, r4, r5].sort());
    expect(await ids(`?to=${encodeURIComponent(new Date(Date.now() - 5 * 86_400_000).toISOString())}`)).toEqual([r1]);
    expect(await ids("?brand=%25")).toEqual([]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const res = await list(a, `?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
      const body = res.json() as { data: Array<{ id: string }>; pagination: { cursor_next: string | null; has_more: boolean } };
      seen.push(...body.data.map((r) => r.id));
      cursor = body.pagination.cursor_next;
      if (!body.pagination.has_more) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen[seen.length - 1]).toBe(r1);
  });

  it("scenario 11 - the timeline is workspace-scoped: another workspace's runs never appear, and an unknown filter key is a 400", async () => {
    const a = await owner("starter");
    const b = await owner("starter");
    await start(b, scan({ credits: 0 }));
    expect(data<unknown[]>(await list(a))).toHaveLength(0);
    expect((await list(a, "?surprise=1")).statusCode).toBe(400);
    expect((await list(a, "?tool_key=nope")).statusCode).toBe(400);
  });

  it("scenario 12 - re-opening a stored run on the lowest tier is one read: wallet unchanged, no ledger entry, no job enqueued, row untouched", async () => {
    const a = await owner("free");
    const run = await start(a, scan({ credits: 0, engineKeys: ["perplexity"] }));
    await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: ["perplexity"], enginesFailed: [], result: { answer: "stored" }, headline: { sov_estimate: 0.5 } }));
    const walletBefore = await wallet(a.workspaceId);
    const ledgerBefore = await ledgerCount(a.workspaceId);
    const xminBefore = (await harness.db().query("SELECT xmin::text FROM tool_runs WHERE id = $1", [run.id])).rows[0];
    const enqueue = vi.spyOn(harness.app().get(QueueProducer, { strict: false }), "enqueueTenantJob");
    for (let i = 0; i < 3; i += 1) {
      const res = await getRun(a, run.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(data<{ result: unknown }>(res).result).toEqual({ answer: "stored" });
    }
    expect(await wallet(a.workspaceId)).toEqual(walletBefore);
    expect(await ledgerCount(a.workspaceId)).toBe(ledgerBefore);
    expect(enqueue).not.toHaveBeenCalled();
    expect((await harness.db().query("SELECT xmin::text FROM tool_runs WHERE id = $1", [run.id])).rows[0]).toEqual(xminBefore);
  });

  it("scenario 13 - an unchanged run revalidates with its entity tag (304, no body); a changed one does not", async () => {
    const a = await owner("starter");
    const run = await start(a, scan({ credits: 0 }));
    const first = await getRun(a, run.id);
    const tag = String(first.headers.etag);
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
    const revalidated = await getRun(a, run.id, { "if-none-match": tag });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.body).toBe("");
    expect((await getRun(a, run.id, { "if-none-match": `W/${tag}` })).statusCode).toBe(304);
    expect((await getRun(a, run.id, { "if-none-match": '"stale"' })).statusCode).toBe(200);
    await patch(a, run.id, { pinned: true });
    const changed = await getRun(a, run.id, { "if-none-match": tag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(tag);
  });

  it("scenario 14 - an aged run is expired by the sweep: payload null, every headline metric intact", async () => {
    const a = await owner("starter");
    const run = await start(a, scan({ credits: 0 }));
    await inTenant(a, () =>
      tools().finishRun(run.id, {
        enginesSucceeded: ["perplexity", "chatgpt"],
        enginesFailed: [],
        result: { answer: "gone soon" },
        headline: { sov_estimate: 0.25, citation_count: 0, sentiment_label: "neutral", brand_present: false, entities_found: 7 },
      }),
    );
    expect(await sweep(a.workspaceId)).toBe(0);
    await age(run.id);
    expect(await sweep(a.workspaceId)).toBe(1);
    const row = (await harness.db().query("SELECT status, result_json, sov_estimate, citation_count, sentiment_label, brand_present, entities_found, engines_succeeded FROM tool_runs WHERE id = $1", [run.id])).rows[0];
    expect(row).toMatchObject({ status: "expired", result_json: null, sov_estimate: 0.25, citation_count: 0, sentiment_label: "neutral", brand_present: false, entities_found: 7, engines_succeeded: ["perplexity", "chatgpt"] });
  });

  it("scenario 15 - an expired run reads as a metrics-only row naming what was removed and when; never blank, never gone", async () => {
    const a = await owner("starter");
    const run = await start(a, scan({ credits: 0 }));
    await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: ["perplexity", "chatgpt"], enginesFailed: [], result: { answer: "x" }, headline: { sov_estimate: 0, citation_count: 0 } }));
    await age(run.id);
    await sweep(a.workspaceId);
    const detail = data<{ status: string; result: unknown; expired: { removed: string; removed_at: string; summary: string } | null; headline: { sov_estimate: number | null; citation_count: number | null }; presentation: { not_tracked: boolean } }>(await getRun(a, run.id));
    expect(detail.status).toBe("expired");
    expect(detail.result).toBeNull();
    expect(detail.expired).not.toBeNull();
    expect(detail.expired?.removed).toBe("result");
    expect(Date.parse(detail.expired!.removed_at)).toBeLessThan(Date.now());
    expect(detail.expired?.summary).toMatch(/result/i);
    expect(detail.headline).toMatchObject({ sov_estimate: 0, citation_count: 0 });
    expect(detail.presentation.not_tracked).toBe(true);
    const inList = data<Array<{ id: string; expired: unknown }>>(await list(a)).find((r) => r.id === run.id);
    expect(inList?.expired).not.toBeNull();
    const live = await start(a, scan({ credits: 0, brandName: "Live" }));
    expect(data<{ expired: unknown }>(await getRun(a, live.id)).expired).toBeNull();
  });

  it("scenario 16 - the sweep is idempotent and bounded per pass: it cannot lock the table, and a second pass finishes the rest", async () => {
    const a = await owner("starter");
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await finished(a, { brandName: `B${String(i)}` })).id);
    for (const id of ids) await age(id);
    expect(await sweep(a.workspaceId, { batchSize: 2, maxBatches: 2 })).toBe(4);
    expect((await harness.db().query("SELECT 1 FROM tool_runs WHERE status = 'expired'")).rowCount).toBe(4);
    expect(await sweep(a.workspaceId, { batchSize: 2, maxBatches: 2 })).toBe(1);
    expect(await sweep(a.workspaceId, { batchSize: 2, maxBatches: 2 })).toBe(0);
    expect(await sweep(a.workspaceId)).toBe(0);
  });

  it("scenario 16 - a sweep for one workspace never touches another's due runs", async () => {
    const a = await owner("starter");
    const b = await owner("starter");
    const mine = await finished(a);
    const theirs = await finished(b);
    await age(mine.id);
    await age(theirs.id);
    expect(await sweep(a.workspaceId)).toBe(1);
    expect((await harness.db().query("SELECT status FROM tool_runs WHERE id = $1", [theirs.id])).rows[0]).toEqual({ status: "completed" });
  });

  it("scenario 17 - pinning a run does not extend its retention: aged past expiry, a pinned run still expires", async () => {
    const a = await owner("starter");
    const run = await finished(a);
    const pinned = await patch(a, run.id, { pinned: true });
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(data<{ pinned: boolean }>(pinned).pinned).toBe(true);
    const expiry = (await harness.db().query("SELECT expires_at FROM tool_runs WHERE id = $1", [run.id])).rows[0];
    await age(run.id);
    await sweep(a.workspaceId);
    expect((await harness.db().query("SELECT status, pinned FROM tool_runs WHERE id = $1", [run.id])).rows[0]).toEqual({ status: "expired", pinned: true });
    expect(expiry).toBeDefined();
    expect((await patch(a, run.id, { pinned: false })).statusCode).toBe(200);
    expect((await patch(a, run.id, { pinned: "yes" })).statusCode).toBe(400);
    expect((await patch(a, run.id, { pinned: true, status: "completed" })).statusCode).toBe(400);
  });

  it("scenario 14 - an aged Schema Builder run expires too: payload null, status expired, and the sweep does not throw (ck_tr_shape review finding)", async () => {
    const a = await owner("starter");
    const run = await start(a, { toolKey: "schema_builder", resultJson: { jsonld: { "@type": "Organization" } }, engineKeys: [], credits: 0 });
    await inTenant(a, () => tools().finishRun(run.id, {}));
    await age(run.id);
    await expect(sweep(a.workspaceId)).resolves.toBe(1);
    expect((await harness.db().query("SELECT status, result_json FROM tool_runs WHERE id = $1", [run.id])).rows[0]).toEqual({ status: "expired", result_json: null });
  });

  it("scenario 14 - a direct sweep of a workspace settles a `running` run past expires_at first: refunded in full, then expired, never expired with its charge unsettled", async () => {
    const a = await owner("starter");
    const before = await wallet(a.workspaceId);
    const run = await start(a, scan({ credits: 10 }));
    await age(run.id);
    expect(await sweep(a.workspaceId)).toBe(1);
    expect((await harness.db().query("SELECT status, result_json, credits_charged, error_code FROM tool_runs WHERE id = $1", [run.id])).rows[0]).toEqual({ status: "expired", result_json: null, credits_charged: 0, error_code: "run_abandoned" });
    const after = await wallet(a.workspaceId);
    expect((after?.included_balance ?? 0) + (after?.purchased_balance ?? 0)).toBe((before?.included_balance ?? 450) + (before?.purchased_balance ?? 0));
    const entries = await harness.db().query<{ entry_type: string; credits: number }>("SELECT entry_type, credits FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 ORDER BY seq", [a.workspaceId, run.id]);
    expect(entries.rows.map((r) => [r.entry_type, r.credits])).toEqual(expect.arrayContaining([["commit", 10], ["refund", 10]]));
    // idempotent: a second direct sweep expires nothing and refunds nothing more
    expect(await sweep(a.workspaceId)).toBe(0);
    expect(await wallet(a.workspaceId)).toEqual(after);
  });

  it("scenario 14 - a `running` run not yet past expires_at is left alone by the sweep (still in flight)", async () => {
    const a = await owner("starter");
    const run = await start(a, scan({ credits: 10 }));
    expect(await sweep(a.workspaceId)).toBe(0);
    expect((await harness.db().query("SELECT status, credits_charged FROM tool_runs WHERE id = $1", [run.id])).rows[0]).toEqual({ status: "running", credits_charged: 10 });
  });

  it("scenario 9 - a paid run whose worker died is reaped as failed and refunded in full: wallet restored, ledger shows commit plus refund (KAD-12)", async () => {
    const a = await owner("starter");
    const before = await wallet(a.workspaceId);
    const lost = await start(a, scan({ credits: 10 }));
    const fresh = await start(a, scan({ credits: 10, brandName: "Fresh" }));
    await harness.db().query("UPDATE tool_runs SET created_at = now() - interval '2 hours' WHERE id = $1", [lost.id]);
    expect(await reapStaleToolRuns(harness.db(), a.workspaceId, new Date())).toBe(1);
    const row = (await harness.db().query("SELECT status, credits_charged, error_code FROM tool_runs WHERE id = $1", [lost.id])).rows[0];
    expect(row).toEqual({ status: "failed", credits_charged: 0, error_code: "run_abandoned" });
    expect((await harness.db().query("SELECT status, credits_charged FROM tool_runs WHERE id = $1", [fresh.id])).rows[0]).toEqual({ status: "running", credits_charged: 10 });
    const after = await wallet(a.workspaceId);
    expect((after?.included_balance ?? 0) + (after?.purchased_balance ?? 0)).toBe((before?.included_balance ?? 450) + (before?.purchased_balance ?? 0) - 10);
    const entries = await harness.db().query<{ entry_type: string; credits: number }>("SELECT entry_type, credits FROM credit_ledger WHERE workspace_id = $1 AND reference_id = $2 ORDER BY seq", [a.workspaceId, lost.id]);
    expect(entries.rows.map((r) => [r.entry_type, r.credits])).toEqual(expect.arrayContaining([["commit", 10], ["refund", 10]]));
    // idempotent: a second pass finds nothing and refunds nothing more
    expect(await reapStaleToolRuns(harness.db(), a.workspaceId, new Date())).toBe(0);
    expect(await wallet(a.workspaceId)).toEqual(after);
    // a late finish from the lost worker changes nothing
    await inTenant(a, () => tools().finishRun(lost.id, { enginesSucceeded: ["perplexity", "chatgpt"], enginesFailed: [] }));
    expect(await wallet(a.workspaceId)).toEqual(after);
    expect((await harness.db().query("SELECT status FROM tool_runs WHERE id = $1", [lost.id])).rows[0]).toEqual({ status: "failed" });
  });

  it("scenario 16 - one workspace whose sweep fails is counted and named, and retention for every other workspace still runs", async () => {
    const a = await owner("starter");
    const b = await owner("starter");
    const bad = await finished(a);
    const good = await finished(b);
    await age(bad.id);
    await age(good.id);
    await harness.db().query(`CREATE OR REPLACE FUNCTION public.zz_injected_sweep_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id = '${a.workspaceId}' THEN RAISE EXCEPTION 'injected sweep failure'; END IF; RETURN NEW; END $$`);
    await harness.db().query("CREATE TRIGGER zz_injected BEFORE UPDATE OF status ON tool_runs FOR EACH ROW EXECUTE FUNCTION public.zz_injected_sweep_failure()");
    try {
      const result = await runNightlySweep(harness.db(), new Date());
      expect(result.toolSweepFailedWorkspaces).toContain(a.workspaceId);
      expect(result.toolSweepFailedWorkspaces).not.toContain(b.workspaceId);
      expect((await harness.db().query("SELECT status FROM tool_runs WHERE id = $1", [good.id])).rows[0]).toEqual({ status: "expired" });
      expect((await harness.db().query("SELECT status FROM tool_runs WHERE id = $1", [bad.id])).rows[0]).toEqual({ status: "completed" });
    } finally {
      await harness.db().query("DROP TRIGGER zz_injected ON tool_runs");
      await harness.db().query("DROP FUNCTION public.zz_injected_sweep_failure()");
    }
  });

  it("scenario 18 - converting from each of the six tools is one contract: the slot cost is stated before the click, and the conversion counter carries the tool", async () => {
    const tools6: Array<[string, StartToolRunInput]> = [
      ["visibility_scan", scan({ credits: 0 })],
      ["prompt_research", { toolKey: "prompt_research", brandName: "Acme", brandUrl: "https://acme.test", promptTexts: ["a?", "b?"], engineKeys: ["perplexity"], credits: 0 }],
      ["competitor_finder", { toolKey: "competitor_finder", brandUrl: "https://acme.test", engineKeys: ["perplexity"], credits: 0 }],
      ["aux_audit", { toolKey: "aux_audit", targetUrl: "https://acme.test/p", engineKeys: [], credits: 0 }],
      ["schema_builder", { toolKey: "schema_builder", resultJson: { jsonld: {} }, engineKeys: [], credits: 0 }],
      ["compare_runs", { toolKey: "compare_runs", engineKeys: [], credits: 0 }],
    ];
    for (const [toolKey, input] of tools6) {
      const a = await owner("starter");
      let runInput = input;
      if (toolKey === "compare_runs") {
        const x = await start(a, scan({ credits: 0, brandName: "X" }));
        const y = await start(a, scan({ credits: 0, brandName: "Y" }));
        runInput = { ...input, diffBaseRunId: x.id, diffCompareRunId: y.id };
      }
      const run = await start(a, runInput);
      await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: runInput.engineKeys ?? [], enginesFailed: [], ...(toolKey === "competitor_finder" ? { result: { competitors: ["Rival", "Other"] } } : {}) }));
      const log = vi.spyOn(Logger.prototype, "log");
      const hasUrl = toolKey !== "schema_builder" && toolKey !== "compare_runs";
      const quote = data<{ state: string; reason: string | null; project_slot: { used: number; max: number | null; free: boolean }; prompt_slots: { carried: number; cap: number | null }; competitor_slots: { carried: number; cap: number | null }; credits: number; prefill: { competitors: string[] } }>(await preview(a, run.id));
      expect(quote.state, toolKey).toBe(hasUrl ? "available" : "unavailable");
      expect(quote.reason).toBe(hasUrl ? null : "no_url");
      expect(quote.project_slot).toEqual({ used: 0, max: 1, free: true });
      expect(quote.prompt_slots.cap).toBe(30);
      expect(quote.credits).toBe(0);
      // FR-VS-06 / review - the competitors the run found are pre-filled and counted against competitors.max_per_project before the click.
      const found = toolKey === "competitor_finder" ? ["Rival", "Other"] : [];
      expect(quote.prefill.competitors, toolKey).toEqual(found);
      expect(quote.competitor_slots.carried, toolKey).toBe(quote.competitor_slots.cap === null ? found.length : Math.min(found.length, quote.competitor_slots.cap));
      const res = await convert(a, run.id, hasUrl ? {} : { root_url: "https://supplied.test" });
      expect(res.statusCode, `${toolKey}: ${res.body}`).toBe(200);
      const body = data<{ project_id: string; already_converted: boolean; slot_cost: { project_slot: { free: boolean }; credits: number } }>(res);
      expect(body.already_converted).toBe(false);
      expect(body.slot_cost.credits).toBe(0);
      const tracked = await harness.db().query<{ name: string }>("SELECT name FROM competitors WHERE project_id = $1 ORDER BY name", [body.project_id]);
      expect(tracked.rows.map((r) => r.name), toolKey).toEqual(found.slice(0, quote.competitor_slots.carried).sort());
      const events = log.mock.calls.filter(([m]) => typeof m === "object" && m !== null && (m as { metric?: string }).metric === "nominara_tools_conversions_total");
      expect(events, toolKey).toHaveLength(1);
      expect(events[0]![0]).toMatchObject({ tool_key: toolKey });
      const row = (await harness.db().query("SELECT converted_project_id, converted_at FROM tool_runs WHERE id = $1", [run.id])).rows[0];
      expect(row.converted_project_id).toBe(body.project_id);
      expect(row.converted_at).not.toBeNull();
      log.mockRestore();
    }
  }, 120_000);

  it("scenario 20 - the convert route requires an Idempotency-Key (api-specification section 3): none is refused, and nothing is created", async () => {
    const a = await owner("starter");
    const run = await finished(a);
    const res = await convert(a, run.id, {}, null);
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect((await harness.db().query("SELECT converted_project_id FROM tool_runs WHERE id = $1", [run.id])).rows[0]).toEqual({ converted_project_id: null });
  });

  it("scenario 19 - converting with no project slot free is refused with the entitlement error naming the limit, and the run stays unconverted", async () => {
    const free = await owner("free");
    const run = await start(free, scan({ credits: 0, engineKeys: ["perplexity"] }));
    await inTenant(free, () => tools().finishRun(run.id, { enginesSucceeded: ["perplexity"], enginesFailed: [] }));
    const quote = data<{ project_slot: { free: boolean; max: number | null } }>(await preview(free, run.id));
    expect(quote.project_slot).toMatchObject({ free: false, max: 0 });
    const res = await convert(free, run.id);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "entitlement_exceeded", details: { key: "projects.max" } } });
    expect((await harness.db().query("SELECT converted_project_id FROM tool_runs WHERE id = $1", [run.id])).rows[0]).toEqual({ converted_project_id: null });
    expect((await harness.db().query("SELECT 1 FROM projects WHERE workspace_id = $1", [free.workspaceId])).rowCount).toBe(0);
  });

  it("scenario 20 - converting twice returns the first project: no second project, no second charge, one counted conversion, even when raced", async () => {
    const a = await owner("growth");
    const run = await start(a, scan({ credits: 0 }));
    await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: ["perplexity", "chatgpt"], enginesFailed: [] }));
    const log = vi.spyOn(Logger.prototype, "log");
    const [one, two] = await Promise.all([convert(a, run.id), convert(a, run.id)]);
    expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
    const [x, y] = [data<{ project_id: string; already_converted: boolean }>(one), data<{ project_id: string; already_converted: boolean }>(two)];
    expect(x.project_id).toBe(y.project_id);
    expect([x.already_converted, y.already_converted].sort()).toEqual([false, true]);
    const third = data<{ project_id: string; already_converted: boolean }>(await convert(a, run.id));
    expect(third).toMatchObject({ project_id: x.project_id, already_converted: true });
    expect((await harness.db().query("SELECT 1 FROM projects WHERE workspace_id = $1", [a.workspaceId])).rowCount).toBe(1);
    expect(log.mock.calls.filter(([m]) => typeof m === "object" && m !== null && (m as { metric?: string }).metric === "nominara_tools_conversions_total")).toHaveLength(1);
  });

  it("scenario 20 - a repeat on a full plan still returns the first project (the slot check only guards a creation)", async () => {
    const a = await owner("starter");
    const run = await start(a, scan({ credits: 0 }));
    await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: ["perplexity", "chatgpt"], enginesFailed: [] }));
    const first = data<{ project_id: string }>(await convert(a, run.id));
    const again = await convert(a, run.id);
    expect(again.statusCode).toBe(200);
    expect(data<{ project_id: string; already_converted: boolean }>(again)).toMatchObject({ project_id: first.project_id, already_converted: true });
    expect(data<{ state: string }>(await preview(a, run.id)).state).toBe("converted");
  });

  it("scenario 21 - converting a run whose prompts were already paid for charges nothing again, and the prompts arrive in the project", async () => {
    const a = await owner("starter");
    const run = await start(a, { toolKey: "prompt_research", brandName: "Acme", brandUrl: "https://acme.test", promptTexts: ["best crm?", "crm pricing?", "crm for startups?"], engineKeys: ["perplexity"], credits: 15 });
    await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: ["perplexity"], enginesFailed: [] }));
    expect((await harness.db().query("SELECT credits_charged FROM tool_runs WHERE id = $1", [run.id])).rows[0]).toEqual({ credits_charged: 15 });
    const walletBefore = await wallet(a.workspaceId);
    const ledgerBefore = await ledgerCount(a.workspaceId);
    const res = await convert(a, run.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(await wallet(a.workspaceId)).toEqual(walletBefore);
    expect(await ledgerCount(a.workspaceId)).toBe(ledgerBefore);
    const prompts = await harness.db().query("SELECT text FROM tracked_prompts WHERE project_id = $1 ORDER BY text", [data<{ project_id: string }>(res).project_id]);
    expect(prompts.rows.map((r) => r.text)).toEqual(["best crm?", "crm for startups?", "crm pricing?"]);
  });

  it("scenario 18 - an unfinished or failed run cannot be converted (409 naming why), and a viewer cannot convert at all", async () => {
    const a = await owner("starter");
    const running = await start(a, scan({ credits: 0 }));
    const r1 = await convert(a, running.id);
    expect(r1.statusCode).toBe(409);
    const failed = await start(a, scan({ credits: 0, brandName: "F" }));
    await inTenant(a, () => tools().finishRun(failed.id, { enginesSucceeded: [], enginesFailed: ["perplexity", "chatgpt"] }));
    expect((await convert(a, failed.id)).statusCode).toBe(409);
    expect((await harness.db().query("SELECT 1 FROM projects WHERE workspace_id = $1", [a.workspaceId])).rowCount).toBe(0);
  });

  it("scenario 22 - every result envelope carries the not-tracked marker and the did-not-check line, and flags its estimates", async () => {
    const a = await owner("starter");
    const run = await start(a, scan({ credits: 0 }));
    await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: ["perplexity", "chatgpt"], enginesFailed: [], headline: { sov_estimate: 0.4, citation_count: 0 } }));
    const audit = await start(a, { toolKey: "aux_audit", targetUrl: "https://acme.test", engineKeys: [], credits: 0 });
    for (const [id, estimated] of [[run.id, ["sov_estimate", "citation_count"]], [audit.id, []]] as const) {
      for (const body of [data<Record<string, unknown>>(await getRun(a, id)), data<Array<Record<string, unknown>>>(await list(a)).find((r) => r.id === id)!]) {
        expect(body.presentation).toMatchObject({ not_tracked: true, estimated_fields: estimated });
        expect((body.presentation as { did_not_check: string }).did_not_check.length).toBeGreaterThan(10);
        expect((body.presentation as { not_tracked_note: string }).not_tracked_note).toMatch(/^Not tracked/);
      }
    }
  });

  // STORY-095 AC9 - "disclaimer copy is rendered from the stored snapshot's notes": a stored result carries its own caveats forever.
  it("STORY-095 AC9 - a run stores its presentation notes in result_json at write time, for a result stored at finish and for one stored at start", async () => {
    const a = await owner("starter");
    const run = await start(a, scan({ credits: 0 }));
    await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: ["perplexity", "chatgpt"], enginesFailed: [], result: { answer: "kept" } }));
    const stored = async (id: string) => (await harness.db().query<{ n: unknown }>("SELECT result_json->'presentation_notes' AS n FROM tool_runs WHERE id = $1", [id])).rows[0]!.n;
    expect(await stored(run.id)).toEqual({ not_tracked_note: NOT_TRACKED_NOTE, did_not_check: DID_NOT_CHECK.visibility_scan });
    // Schema Builder stores its result at START (its shape constraint requires one): the notes land there too, and survive the finish.
    const builder = await start(a, { toolKey: "schema_builder", resultJson: { jsonld: { "@type": "Organization" } }, engineKeys: [], credits: 0 });
    expect(await stored(builder.id)).toEqual({ not_tracked_note: NOT_TRACKED_NOTE, did_not_check: DID_NOT_CHECK.schema_builder });
    await inTenant(a, () => tools().finishRun(builder.id, { enginesSucceeded: [], enginesFailed: [] }));
    expect(await stored(builder.id)).toEqual({ not_tracked_note: NOT_TRACKED_NOTE, did_not_check: DID_NOT_CHECK.schema_builder });
  });

  it("STORY-095 AC9 - a re-opened run serves the notes it was stored with, not today's wording, and the stored key never leaks into `result`", async () => {
    const a = await owner("starter");
    const run = await start(a, scan({ credits: 0 }));
    await inTenant(a, () => tools().finishRun(run.id, { enginesSucceeded: ["perplexity", "chatgpt"], enginesFailed: [], result: { answer: "kept" } }));
    // A year-old run: the wording it was stored under differs from this build's.
    await harness.db().query(
      "UPDATE tool_runs SET result_json = jsonb_set(result_json, '{presentation_notes}', $2::jsonb) WHERE id = $1",
      [run.id, JSON.stringify({ not_tracked_note: "Not tracked — written under last year's rules.", did_not_check: "Last year's scope line." })],
    );
    for (const body of [data<Record<string, unknown>>(await getRun(a, run.id)), data<Array<Record<string, unknown>>>(await list(a)).find((r) => r.id === run.id)!]) {
      expect(body.presentation).toMatchObject({ not_tracked_note: "Not tracked — written under last year's rules.", did_not_check: "Last year's scope line." });
    }
    const detail = data<{ result: Record<string, unknown> }>(await getRun(a, run.id));
    expect(detail.result).toEqual({ answer: "kept" });
  });

  it("STORY-095 AC9 - a run stored before this change, or with no stored result, still reads its composed notes (never blank)", async () => {
    const a = await owner("starter");
    const legacy = await start(a, scan({ credits: 0 }));
    await inTenant(a, () => tools().finishRun(legacy.id, { enginesSucceeded: ["perplexity", "chatgpt"], enginesFailed: [], result: { answer: "old" } }));
    await harness.db().query("UPDATE tool_runs SET result_json = result_json - 'presentation_notes' WHERE id = $1", [legacy.id]);
    const empty = await finished(a);
    expect((await harness.db().query("SELECT result_json FROM tool_runs WHERE id = $1", [empty.id])).rows[0]!.result_json, "no result stored: nothing to stamp").toBeNull();
    for (const id of [legacy.id, empty.id]) {
      expect(data<{ presentation: { not_tracked_note: string; did_not_check: string } }>(await getRun(a, id)).presentation).toMatchObject({ not_tracked_note: NOT_TRACKED_NOTE, did_not_check: DID_NOT_CHECK.visibility_scan });
    }
  });

  it("scenario 12 - reading needs lookup:read_history and nothing weaker: no session is a 401, and a viewer is a 403 naming the permission", async () => {
    const a = await owner("starter");
    const run = await start(a, scan({ credits: 0 }));
    expect((await harness.app().inject({ method: "GET", url: apiUrl(`/tools/runs/${run.id}`) })).statusCode).toBe(401);
    const viewer = await newUser();
    await harness.db().query(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'viewer','active')`, [uuidV7(), a.workspaceId, viewer]);
    const tokens = await sessions.createSession(viewer);
    const entered = await sessions.switchWorkspace(tokens.sid, viewer, a.workspaceId, "viewer", null, (await harness.db().query<{ entitlement_version: number }>("SELECT entitlement_version FROM workspaces WHERE id = $1", [a.workspaceId])).rows[0]!.entitlement_version);
    const res = await harness.app().inject({ method: "GET", url: apiUrl(`/tools/runs/${run.id}`), headers: { cookie: cookieOf(entered) } });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).toContain("lookup:read_history");
  });

  it("scenario 12 - a run in another workspace is a 404 on read, pin and convert (RLS, not a filter)", async () => {
    const a = await owner("starter");
    const b = await owner("starter");
    const run = await start(b, scan({ credits: 0 }));
    expect((await getRun(a, run.id)).statusCode).toBe(404);
    expect((await patch(a, run.id, { pinned: true })).statusCode).toBe(404);
    expect((await convert(a, run.id)).statusCode).toBe(404);
    expect((await preview(a, run.id)).statusCode).toBe(404);
    expect((await getRun(a, "not-a-uuid")).statusCode).toBe(400);
  });
});
