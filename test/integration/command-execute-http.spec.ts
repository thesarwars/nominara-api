import { Pool } from "pg";
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

// STORY-085 (decisions 78c, 79) - POST /v1/command/execute and GET /v1/command/entities through the REAL ApiModule:
// every guard, the tenant transaction, the idempotency / credit / audit interceptors, the problem filter. The unit
// specs cannot see the credit-guard path (it runs before any handler) or RLS; this one does.
//
// Own Valkeys, as deep-scan-zero-scope-http.spec.ts: a successful deep scan enqueues cells and must not touch the
// developer's local services. `captureReadyEngineKeys` is mocked the same way: no engine is capture-ready before STORY-001.

const capture = vi.hoisted(() => ({ ready: [] as string[] }));
vi.mock("../../src/lib/engines/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/engines/registry.js")>();
  return { ...actual, captureReadyEngineKeys: () => capture.ready };
});

const PRICE = 200;
const ENGINE_KEY = "perplexity";

describe("STORY-085 · the command bar's execute and entity index, over HTTP", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({ env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }) });
  let pool: Pool;
  let sessions: SessionService;

  beforeAll(async () => {
    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop()]);
  });
  beforeEach(() => {
    capture.ready = [ENGINE_KEY];
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    sessions = new SessionService(pool, new MembershipService(new MembershipCacheService()), new InMemoryCacheAdapter());
  });
  afterEach(async () => {
    await pool.end();
  });

  type CookieTokens = Pick<SessionTokens, "accessToken" | "csrfToken">;
  const cookieOf = (tokens: CookieTokens): string => `${ACCESS_COOKIE_NAME}=${tokens.accessToken}; ${CSRF_COOKIE_NAME}=${tokens.csrfToken}`;

  interface Scenario {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly otherProjectId: string;
    readonly owner: CookieTokens;
    readonly entitlementVersion: number;
  }

  async function newUser(): Promise<string> {
    const userId = uuidV7();
    await harness.db().query(`INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`, [userId, `${userId}@example.test`]);
    return userId;
  }

  /** A workspace on `plan` with two projects ("Acme" and "Globex"), the first with active prompts and an engine. */
  async function scenario(options: { plan?: "growth" | "free"; included?: number } = {}): Promise<Scenario> {
    const db = harness.db();
    const userId = await newUser();
    const tokens = await sessions.createSession(userId);
    const created = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      headers: { cookie: cookieOf(tokens), [CSRF_HEADER_NAME]: tokens.csrfToken, "content-type": "application/json" },
      payload: { name: "Acme Inc", org_type: "in_house", region: "us-east-1", timezone: "UTC" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspaceId = (created.json() as { data: { id: string } }).data.id;

    if (options.plan !== "free") {
      const client = await pool.connect();
      try {
        await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
          applyPlanChange(tx, workspaceId, planKeyOnly("growth"), { requestId: "R", operator: "test", reason: "test" }),
        );
      } finally {
        client.release();
      }
    }
    const version = Number((await db.query<{ entitlement_version: number }>(`SELECT entitlement_version FROM workspaces WHERE id = $1`, [workspaceId])).rows[0]!.entitlement_version);
    const owner = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, version);

    const projectId = uuidV7();
    const otherProjectId = uuidV7();
    for (const [id, name, slug] of [[projectId, "Acme", "acme"], [otherProjectId, "Globex", "globex"]] as const) {
      await db.query(
        `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, priority_prompt_limit) VALUES ($1,$2,$3,$4,'https://e.test','e.test',10)`,
        [id, workspaceId, name, slug],
      );
    }
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version, cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ($1,$1,'v','api','1.0.0',86400,'medium','free','active') ON CONFLICT DO NOTHING`,
      [ENGINE_KEY],
    );
    await db.query(`INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count) VALUES ($1,$2,$3,true,1)`, [workspaceId, projectId, ENGINE_KEY]);
    await addPrompts(workspaceId, projectId, 2);
    await db.query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, purchased_balance, reserved, cycle_start, cycle_end)
       VALUES ($1, $2, 0, 0, (now() AT TIME ZONE 'UTC')::date, (now() AT TIME ZONE 'UTC')::date + 30)
       ON CONFLICT (workspace_id) DO UPDATE SET included_balance = $2, reserved = 0`,
      [workspaceId, options.included ?? 2_400],
    );
    return { workspaceId, projectId, otherProjectId, owner, entitlementVersion: version };
  }

  async function addPrompts(workspaceId: string, projectId: string, count: number, label = "best crm number"): Promise<void> {
    await harness.db().query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       SELECT gen_random_uuid(), $1, $2, $4::text || ' ' || n, sha256(($4::text || ' ' || n)::bytea), 'recommendation', 'consideration', false, 'active'
         FROM generate_series(1, $3) AS n`,
      [workspaceId, projectId, count, label],
    );
  }

  /** A second member of `s`'s workspace, entered with that role (and scope). */
  async function member(s: Scenario, role: "viewer" | "manager" | "analyst", scope: readonly string[] | null = null): Promise<CookieTokens> {
    const userId = await newUser();
    await harness.db().query(`INSERT INTO workspace_members (workspace_id, user_id, role, status, project_scope) VALUES ($1,$2,$3,'active',$4)`, [s.workspaceId, userId, role, scope]);
    const tokens = await sessions.createSession(userId);
    return sessions.switchWorkspace(tokens.sid, userId, s.workspaceId, role, scope, s.entitlementVersion);
  }

  const headers = (who: CookieTokens, extra: Record<string, string> = {}): Record<string, string> => ({
    cookie: cookieOf(who),
    [CSRF_HEADER_NAME]: who.csrfToken,
    "content-type": "application/json",
    ...extra,
  });

  interface ParseData {
    parse_id: string;
    cached: boolean;
    entities: Array<{ id: string }>;
    actions: Array<{ action_id: string; disabled_reason: string | null; credit_estimate: { credits: number } | null; handling: string }>;
  }

  async function parse(who: CookieTokens, query: string): Promise<ParseData> {
    const res = await harness.app().inject({ method: "POST", url: apiUrl("/command/parse"), headers: headers(who), payload: { query } });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { data: ParseData }).data;
  }

  function execute(who: CookieTokens, body: Record<string, unknown>, over: { key?: string; confirmed?: number | null } = {}) {
    const confirmed = over.confirmed === undefined ? PRICE : over.confirmed;
    return harness.app().inject({
      method: "POST",
      url: apiUrl("/command/execute"),
      headers: headers(who, { "idempotency-key": over.key ?? uuidV7(), ...(confirmed === null ? {} : { "x-nominara-confirmed-credits": String(confirmed) }) }),
      payload: body,
    });
  }

  async function books(s: Scenario) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const db = harness.db();
    const ledger = await db.query(`SELECT entry_type, action_code, credits FROM credit_ledger WHERE workspace_id = $1 ORDER BY seq`, [s.workspaceId]);
    const wallet = await db.query(`SELECT included_balance, purchased_balance, reserved FROM credit_wallets WHERE workspace_id = $1`, [s.workspaceId]);
    const count = async (sql: string): Promise<number> => (await db.query<{ n: number }>(sql, [s.workspaceId])).rows[0]!.n;
    return {
      ledger: ledger.rows,
      wallet: wallet.rows[0],
      runs: await count(`SELECT count(*)::int AS n FROM capture_runs WHERE workspace_id = $1`),
      tasks: await count(`SELECT count(*)::int AS n FROM tasks WHERE workspace_id = $1`),
      projects: await count(`SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1`),
      members: await count(`SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1`),
    };
  }

  const auditRows = async (s: Scenario, action: string) =>
    (await harness.db().query<{ after_state: Record<string, unknown>; resource_type: string }>(`SELECT after_state, resource_type FROM audit_log WHERE workspace_id = $1 AND action = $2 ORDER BY seq`, [s.workspaceId, action])).rows;

  it("STORY-085 #16/#19 · a deep scan through the bar: confirmed price, reserve then commit, one run, one audit row marking the command bar", async () => {
    const s = await scenario();
    const p = await parse(s.owner, "run deep scan on acme");
    expect(p.actions[0]).toMatchObject({ handling: "execute", disabled_reason: null, credit_estimate: { credits: PRICE } });
    expect(p.entities).toEqual([expect.objectContaining({ id: s.projectId })]);

    const res = await execute(s.owner, { parse_id: p.parse_id, action_id: p.actions[0]!.action_id });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { data: unknown }).data).toMatchObject({ outcome: "executed", intent: "run_deep_scan", resource: { type: "run" }, target: null, credits_charged: PRICE });

    const after = await books(s);
    expect((after.ledger as Array<{ entry_type: string; action_code: string; credits: number }>).map((r) => [r.entry_type, r.action_code, r.credits])).toEqual([
      ["reserve", "manual_scan", PRICE],
      ["commit", "manual_scan", PRICE],
    ]);
    expect(after.wallet).toEqual({ included_balance: 2_400 - PRICE, purchased_balance: 0, reserved: 0 });
    expect(after.runs).toBe(1);

    const rows = await auditRows(s, "command.executed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after_state).toMatchObject({ origin: "command_bar", intent: "run_deep_scan", outcome: "executed", credits_charged: PRICE });
    expect(JSON.stringify(rows[0]!.after_state)).not.toContain("acme");
  });

  it("STORY-085 #14 · replay of the used id under a NEW idempotency key is refused 409 and spends nothing more", async () => {
    const s = await scenario();
    const p = await parse(s.owner, "run deep scan on acme");
    const body = { parse_id: p.parse_id, action_id: p.actions[0]!.action_id };
    expect((await execute(s.owner, body)).statusCode).toBe(200);
    const settled = await books(s);

    const replay = await execute(s.owner, body);
    expect(replay.statusCode, replay.body).toBe(409);
    expect(await books(s), "no second reservation, no second run").toEqual(settled);
  });

  it("STORY-085 #14 · the SAME idempotency key replays the first answer without a second debit", async () => {
    const s = await scenario();
    const p = await parse(s.owner, "run deep scan on acme");
    const body = { parse_id: p.parse_id, action_id: p.actions[0]!.action_id };
    const key = uuidV7();
    const first = await execute(s.owner, body, { key });
    const again = await execute(s.owner, body, { key });
    expect(first.statusCode, first.body).toBe(200);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual(first.json());
    const after = await books(s);
    expect(after.runs).toBe(1);
    expect(after.ledger).toHaveLength(2);
  });

  it("STORY-085 #16 · a changed figure is 409 price_changed with BOTH figures, nothing reserved, and the parse id is still good for the re-confirmed retry", async () => {
    const s = await scenario();
    const p = await parse(s.owner, "run deep scan on acme");
    const body = { parse_id: p.parse_id, action_id: p.actions[0]!.action_id };
    const before = await books(s);

    const stale = await execute(s.owner, body, { confirmed: PRICE - 100 });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "price_changed", details: { shown: PRICE - 100, recomputed: PRICE } } });
    expect(await books(s)).toEqual(before);

    const retry = await execute(s.owner, body, { confirmed: PRICE });
    expect(retry.statusCode, retry.body).toBe(200);
  });

  it("STORY-085 #13 · no confirmed-credits header on a priced action is 400, nothing reserved, and the id survives; a task needs no header", async () => {
    const s = await scenario();
    const p = await parse(s.owner, "run deep scan on acme");
    const body = { parse_id: p.parse_id, action_id: p.actions[0]!.action_id };
    const before = await books(s);
    const missing = await execute(s.owner, body, { confirmed: null });
    expect(missing.statusCode, missing.body).toBe(400);
    expect(await books(s)).toEqual(before);
    expect((await execute(s.owner, body)).statusCode).toBe(200);
  });

  it("STORY-085 #13 · a missing parse_id or an unknown key is 400; an id never issued is 409", async () => {
    const s = await scenario();
    expect((await execute(s.owner, { action_id: "run_deep_scan" })).statusCode).toBe(400);
    expect((await execute(s.owner, { parse_id: uuidV7(), action_id: "run_deep_scan", extra: 1 })).statusCode).toBe(400);
    expect((await execute(s.owner, { parse_id: uuidV7(), action_id: "run_deep_scan" })).statusCode).toBe(409);
  });

  it("STORY-085 #17 · a viewer sees the action DISABLED with the permission, and execute is 403 naming it, with no reservation and no run", async () => {
    const s = await scenario();
    const viewer = await member(s, "viewer");
    const p = await parse(viewer, "run deep scan on acme");
    expect(p.actions[0]).toMatchObject({ disabled_reason: "forbidden:tracking:trigger" });
    const before = await books(s);

    const res = await execute(viewer, { parse_id: p.parse_id, action_id: p.actions[0]!.action_id });
    expect(res.statusCode, res.body).toBe(403);
    expect(JSON.stringify(res.json())).toContain("tracking:trigger");
    expect(await books(s)).toEqual(before);
  });

  it("STORY-085 #18 · a plan that sells no deep-scan price: disabled with feature_not_in_plan, and execute is 403 feature_not_in_plan with nothing reserved", async () => {
    const s = await scenario({ plan: "free" });
    const p = await parse(s.owner, "run deep scan on acme");
    expect(p.actions[0]).toMatchObject({ disabled_reason: "feature_not_in_plan:deep_scan.credits", credit_estimate: null });
    const before = await books(s);
    const res = await execute(s.owner, { parse_id: p.parse_id, action_id: p.actions[0]!.action_id }, { confirmed: 0 });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "feature_not_in_plan" } });
    expect((await books(s)).runs).toBe(before.runs);
    expect((await books(s)).ledger).toEqual(before.ledger);
  });

  // The bar is never a privilege path: a deep scan through it draws on the SAME `project_runs` allowance as POST /projects/{id}/runs (api-specification
  // section 12: 6/hour per user, 30/hour per workspace, burst 2), on top of `command_execute`. Without it the bar allowed 20 scans a minute.
  const directRun = (who: CookieTokens, projectId: string, confirmed: number | null = PRICE) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl(`/projects/${projectId}/runs`),
      headers: headers(who, { "idempotency-key": uuidV7(), ...(confirmed === null ? {} : { "x-nominara-confirmed-credits": String(confirmed) }) }),
      payload: {},
    });

  it("STORY-085 review round 1 · project_runs exhausted through the DIRECT route: the bar's deep scan is 429 too, nothing reserved, no run, the parse id not spent", async () => {
    const s = await scenario();
    const p = await parse(s.owner, "run deep scan on acme");
    const body = { parse_id: p.parse_id, action_id: p.actions[0]!.action_id };
    // Missing confirmed header: a 400 AFTER the rate limiter has counted the request, so this drains the allowance without spending a credit.
    let drained = false;
    for (let i = 0; i < 10 && !drained; i += 1) drained = (await directRun(s.owner, s.projectId, null)).statusCode === 429;
    expect(drained, "the direct route reached its project_runs limit").toBe(true);
    const before = await books(s);

    const res = await execute(s.owner, body);
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(res.headers["retry-after"]).toBeDefined();
    expect(await books(s), "nothing reserved, no run").toEqual(before);
    // A 429 is not a spent id: asking again is still the rate limit, not "unknown or already used".
    expect((await execute(s.owner, body)).statusCode).toBe(429);
  });

  it("STORY-085 review round 1 · bar scans and direct scans share one allowance: after two bar scans (burst 2) the third is 429, and so is the direct route", async () => {
    const s = await scenario();
    for (let i = 0; i < 2; i += 1) {
      const p = await parse(s.owner, "run deep scan on acme");
      const res = await execute(s.owner, { parse_id: p.parse_id, action_id: p.actions[0]!.action_id });
      expect(res.statusCode, `bar scan ${String(i + 1)}: ${res.body}`).toBe(200);
    }
    const settled = await books(s);
    const third = await parse(s.owner, "run deep scan on acme");
    const blocked = await execute(s.owner, { parse_id: third.parse_id, action_id: third.actions[0]!.action_id });
    expect(blocked.statusCode, blocked.body).toBe(429);
    expect(await books(s)).toEqual(settled);
    expect((await directRun(s.owner, s.projectId)).statusCode).toBe(429);
  });

  it("STORY-085 review round 1 · a task through the bar does not draw on project_runs", async () => {
    const s = await scenario();
    for (let i = 0; i < 4; i += 1) {
      const p = await parse(s.owner, `create a task called Task ${String(i)}`);
      const res = await execute(s.owner, { parse_id: p.parse_id, action_id: p.actions[0]!.action_id, project_id: s.projectId }, { confirmed: null });
      expect(res.statusCode, res.body).toBe(200);
    }
    const p = await parse(s.owner, "run deep scan on acme");
    expect((await execute(s.owner, { parse_id: p.parse_id, action_id: p.actions[0]!.action_id })).statusCode).toBe(200);
  });

  it("STORY-085 review round 1 (FR-CMD-05) · on Free the plan-limited intents come back DISABLED with the reason: projects.max, seats.max, the PDF export; on Growth they are enabled", async () => {
    const free = await scenario({ plan: "free" });
    const reasons = async (s: Scenario) => ({
      project: (await parse(s.owner, "create a project called Acme GmbH")).actions[0]!.disabled_reason,
      invite: (await parse(s.owner, "invite jo@example.com as viewer")).actions[0]!.disabled_reason,
      report: (await parse(s.owner, "build a report for acme")).actions[0]!.disabled_reason,
    });
    expect(await reasons(free)).toEqual({ project: "entitlement_exceeded:projects.max", invite: "entitlement_exceeded:seats.max", report: "feature_not_in_plan:exports.pdf_per_cycle" });
    const growth = await scenario();
    expect(await reasons(growth)).toEqual({ project: null, invite: null, report: null });
  });

  it("STORY-085 · a parse id is bound to its user: a colleague presenting it is 409 and the owner can still use it", async () => {
    const s = await scenario();
    const colleague = await member(s, "analyst");
    const p = await parse(s.owner, "run deep scan on acme");
    const body = { parse_id: p.parse_id, action_id: p.actions[0]!.action_id };
    expect((await execute(colleague, body)).statusCode).toBe(409);
    expect((await execute(s.owner, body)).statusCode).toBe(200);
  });

  it("STORY-085 · a parse id is bound to its workspace: another workspace's owner is 409", async () => {
    const a = await scenario();
    const b = await scenario();
    const p = await parse(a.owner, "run deep scan on acme");
    const res = await execute(b.owner, { parse_id: p.parse_id, action_id: p.actions[0]!.action_id });
    expect(res.statusCode, res.body).toBe(409);
    expect((await books(b)).runs).toBe(0);
  });

  it("STORY-085 · a task through the bar: created on the chosen project, free (no header, no ledger row), audited as the command bar", async () => {
    const s = await scenario();
    const p = await parse(s.owner, "Create a task called Fix Schema Markup on iOS.");
    expect(p.actions[0]).toMatchObject({ handling: "execute", credit_estimate: null });
    const res = await execute(s.owner, { parse_id: p.parse_id, action_id: p.actions[0]!.action_id, project_id: s.projectId }, { confirmed: null });
    expect(res.statusCode, res.body).toBe(200);
    const data = (res.json() as { data: { resource: { type: string; id: string }; credits_charged: number } }).data;
    expect(data).toMatchObject({ resource: { type: "task" }, credits_charged: 0 });
    const task = await harness.db().query(`SELECT project_id, origin, title FROM tasks WHERE id = $1`, [data.resource.id]);
    expect(task.rows[0]).toMatchObject({ project_id: s.projectId, origin: "manual", title: "Fix Schema Markup on iOS" });
    expect((await books(s)).ledger.filter((r) => (r as { action_code: string }).action_code === "manual_scan")).toEqual([]);
    expect((await auditRows(s, "command.executed"))[0]!.after_state).toMatchObject({ origin: "command_bar", intent: "create_task" });
  });

  // command_execute's burst is 5 per user (api-specification.md section 12), so each workspace's owner opens three screens here.
  const OPEN_SCREEN_CASES = [
    [
      ["run visibility scan on acme", "tools.visibility_scan"],
      ["run prompt research for acme", "tools.prompt_research"],
      ["run competitor finder for acme", "tools.competitor_finder"],
    ],
    [
      ["run aux audit for acme", "tools.aux_audit"],
      ["create a new project called newco", "projects.new"],
      ["invite jo@example.com as viewer", "members.invite"],
    ],
  ] as const;

  it.each(OPEN_SCREEN_CASES)("STORY-085 · tool runs, create project and invite only OPEN a screen (%j): no run, task, project or member, and no ledger row", async (...cases) => {
    const s = await scenario();
    const before = await books(s);
    for (const [phrase, screen] of cases) {
      const p = await parse(s.owner, phrase);
      const res = await execute(s.owner, { parse_id: p.parse_id, action_id: p.actions[0]!.action_id }, { confirmed: null });
      expect(res.statusCode, `${phrase}: ${res.body}`).toBe(200);
      expect((res.json() as { data: unknown }).data).toMatchObject({ outcome: "open_screen", resource: null, credits_charged: 0, target: { screen } });
    }
    expect(await books(s)).toEqual(before);
    const rows = await auditRows(s, "command.executed");
    expect(rows).toHaveLength(cases.length);
    for (const row of rows) expect(row.after_state).toMatchObject({ origin: "command_bar", outcome: "open_screen" });
  });

  it("STORY-085 · entities bind AFTER the cache: a scoped manager sharing the workspace's cached parse never gets a project outside their scope, and cannot execute on it", async () => {
    const s = await scenario();
    const scoped = await member(s, "manager", [s.otherProjectId]);

    const owner = await parse(s.owner, "run deep scan on acme");
    expect(owner.cached).toBe(false);
    expect(owner.entities.map((e) => e.id)).toEqual([s.projectId]);

    const mine = await parse(scoped, "run deep scan on acme");
    expect(mine.cached, "the grammar result IS shared").toBe(true);
    expect(mine.entities, "the binding is not").toEqual([]);

    const before = await books(s);
    const forced = await execute(scoped, { parse_id: mine.parse_id, action_id: mine.actions[0]!.action_id, project_id: s.projectId });
    expect(forced.statusCode, forced.body).toBe(403);
    expect(forced.json()).toMatchObject({ error: { code: "project_out_of_scope" } });
    expect(await books(s)).toEqual(before);
  });

  it("STORY-085 · two projects answering to one name bind neither (the server never guesses which to spend on)", async () => {
    const s = await scenario();
    await harness.db().query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'ACME','acme-two','https://f.test','f.test')`,
      [uuidV7(), s.workspaceId],
    );
    expect((await parse(s.owner, "run deep scan on acme")).entities).toEqual([]);
  });

  it("STORY-085 #11 · a parse of every phrase still changes no table's content but audit_log", async () => {
    const s = await scenario();
    const db = harness.db();
    const digest = async (): Promise<Record<string, string>> => {
      const tables = await db.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'audit_log' ORDER BY 1`);
      const out: Record<string, string> = {};
      for (const { tablename } of tables.rows) {
        out[tablename] = (await db.query<{ d: string }>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d FROM "${tablename}" t`)).rows[0]!.d;
      }
      return out;
    };
    const before = await digest();
    for (const phrase of ["run deep scan on acme", "create a task to fix schema markup", "invite jo@example.com as viewer", "go to settings", "order me a pizza", "create new"]) {
      await parse(s.owner, phrase);
    }
    expect(await digest()).toEqual(before);
  });

  describe("GET /command/entities", () => {
    it("STORY-085 AC2 · returns the workspace's projects, competitors, prompts and tool runs", async () => {
      const s = await scenario();
      const db = harness.db();
      await db.query(`INSERT INTO competitors (id, workspace_id, project_id, name) VALUES (gen_random_uuid(), $1, $2, 'Rival Co')`, [s.workspaceId, s.projectId]);
      await db.query(
        `INSERT INTO tool_runs (id, workspace_id, tool_key, brand_name, brand_url, input_hash, expires_at) VALUES (gen_random_uuid(), $1, 'competitor_finder', 'Acme Brand', 'https://acme.test', sha256('x'::bytea), now() + interval '30 days')`,
        [s.workspaceId],
      );
      const res = await harness.app().inject({ method: "GET", url: apiUrl("/command/entities"), headers: headers(s.owner) });
      expect(res.statusCode, res.body).toBe(200);
      const data = (res.json() as { data: { entities: Array<{ kind: string; name: string; project_id: string | null }>; limit_per_kind: number; truncated: Record<string, boolean> } }).data;
      const kinds = (k: string) => data.entities.filter((e) => e.kind === k);
      expect(kinds("project").map((e) => e.name).sort()).toEqual(["Acme", "Globex"]);
      expect(kinds("competitor")).toEqual([expect.objectContaining({ name: "Rival Co", project_id: s.projectId })]);
      expect(kinds("prompt")).toHaveLength(2);
      expect(kinds("tool_run")).toEqual([expect.objectContaining({ name: "Acme Brand", project_id: null })]);
      expect(data.truncated).toEqual({ project: false, competitor: false, prompt: false, tool_run: false });
    });

    it("STORY-085 #3 · is BOUNDED: 205 prompts ship 200 and say truncated; nothing else is cut", async () => {
      const s = await scenario();
      await addPrompts(s.workspaceId, s.projectId, 203, "extra prompt");
      const res = await harness.app().inject({ method: "GET", url: apiUrl("/command/entities"), headers: headers(s.owner) });
      const data = (res.json() as { data: { entities: Array<{ kind: string }>; limit_per_kind: number; truncated: Record<string, boolean> } }).data;
      expect(data.limit_per_kind).toBe(200);
      expect(data.entities.filter((e) => e.kind === "prompt")).toHaveLength(200);
      expect(data.truncated).toMatchObject({ prompt: true, project: false });
    });

    it("STORY-085 AC2 · a scoped manager's index holds only their projects' entities; a viewer gets no tool runs; a zero-scope manager sees nothing project-owned", async () => {
      const s = await scenario();
      const db = harness.db();
      await db.query(`INSERT INTO tool_runs (id, workspace_id, tool_key, brand_name, brand_url, input_hash, expires_at) VALUES (gen_random_uuid(), $1, 'competitor_finder', 'Acme Brand', 'https://acme.test', sha256('x'::bytea), now() + interval '30 days')`, [s.workspaceId]);
      const read = async (who: CookieTokens) => {
        const res = await harness.app().inject({ method: "GET", url: apiUrl("/command/entities"), headers: headers(who) });
        expect(res.statusCode, res.body).toBe(200);
        return (res.json() as { data: { entities: Array<{ kind: string; id: string; name: string }> } }).data.entities;
      };

      const scoped = await read(await member(s, "manager", [s.otherProjectId]));
      expect(scoped.filter((e) => e.kind === "project").map((e) => e.id)).toEqual([s.otherProjectId]);
      expect(scoped.filter((e) => e.kind === "prompt")).toEqual([]);

      const viewer = await read(await member(s, "viewer"));
      expect(viewer.filter((e) => e.kind === "tool_run")).toEqual([]);
      expect(viewer.filter((e) => e.kind === "project")).toHaveLength(2);

      const none = await read(await member(s, "manager", []));
      expect(none.filter((e) => e.kind !== "tool_run")).toEqual([]);
    });
  });
});
