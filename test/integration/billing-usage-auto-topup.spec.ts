import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { autoTopupConfigSchema, usageResponseSchema, walletResponseSchema } from "../../contracts/billing/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { dataOf } from "../support/envelope.js";

// NEW-D-6 / STORY-076 AC6, AC8 — auto-top-up configuration (capped by the
// schema, off by default) and the usage-counters read. Real ApiModule, real
// Postgres, requests served as `nominara_app` so RLS is in force.

const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };
const CONFIG = { enabled: true, pack_key: "starter_vault", threshold: 100, max_per_cycle: 5 };

describe("NEW-D-6 · usage read and auto-top-up configuration", () => {
  const harness = useApiHarness({
    env: () => {
      const url = new URL(process.env.DATABASE_URL!);
      url.username = "nominara_app";
      url.password = resolvePassword("nominara_app", {});
      return { DATABASE_URL_POOLED: url.toString() };
    },
  });

  let pool: Pool;
  let sessions: SessionService;
  let workspaces: WorkspacesService;
  let log: MockInstance<(...args: unknown[]) => void>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await harness.db().query(`ALTER ROLE nominara_app PASSWORD '${resolvePassword("nominara_app", {})}'`);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const membership = new MembershipService(new MembershipCacheService());
    sessions = new SessionService(pool, membership, new InMemoryCacheAdapter());
    workspaces = new WorkspacesService(pool, new LocalDekProvisioner(Buffer.alloc(32, 7), "local:dev"), new AuditChainService(), membership, sessions, new NoopRealtimePublisher());
    log = vi.spyOn(Logger.prototype, "log") as unknown as typeof log;
  });
  afterEach(async () => {
    await pool.end();
  });

  async function createUser(): Promise<string> {
    const r = await harness.db().query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${randomUUID()}@example.com`]);
    return r.rows[0]!.id;
  }
  interface Actor {
    readonly accessToken: string;
    readonly csrfToken: string;
    readonly userId: string;
  }
  async function actorIn(workspaceId: string, role: "owner" | "admin" | "manager" | "viewer"): Promise<Actor> {
    const userId = await createUser();
    await harness.db().query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1,$2,$3,'active')", [workspaceId, userId, role]);
    const tokens = await sessions.createSession(userId);
    const entered = await workspaces.switchTo(userId, tokens.sid, workspaceId, meta);
    return { ...entered, userId };
  }
  async function newWorkspace(plan = "growth"): Promise<{ workspaceId: string; owner: Actor }> {
    const ownerId = await createUser();
    const ws = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    if (plan !== "free") await harness.db().query("UPDATE workspaces SET plan_key = $2 WHERE id = $1", [ws.id, plan]);
    const tokens = await sessions.createSession(ownerId);
    const entered = await workspaces.switchTo(ownerId, tokens.sid, ws.id, meta);
    return { workspaceId: ws.id, owner: { ...entered, userId: ownerId } };
  }

  const cookies = (a: Actor) => ({ [ACCESS_COOKIE_NAME]: a.accessToken, [CSRF_COOKIE_NAME]: a.csrfToken });
  const get = (a: Actor, path: string) => harness.app().inject({ method: "GET", url: apiUrl(path), cookies: cookies(a) });
  const put = (a: Actor, payload: unknown) =>
    harness.app().inject({
      method: "PUT",
      url: apiUrl("/billing/wallet/auto-topup"),
      cookies: cookies(a),
      headers: { [CSRF_HEADER_NAME]: a.csrfToken, "content-type": "application/json" },
      payload: payload as object,
    });
  const walletOf = async (a: Actor) => walletResponseSchema.parse(dataOf(await get(a, "/billing/wallet")));
  const row = async (workspaceId: string) =>
    (await harness.db().query("SELECT auto_topup_enabled, auto_topup_pack_key, auto_topup_threshold, auto_topup_max_per_cycle, auto_topup_count_cycle FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0];
  const audit = async (workspaceId: string) =>
    (await harness.db().query("SELECT action, resource_type, actor_id FROM audit_log WHERE workspace_id = $1 AND action LIKE 'billing.auto_topup.%' ORDER BY seq", [workspaceId])).rows;
  // The counters roll WITH the wallet's cycle, then the live subscription's period, then the calendar month (billing-period.ts).
  const periodStart = async (workspaceId: string) =>
    (await harness.db().query<{ d: string }>(
      `SELECT COALESCE(
         (SELECT cycle_start FROM credit_wallets WHERE workspace_id = $1),
         (SELECT current_period_start::date FROM subscriptions WHERE workspace_id = $1 AND status IN ('trialing','active','past_due') ORDER BY current_period_start DESC LIMIT 1),
         date_trunc('month', now() AT TIME ZONE 'UTC')::date)::text AS d`,
      [workspaceId],
    )).rows[0]!.d;

  // ---- STORY-076 AC6 / scenario 6 --------------------------------------------------------------

  it("STORY-076 AC6 scenario 6 · a viewer or manager is refused with 403 naming billing:write, and nothing is written", async () => {
    const { workspaceId } = await newWorkspace();
    for (const role of ["viewer", "manager"] as const) {
      const actor = await actorIn(workspaceId, role);
      const res = await put(actor, CONFIG);
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain("billing:write");
    }
    expect(await row(workspaceId)).toBeUndefined();
  });

  it("STORY-076 AC6 scenario 6 · a Starter workspace is 403 feature_not_in_plan naming growth", async () => {
    const { workspaceId, owner } = await newWorkspace("starter");
    const res = await put(owner, CONFIG);
    expect(res.statusCode).toBe(403);
    const error = res.json<{ error: { code: string; details?: { min_plan?: string } } }>().error;
    expect(error.code).toBe("feature_not_in_plan");
    expect(error.details?.min_plan).toBe("growth");
    expect(await row(workspaceId)).toBeUndefined();
  });

  it("STORY-076 AC6 scenario 6 · max_per_cycle above the cap is a 400 at the contract; 0 and 21 are refused, 1 and 20 are accepted", async () => {
    const { workspaceId, owner } = await newWorkspace();
    for (const bad of [0, 21, 1.5, -1]) {
      const res = await put(owner, { ...CONFIG, max_per_cycle: bad });
      expect(res.statusCode, `max_per_cycle ${String(bad)}`).toBe(400);
    }
    expect(await row(workspaceId)).toBeUndefined();
    for (const good of [1, 20]) {
      const res = await put(owner, { ...CONFIG, max_per_cycle: good });
      expect(res.statusCode, res.body).toBe(200);
      expect(autoTopupConfigSchema.parse(dataOf(res)).max_per_cycle).toBe(good);
    }
  });

  it("STORY-076 AC6 scenario 6 · ck_autotopup_bounded is the control: a direct write of 21 is SQLSTATE 23514, and so is enabling without a pack key", async () => {
    const { workspaceId, owner } = await newWorkspace();
    expect((await put(owner, CONFIG)).statusCode).toBe(200);
    const direct = (sql: string) => harness.db().query(sql, [workspaceId]);
    await expect(direct("UPDATE credit_wallets SET auto_topup_enabled = true, auto_topup_max_per_cycle = 21 WHERE workspace_id = $1")).rejects.toMatchObject({ code: "23514", constraint: "ck_autotopup_bounded" });
    await expect(direct("UPDATE credit_wallets SET auto_topup_max_per_cycle = 0 WHERE workspace_id = $1")).rejects.toMatchObject({ code: "23514" });
    await expect(direct("UPDATE credit_wallets SET auto_topup_pack_key = NULL WHERE workspace_id = $1")).rejects.toMatchObject({ code: "23514" });
    expect((await row(workspaceId)).auto_topup_max_per_cycle).toBe(5);
  });

  it("STORY-076 AC6 scenario 6 · unknown keys, an enabled config missing fields, and an unknown pack are all 400", async () => {
    const { owner } = await newWorkspace();
    expect((await put(owner, { ...CONFIG, extra: 1 })).statusCode).toBe(400);
    expect((await put(owner, { ...CONFIG, threshold: null })).statusCode).toBe(400);
    expect((await put(owner, { ...CONFIG, pack_key: null })).statusCode).toBe(400);
    expect((await put(owner, { ...CONFIG, pack_key: "no_such_pack" })).statusCode).toBe(400);
    expect((await put(owner, { enabled: true })).statusCode).toBe(400);
  });

  it("STORY-076 AC6 · a valid PUT returns the config, stores it, and GET /billing/wallet reads it back under auto_topup", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const res = await put(owner, CONFIG);
    expect(res.statusCode, res.body).toBe(200);
    expect(autoTopupConfigSchema.parse(dataOf(res))).toEqual({ ...CONFIG, used_this_cycle: 0, trigger_active: false });
    expect(await row(workspaceId)).toMatchObject({ auto_topup_enabled: true, auto_topup_pack_key: "starter_vault", auto_topup_threshold: 100, auto_topup_max_per_cycle: 5 });
    expect((await walletOf(owner)).auto_topup).toEqual({ ...CONFIG, used_this_cycle: 0, trigger_active: false });
  });

  it("STORY-076 AC6 · disabling stores enabled=false and may carry nulls", async () => {
    const { owner } = await newWorkspace();
    await put(owner, CONFIG);
    const res = await put(owner, { enabled: false, pack_key: null, threshold: null, max_per_cycle: null });
    expect(res.statusCode, res.body).toBe(200);
    expect((await walletOf(owner)).auto_topup).toMatchObject({ enabled: false, pack_key: null, threshold: null, max_per_cycle: null });
  });

  // ---- STORY-076 AC8 / scenario 8 --------------------------------------------------------------

  it("STORY-076 AC8 scenario 8 · a mid-cycle configuration change does not reset auto_topup_count_cycle", async () => {
    const { workspaceId, owner } = await newWorkspace();
    await put(owner, CONFIG);
    await harness.db().query("UPDATE credit_wallets SET auto_topup_count_cycle = 3 WHERE workspace_id = $1", [workspaceId]);
    for (const next of [{ ...CONFIG, max_per_cycle: 10 }, { enabled: false, pack_key: null, threshold: null, max_per_cycle: null }, CONFIG]) {
      const res = await put(owner, next);
      expect(res.statusCode, res.body).toBe(200);
      expect(autoTopupConfigSchema.parse(dataOf(res)).used_this_cycle).toBe(3);
      expect((await row(workspaceId)).auto_topup_count_cycle).toBe(3);
    }
    expect((await walletOf(owner)).auto_topup.used_this_cycle).toBe(3);
  });

  // ---- off by default --------------------------------------------------------------------------

  it("NEW-D-6 · auto top-up is off by default: a workspace with no wallet row reads enabled=false and nulls", async () => {
    const { workspaceId, owner } = await newWorkspace();
    expect(await row(workspaceId)).toBeUndefined();
    expect((await walletOf(owner)).auto_topup).toEqual({ enabled: false, pack_key: null, threshold: null, max_per_cycle: null, used_this_cycle: 0, trigger_active: false });
  });

  it("NEW-D-6 · auto top-up is off by default: a wallet row provisioned by anything else has the column default false", async () => {
    const { workspaceId, owner } = await newWorkspace();
    await harness.db().query("INSERT INTO credit_wallets (workspace_id, cycle_start, cycle_end) VALUES ($1, CURRENT_DATE, CURRENT_DATE + 30)", [workspaceId]);
    expect((await row(workspaceId)).auto_topup_enabled).toBe(false);
    expect((await walletOf(owner)).auto_topup.enabled).toBe(false);
  });

  // ---- audit and observability -----------------------------------------------------------------

  it("NEW-D-6 · every configuration change writes an audit row, and a refused change writes none", async () => {
    const { workspaceId, owner } = await newWorkspace();
    await put(owner, CONFIG);
    await put(owner, { ...CONFIG, max_per_cycle: 9 });
    await put(owner, { ...CONFIG, max_per_cycle: 99 });
    const rows = await audit(workspaceId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ action: "billing.auto_topup.updated", resource_type: "credit_wallet", actor_id: owner.userId });
  });

  it("NEW-D-6 · a PUT emits nominara_billing_auto_topup_update_total and a log line carrying the workspace id and no pack key or threshold", async () => {
    const { workspaceId, owner } = await newWorkspace();
    await put(owner, CONFIG);
    const metrics = log.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((c) => typeof c === "object" && typeof c?.metric === "string");
    expect(metrics).toContainEqual({ metric: "nominara_billing_auto_topup_update_total", value: 1, outcome: "updated" });
    const emitted = JSON.stringify(log.mock.calls);
    expect(emitted).toContain(workspaceId);
    expect(emitted).not.toContain("starter_vault");
  });

  // ---- GET /billing/usage ----------------------------------------------------------------------

  it("NEW-D-6 · GET /billing/usage reads the current period's counter in the usage contract", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const start = await periodStart(workspaceId);
    await harness.db().query("INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value) VALUES ($1,'pdf_exports',$2,25,7)", [workspaceId, start]);
    const res = await get(owner, "/billing/usage");
    expect(res.statusCode, res.body).toBe(200);
    expect(usageResponseSchema.parse(dataOf(res))).toEqual({ period_start: start, pdf_exports: { used: 7, cap: 25 }, share_links_active: 0 });
  });

  it("NEW-D-6 · cap null means unlimited and cap 0 means the tier has none: they are different answers", async () => {
    const unlimited = await newWorkspace("business");
    await harness.db().query("INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value) VALUES ($1,'pdf_exports',$2,-1,4)", [unlimited.workspaceId, await periodStart(unlimited.workspaceId)]);
    expect(dataOf<{ pdf_exports: unknown }>(await get(unlimited.owner, "/billing/usage")).pdf_exports).toEqual({ used: 4, cap: null });

    const none = await newWorkspace("starter");
    await harness.db().query("INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value) VALUES ($1,'pdf_exports',$2,0,0)", [none.workspaceId, await periodStart(none.workspaceId)]);
    expect(dataOf<{ pdf_exports: unknown }>(await get(none.owner, "/billing/usage")).pdf_exports).toEqual({ used: 0, cap: 0 });
  });

  it("NEW-D-6 · with no counter row yet, used is 0 and the cap comes from the plan (read-only: no row is created)", async () => {
    const { workspaceId, owner } = await newWorkspace("growth");
    expect(dataOf<{ pdf_exports: unknown }>(await get(owner, "/billing/usage")).pdf_exports).toEqual({ used: 0, cap: 25 });
    expect((await harness.db().query("SELECT 1 FROM usage_counters WHERE workspace_id = $1", [workspaceId])).rowCount).toBe(0);
  });

  it("NEW-D-6 · only the current period's counter is read, and the unpublished metrics never appear", async () => {
    const { workspaceId, owner } = await newWorkspace();
    await harness.db().query("INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value) VALUES ($1,'pdf_exports','2020-01-01',25,24)", [workspaceId]);
    await harness.db().query("INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value) VALUES ($1,'fair_use_captures',$2,500,321)", [workspaceId, await periodStart(workspaceId)]);
    const res = await get(owner, "/billing/usage");
    expect(dataOf<{ pdf_exports: unknown }>(res).pdf_exports).toEqual({ used: 0, cap: 25 });
    expect(res.body).not.toContain("fair_use");
    expect(res.body).not.toContain("321");
  });

  it("NEW-D-6 · share_links_active counts unrevoked, unexpired tokens only", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const project = (await harness.db().query<{ id: string }>("INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1,'P','p','https://p.test','p.test') RETURNING id", [workspaceId])).rows[0]!.id;
    const mint = (extra: string) =>
      harness.db().query(
        `INSERT INTO share_tokens (workspace_id, label, token_hash, token_prefix, scope_project_ids, created_by, ${extra.split("=")[0]!.trim()})
         VALUES ($1,'L',$2,'abcdefgh',$3,$4, ${extra.split("=")[1]!.trim()})`,
        [workspaceId, Buffer.from(randomUUID()), [project], owner.userId],
      );
    await mint("revoked_at = NULL");
    await mint("expires_at = now() + interval '1 day'");
    await mint("revoked_at = now()");
    await mint("expires_at = now() - interval '1 day'");
    expect(dataOf<{ share_links_active: number }>(await get(owner, "/billing/usage")).share_links_active).toBe(2);
  });

  it("NEW-D-6 · GET /billing/usage requires billing:read: a manager and a viewer are 403 naming it", async () => {
    const { workspaceId } = await newWorkspace();
    for (const role of ["viewer", "manager"] as const) {
      const res = await get(await actorIn(workspaceId, role), "/billing/usage");
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain("billing:read");
    }
  });

  it("NEW-D-6 · usage and auto-top-up are tenant-isolated: another workspace's counters, tokens and config never appear", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    await harness.db().query("INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value) VALUES ($1,'pdf_exports',$2,25,19)", [b.workspaceId, await periodStart(b.workspaceId)]);
    await put(b.owner, CONFIG);
    expect(dataOf<{ pdf_exports: unknown }>(await get(a.owner, "/billing/usage")).pdf_exports).toEqual({ used: 0, cap: 25 });
    expect((await walletOf(a.owner)).auto_topup.enabled).toBe(false);
    expect((await walletOf(b.owner)).auto_topup.enabled).toBe(true);
  });
});
