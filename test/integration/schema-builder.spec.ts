import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { ToolsService } from "../../src/modules/tools/tools.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { SCHEMA_BUILDER_STATEMENT, schemaBuilderResponseSchema, schemaBuilderStoredResultSchema, type SchemaBuilderResponse } from "../../contracts/tools/index.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-083 (owner decision 78a) - the Schema Builder SAVE through the REAL ApiModule. Build and Check run in the browser, so scenarios 1-5, 7 and the
// markup half of 8 are client-side and are NOT here; this file covers what the API owns: 6 and 9 on the save path, 10-13, and the "findings only" rule.
// Scenario numbers are the story's Test scenarios table.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

interface Actor {
  readonly workspaceId: string;
  readonly userId: string;
  readonly cookie: string;
  readonly csrf: string;
}

const price = { rule_code: "AUX-R-012", severity: "high", position: null, field: "offers.price" };
const parse = { rule_code: "AUX-R-008", severity: "critical", position: { line: 3, column: 14 }, field: null };
const check = { mode: "check", entity_type: null, vocab_version: "schema-vocab@2026.08", findings: [price, parse] };

describe("STORY-083 · Schema Builder save", () => {
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
  const save = (a: Actor, payload: unknown, key: string | null = uuidV7()) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl("/tools/schema-builder"),
      headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }) },
      payload: payload as object,
    });
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  const wallet = async (workspaceId: string) =>
    (await harness.db().query("SELECT included_balance, purchased_balance, reserved FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0];
  const count = async (sqlText: string, params: unknown[] = []) => (await harness.db().query<{ n: number }>(sqlText, params)).rows[0]!.n;

  it("scenario 8 - every saved finding leads with the rendering consequence, taken from the shared catalog and never from the client", async () => {
    const a = await owner();
    const res = await save(a, check);
    expect(res.statusCode, res.body).toBe(200);
    const body = schemaBuilderResponseSchema.parse(data<SchemaBuilderResponse>(res));
    expect(body.findings).toHaveLength(2);
    const catalog = new Map((await harness.db().query<{ code: string; rationale: string }>("SELECT code, rationale FROM aux_rule_catalog")).rows.map((r) => [r.code, r.rationale]));
    for (const f of body.findings) {
      expect(Object.keys(f)[0]).toBe("consequence");
      expect(f.consequence).toBe(catalog.get(f.rule_code));
      expect(f.consequence).not.toMatch(/AUX-R|rule/);
    }
    expect(body.findings[1]!.position).toEqual({ line: 3, column: 14 });
  });

  it("scenario 6 - pasted markup is a 400 and nothing is stored; a field that could carry it is refused too", async () => {
    const a = await owner();
    const sentinel = "SENTINEL-MARKUP-83";
    const before = await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId]);
    for (const payload of [
      { ...check, markup: `{"name":"${sentinel}"}` },
      { ...check, findings: [{ ...price, detail: sentinel }] },
      { ...check, findings: [{ ...price, field: `{"x":"${sentinel}"}` }] },
      { url: "https://acme.test/pricing" },
    ]) {
      const res = await save(a, payload);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).not.toContain(sentinel);
    }
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(before);
  });

  it("scenario 5 - a rule outside structured_data, and the held contradiction rule, are 400", async () => {
    const a = await owner();
    for (const rule_code of ["AUX-R-013", "AUX-R-001", "AUX-R-099"]) {
      expect((await save(a, { ...check, findings: [{ ...price, rule_code }] })).statusCode, rule_code).toBe(400);
    }
  });

  it("scenario 4 - a build names its entity type; a check names none; an Idempotency-Key is required", async () => {
    const a = await owner();
    expect((await save(a, { ...check, mode: "build", entity_type: null })).statusCode).toBe(400);
    expect((await save(a, { ...check, entity_type: "Product" })).statusCode).toBe(400);
    expect((await save(a, check, null)).statusCode).toBe(400);
    const ok = await save(a, { mode: "build", entity_type: "Product", vocab_version: "schema-vocab@2026.08", findings: [] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(data<SchemaBuilderResponse>(ok)).toMatchObject({ mode: "build", entity_type: "Product", findings: [] });
  });

  it("scenario 12 - the stored row holds findings only, is free, and re-opens from the timeline with the wallet unchanged", async () => {
    const a = await owner();
    const body = data<SchemaBuilderResponse>(await save(a, check));
    const row = (await harness.db().query("SELECT tool_key, credits_charged, status, result_json, target_url, brand_name, engine_keys FROM tool_runs WHERE id = $1", [body.id])).rows[0];
    expect(row).toMatchObject({ tool_key: "schema_builder", credits_charged: 0, status: "completed", target_url: null, brand_name: null, engine_keys: [] });
    const stored = schemaBuilderStoredResultSchema.parse(row.result_json);
    expect(stored.findings.map((f) => f.rule_code)).toEqual(["AUX-R-012", "AUX-R-008"]);
    expect(Object.keys(row.result_json).sort()).toEqual(["entity_type", "findings", "mode", "presentation_notes", "schema_version", "vocab_version"]);
    const walletBefore = await wallet(a.workspaceId);
    const rowsBefore = await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId]);
    const reopened = await harness.app().inject({ method: "GET", url: apiUrl(`/tools/runs/${body.id}`), headers: { cookie: a.cookie } });
    expect(reopened.statusCode, reopened.body).toBe(200);
    const run = data<{ tool_key: string; credits_charged: number; result: unknown; presentation: { not_tracked: boolean; did_not_check: string } }>(reopened);
    expect(run).toMatchObject({ tool_key: "schema_builder", credits_charged: 0, result: stored, presentation: { not_tracked: true } });
    expect(await wallet(a.workspaceId)).toEqual(walletBefore);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1", [a.workspaceId])).toBe(rowsBefore);
    const timeline = await harness.app().inject({ method: "GET", url: apiUrl("/tools/runs?tool_key=schema_builder"), headers: { cookie: a.cookie } });
    expect(data<{ id: string }[]>(timeline).map((r) => r.id)).toEqual([body.id]);
  });

  it("scenario 12 - another workspace cannot read the saved run", async () => {
    const a = await owner();
    const b = await owner();
    const body = data<SchemaBuilderResponse>(await save(a, check));
    expect((await harness.app().inject({ method: "GET", url: apiUrl(`/tools/runs/${body.id}`), headers: { cookie: b.cookie } })).statusCode).toBe(404);
  });

  it("scenario 12 - the response carries the not-tracked marker, the did-not-check line and the in-your-browser statement", async () => {
    const a = await owner();
    const body = data<SchemaBuilderResponse>(await save(a, check));
    expect(body).toMatchObject({ not_tracked: true, credits_charged: 0, tool_key: "schema_builder", statement: SCHEMA_BUILDER_STATEMENT });
    expect(body.not_tracked_note).toMatch(/Not tracked/);
    expect(body.did_not_check.length).toBeGreaterThan(0);
  });

  it("scenario 12 - a repeat with the same Idempotency-Key replays the one run", async () => {
    const a = await owner();
    const key = uuidV7();
    const first = data<SchemaBuilderResponse>(await save(a, check, key));
    const again = data<SchemaBuilderResponse>(await save(a, check, key));
    expect(again.id).toBe(first.id);
    expect(await count("SELECT count(*)::int AS n FROM tool_runs WHERE workspace_id = $1 AND tool_key = 'schema_builder'", [a.workspaceId])).toBe(1);
  });

  it("scenario 10 - a debit recorded against a Schema Builder run is rejected by the database", async () => {
    const a = await owner();
    const body = data<SchemaBuilderResponse>(await save(a, check));
    await expect(harness.db().query("UPDATE tool_runs SET credits_charged = 1 WHERE id = $1", [body.id])).rejects.toThrow(/ck_tr_free_tools/);
    await expect(inTenant(a, () => tools().startRun({ toolKey: "schema_builder", engineKeys: [], resultJson: {}, credits: 1 }))).rejects.toThrow(/free tool/);
  });

  it("scenario 11 - the lowest tier saves a run, free", async () => {
    const a = await owner("free");
    const walletBefore = await wallet(a.workspaceId);
    const res = await save(a, check);
    expect(res.statusCode, res.body).toBe(200);
    expect(data<SchemaBuilderResponse>(res).credits_charged).toBe(0);
    expect(await wallet(a.workspaceId)).toEqual(walletBefore);
  });

  it("scenario 6 and 9 - during a save: zero queue jobs, zero outbound requests; scenario 13 - zero fact rows and zero ledger entries", async () => {
    const a = await owner();
    const ledgerBefore = await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1", [a.workspaceId]);
    const enqueue = vi.spyOn(QueueProducer.prototype, "enqueueTenantJob");
    const dispatch = vi.spyOn(QueueProducer.prototype, "dispatchPlannedCells");
    const outbound = vi.fn(() => {
      throw new Error("outbound request during a Schema Builder save");
    });
    vi.stubGlobal("fetch", outbound);
    const res = await save(a, check);
    vi.unstubAllGlobals();
    expect(res.statusCode, res.body).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
    for (const table of ["answer_captures", "capture_runs", "mention_facts", "citation_facts"]) {
      expect(await count(`SELECT count(*)::int AS n FROM ${table}`), table).toBe(0);
    }
    expect(await count("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1", [a.workspaceId])).toBe(ledgerBefore);
  });

  it("an unauthenticated save is refused", async () => {
    const res = await harness.app().inject({ method: "POST", url: apiUrl("/tools/schema-builder"), headers: { "content-type": "application/json", "idempotency-key": uuidV7() }, payload: check });
    expect([401, 403]).toContain(res.statusCode);
  });
});
