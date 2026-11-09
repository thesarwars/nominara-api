import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { ToolsService, type StartToolRunInput } from "../../src/modules/tools/tools.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { auxAuditToolResultSchema, COMPARE_RUNS_STATEMENT, visibilityScanResultSchema, type CompareRunsResponse } from "../../contracts/tools/index.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-084 - Compare Runs through the REAL ApiModule. Scenario numbers are the story's Test scenarios table.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

interface Actor {
  readonly workspaceId: string;
  readonly userId: string;
  readonly cookie: string;
  readonly csrf: string;
}

const ENGINES = ["perplexity", "chatgpt"];

function engineRow(engine: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine, cache_layer: "none", captured_at: "2026-11-01T10:00:00.000Z", latency_ms: 900, brand_present: true, rank_position: 2, sov: 0.4,
    sentiment: { label: "positive", score: 0.5 }, citations: [{ slot: 1, domain: "a.test", is_owned: false }], excerpt: "Acme is a solid choice for startups",
    age_ms: 0, estimated: true, ...over,
  };
}
const scanResult = (engines: Record<string, unknown>[]) =>
  visibilityScanResultSchema.parse({ schema_version: 1, sample_statement: "s", one_sample_per_engine: true, engines, engine_failures: [], competitors: [], deadline_reached: false });

function finding(rule_code: string, severity: string, url = "https://acme.test/a"): Record<string, unknown> {
  return {
    consequence: "c", title: `T ${rule_code}`, rule_code, category: "structured_data", severity, url, affected_pages: 1, measured_value: null, threshold_value: null,
    evidence: { selector: null, snippet: null, measured: null, expected: null }, auto_fixable: false, requires_human_review: false, patch: null,
  };
}
const auditResult = (score: number | null, findings: Record<string, unknown>[]) =>
  auxAuditToolResultSchema.parse({
    schema_version: 1, mode: "full", url: "https://acme.test", host: "acme.test", domain_verified: false, scope: "public_surface",
    site_files: { summary: "s", agents: [], files: [], checked_at: "2026-11-01T10:00:00.000Z" },
    audit: {
      score: { value: score, partial: false, label: "l", excluded_weight_points: 0, unmeasured_categories: [], capped: false }, excluded_rules: [], scope_note: null,
      findings, findings_total: findings.length, findings_omitted: 0, patches_included: 0,
      pages: { requested: 1, raw_fetched: 1, rendered_fetched: 0, judged: 1, unreachable: [] },
      charge: { credits: 0, band_label: "b", site_files_included: true, patches_credits: 0 },
    },
  });

describe("STORY-084 · Compare Runs", () => {
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
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.end();
  });

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
  /** A finished (free-priced, for the fixture's sake) stored run. */
  async function stored(a: Actor, input: StartToolRunInput, result: Record<string, unknown> | null, status: { succeeded?: string[]; failed?: string[] } = {}): Promise<string> {
    const run = await inTenant(a, () => tools().startRun({ ...input, credits: 0 }));
    await inTenant(a, () =>
      tools().finishRun(run.id, { enginesSucceeded: status.succeeded ?? input.engineKeys ?? [], enginesFailed: status.failed ?? [], ...(result === null ? {} : { result }) }),
    );
    return run.id;
  }
  const scanInput = (over: Partial<StartToolRunInput> = {}): StartToolRunInput => ({ toolKey: "visibility_scan", brandName: "Acme", queryText: "best crm", engineKeys: ENGINES, credits: 0, ...over });
  const auditInput = (over: Partial<StartToolRunInput> = {}): StartToolRunInput => ({ toolKey: "aux_audit", targetUrl: "https://acme.test", engineKeys: [], credits: 0, ...over });
  const post = (a: Actor, payload: unknown, key: string | null = uuidV7()) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl("/tools/compare-runs"),
      headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }) },
      payload: payload as object,
    });
  const compare = (a: Actor, base: string, other: string) => post(a, { base_run_id: base, compare_run_id: other });
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  const wallet = async (workspaceId: string) =>
    (await harness.db().query("SELECT included_balance, purchased_balance, reserved FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0];
  const count = async (sqlText: string, params: unknown[] = []) => (await harness.db().query<{ n: number }>(sqlText, params)).rows[0]!.n;

  it("scenario 1 - a comparison references both runs by id on its row and copies neither payload", async () => {
    const a = await owner();
    const x = await stored(a, scanInput(), scanResult([engineRow("perplexity"), engineRow("chatgpt")]));
    const y = await stored(a, scanInput(), scanResult([engineRow("perplexity"), engineRow("chatgpt")]));
    const res = await compare(a, x, y);
    expect(res.statusCode, res.body).toBe(200);
    const body = data<CompareRunsResponse>(res);
    const row = (await harness.db().query("SELECT diff_base_run_id, diff_compare_run_id, tool_key, result_json, credits_charged FROM tool_runs WHERE id = $1", [body.id])).rows[0];
    expect(row).toMatchObject({ diff_base_run_id: x, diff_compare_run_id: y, tool_key: "compare_runs", credits_charged: 0 });
    expect(row.result_json).toEqual({ schema_version: 1, compared_tool: "visibility_scan", base_run_id: x, compare_run_id: y });
    expect(JSON.stringify(row.result_json)).not.toContain("Acme is a solid");
  });

  it("scenario 2 - comparable pairs are same workspace, tool and input hash, only completed or partial, served from ix_tr_diff_pairs", async () => {
    const a = await owner();
    const b = await owner();
    const one = await stored(a, scanInput(), scanResult([engineRow("perplexity")]));
    const two = await stored(a, scanInput({ brandName: " ACME " }), scanResult([engineRow("perplexity")]));
    const partial = await stored(a, scanInput(), scanResult([engineRow("perplexity")]), { succeeded: ["perplexity"], failed: ["chatgpt"] });
    await stored(a, scanInput(), null, { succeeded: [], failed: ENGINES }); // failed: not offered
    await stored(a, scanInput({ queryText: "other query" }), scanResult([])); // other input
    await stored(a, auditInput(), auditResult(50, [])); // other tool
    await stored(b, scanInput(), scanResult([])); // other workspace
    const offered = await inTenant(a, () => tools().comparableRuns(one));
    expect(offered.map((r) => r.id).sort()).toEqual([two, partial].sort());
    expect(offered.every((r) => r.status === "completed" || r.status === "partial")).toBe(true);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT id FROM tool_runs WHERE workspace_id = $1 AND tool_key = 'visibility_scan' AND input_hash = (SELECT input_hash FROM tool_runs WHERE id = $2) AND status IN ('completed','partial') ORDER BY created_at DESC`,
        [a.workspaceId, one],
      );
      await client.query("ROLLBACK");
      expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("ix_tr_diff_pairs");
    } finally {
      client.release();
    }
  });

  it("scenario 3 - two different tools are refused, naming the mismatch", async () => {
    const a = await owner();
    const x = await stored(a, scanInput(), scanResult([]));
    const y = await stored(a, auditInput(), auditResult(50, []));
    const res = await compare(a, x, y);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/tool_mismatch.*visibility_scan.*aux_audit/);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE tool_key = 'compare_runs' AND workspace_id = $1", [a.workspaceId])).toBe(0);
  });

  it("scenario 4 - the same tool with different inputs is refused, naming the input that differs", async () => {
    const a = await owner();
    const x = await stored(a, scanInput(), scanResult([]));
    const y = await stored(a, scanInput({ queryText: "best erp" }), scanResult([]));
    const res = await compare(a, x, y);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/input_mismatch.*query_text differ/);
  });

  it("scenario 4 - a tool other than scan and audit is refused with a reason", async () => {
    const a = await owner();
    const x = await stored(a, { toolKey: "prompt_research", promptTexts: ["a?"], engineKeys: ["perplexity"], credits: 0 }, { answer: 1 });
    const y = await stored(a, { toolKey: "prompt_research", promptTexts: ["a?"], engineKeys: ["perplexity"], credits: 0 }, { answer: 2 });
    const res = await compare(a, x, y);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/tool_not_comparable.*prompt_research/);
  });

  it("scenario 4 - the same run twice, an unfinished run, an unknown id and another workspace's run are each refused or 404", async () => {
    const a = await owner();
    const b = await owner();
    const x = await stored(a, scanInput(), scanResult([]));
    expect((await compare(a, x, x)).body).toMatch(/same_run/);
    const running = (await inTenant(a, () => tools().startRun({ ...scanInput() }))).id;
    const unfinished = await compare(a, x, running);
    expect(unfinished.statusCode).toBe(422);
    expect(unfinished.body).toMatch(/run_not_comparable.*running/);
    expect((await compare(a, x, uuidV7())).statusCode).toBe(404);
    const theirs = await stored(b, scanInput(), scanResult([]));
    expect((await compare(a, x, theirs)).statusCode).toBe(404);
  });

  it("scenario 4 - an unknown key or a malformed id is a 400", async () => {
    const a = await owner();
    expect((await post(a, { base_run_id: uuidV7(), compare_run_id: uuidV7(), extra: 1 })).statusCode).toBe(400);
    expect((await post(a, { base_run_id: "nope", compare_run_id: uuidV7() })).statusCode).toBe(400);
  });

  it("scenario 5 - two scans: per-engine deltas and a word-level excerpt diff", async () => {
    const a = await owner();
    const x = await stored(a, scanInput(), scanResult([engineRow("perplexity"), engineRow("chatgpt")]));
    const y = await stored(
      a,
      scanInput(),
      scanResult([engineRow("perplexity", { rank_position: 1, sov: 0.5, excerpt: "Acme is the best choice for startups", citations: [] }), engineRow("chatgpt")]),
    );
    const body = data<CompareRunsResponse>(await compare(a, x, y));
    const perplexity = body.scan!.engines.find((e) => e.engine === "perplexity")!;
    expect(perplexity.delta).toMatchObject({ rank_position: -1, citation_count: -1, brand_presence_changed: false });
    expect(perplexity.excerpt_diff).toContainEqual({ op: "insert", text: "the best" });
    expect(body.audit).toBeNull();
  });

  it("scenario 6 - two audits: resolved, regressed, new, and the score delta", async () => {
    const a = await owner();
    const x = await stored(a, auditInput(), auditResult(60, [finding("R1", "high"), finding("R2", "low")]));
    const y = await stored(a, auditInput(), auditResult(70, [finding("R2", "high"), finding("R4", "info")]));
    const body = data<CompareRunsResponse>(await compare(a, x, y));
    expect(body.compared_tool).toBe("aux_audit");
    expect(body.audit!.score).toEqual({ base: 60, compare: 70, delta: 10 });
    expect(body.audit!.resolved.map((f) => f.rule_code)).toEqual(["R1"]);
    expect(body.audit!.new.map((f) => f.rule_code)).toEqual(["R4"]);
    expect(body.audit!.regressed).toMatchObject([{ rule_code: "R2", severity: "high", base_severity: "low" }]);
    expect(body.scan).toBeNull();
  });

  it("scenario 7 - an engine in one run only is reported added or removed, with no delta", async () => {
    const a = await owner();
    const x = await stored(a, scanInput(), scanResult([engineRow("perplexity"), engineRow("chatgpt")]), { succeeded: ENGINES });
    const y = await stored(a, scanInput(), scanResult([engineRow("perplexity")]), { succeeded: ["perplexity"], failed: ["chatgpt"] });
    const body = data<CompareRunsResponse>(await compare(a, x, y));
    expect(body.scan!.engines.find((e) => e.engine === "chatgpt")).toMatchObject({ presence: "removed", delta: null, compare: null, excerpt_diff: null });
  });

  it("scenario 8 - an expired run cannot be compared; the refusal names the side and when", async () => {
    const a = await owner();
    const x = await stored(a, scanInput(), scanResult([]));
    const y = await stored(a, scanInput(), scanResult([]));
    await harness.db().query("UPDATE tool_runs SET status = 'expired', result_json = NULL, expires_at = '2026-10-01T00:00:00Z' WHERE id = $1", [y]);
    const res = await compare(a, x, y);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/run_expired: the compare run \([^)]*\) expired at 2026-10-01T00:00:00\.000Z/);
    expect(res.body).not.toMatch(/the base run/);
    // an expiry the sweep has not reached yet (window passed, status not yet flipped) refuses just the same
    await harness.db().query("UPDATE tool_runs SET expires_at = '2026-10-02T00:00:00Z' WHERE id = $1", [x]);
    expect((await compare(a, x, y)).body).toMatch(/the base run.*2026-10-02T00:00:00\.000Z.*the compare run/);
  });

  it("scenario 9 - a debit recorded against a comparison is rejected by the database", async () => {
    const a = await owner();
    const x = await stored(a, scanInput(), scanResult([]));
    const y = await stored(a, scanInput(), scanResult([]));
    const body = data<CompareRunsResponse>(await compare(a, x, y));
    await expect(harness.db().query("UPDATE tool_runs SET credits_charged = 1 WHERE id = $1", [body.id])).rejects.toThrow(/ck_tr_free_tools/);
    await expect(inTenant(a, () => tools().startRun({ toolKey: "compare_runs", engineKeys: [], diffBaseRunId: x, diffCompareRunId: y, credits: 1 }))).rejects.toThrow(/free tool/);
  });

  it("scenario 10 - during a comparison: zero queue jobs, zero outbound requests, zero capture rows, zero ledger entries", async () => {
    const a = await owner();
    const x = await stored(a, scanInput(), scanResult([engineRow("perplexity")]));
    const y = await stored(a, scanInput(), scanResult([engineRow("perplexity")]));
    const ledgerBefore = await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1", [a.workspaceId]);
    const walletBefore = await wallet(a.workspaceId);
    const enqueue = vi.spyOn(QueueProducer.prototype, "enqueueTenantJob");
    const dispatch = vi.spyOn(QueueProducer.prototype, "dispatchPlannedCells");
    const outbound = vi.fn(() => {
      throw new Error("outbound request during a comparison");
    });
    vi.stubGlobal("fetch", outbound);
    const res = await compare(a, x, y);
    vi.unstubAllGlobals();
    expect(res.statusCode, res.body).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
    for (const table of ["answer_captures", "capture_runs", "mention_facts", "citation_facts"]) {
      expect(await count(`SELECT count(*)::int AS n FROM ${table}`), table).toBe(0);
    }
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1", [a.workspaceId])).toBe(ledgerBefore);
    expect(await wallet(a.workspaceId)).toEqual(walletBefore);
  });

  it("scenario 12 - the result carries the not-tracked marker and says two moments, not a trend", async () => {
    const a = await owner();
    const x = await stored(a, scanInput(), scanResult([]));
    const y = await stored(a, scanInput(), scanResult([]));
    const body = data<CompareRunsResponse>(await compare(a, x, y));
    expect(body).toMatchObject({ not_tracked: true, statement: COMPARE_RUNS_STATEMENT, credits_charged: 0, tool_key: "compare_runs" });
    expect(body.not_tracked_note).toMatch(/Not tracked/);
    expect(body.statement).toMatch(/not a trend/);
    expect(body.base.expires_at).toBeTruthy();
  });

  it("scenario 13 - re-opening a stored comparison is free: same row, no new run, wallet unchanged; it sits on the shared timeline", async () => {
    const a = await owner();
    const x = await stored(a, scanInput(), scanResult([engineRow("perplexity")]));
    const y = await stored(a, scanInput(), scanResult([engineRow("perplexity")]));
    const first = data<CompareRunsResponse>(await compare(a, x, y));
    expect(first.reopened).toBe(false);
    const walletBefore = await wallet(a.workspaceId);
    const rowsBefore = await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId]);
    const again = data<CompareRunsResponse>(await compare(a, x, y));
    expect(again).toEqual({ ...first, reopened: true });
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(rowsBefore);
    expect(await wallet(a.workspaceId)).toEqual(walletBefore);
    const timeline = await harness.app().inject({ method: "GET", url: apiUrl("/tools/runs?tool_key=compare_runs"), headers: { cookie: a.cookie } });
    expect(data<{ id: string; diff_base_run_id: string }[]>(timeline).map((r) => r.id)).toEqual([first.id]);
  });
});
