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
import {
  startValkey,
  startValkeyFixture,
  type StartedValkey,
  type ValkeyFixture,
} from "../support/valkey-fixture.js";

// ⚠ WHAT THE CUSTOMER'S LEDGER AND THEIR STATUS CODE SAY WHEN A DEEP SCAN HAS
// NOTHING TO CAPTURE — through the REAL ApiModule: every guard, the tenant
// transaction, the idempotency and credit interceptors, the problem filter.
//
// `planManualRun` refuses an empty scope, but it is the HANDLER's refusal, and
// `CreditGuard` runs before the handler. So on its own it (a) never gets
// reached on a low balance — the wallet refuses first, `402
// insufficient_credits` with a `purchase_credits` remediation, telling the
// customer to buy credits for a scan that could not run — and (b) on a funded
// wallet leaves a permanent reserve + release pair in the customer-visible
// ledger beside a `422` that says nothing was charged. The unit and
// service-level specs cannot see either: they never run a guard.
//
// The empty scope is production today, not an edge: no engine is
// capture-ready until STORY-001, so `captureReadyEngineKeys()` is empty for
// every project. A real scope needs the registry's answer changed, which is
// the mock below; everything else is the deployed composition.
//
// TWO VALKEYS OF THIS SPEC'S OWN. `applyFakeApiEnv` points the queue at
// localhost:6380 and the cache at localhost:6379 — a developer's own local
// services — and a successful trigger enqueues its cells. Neither is touched:
// the harness is told (its `env` option) to use containers started here.

const capture = vi.hoisted(() => ({ ready: [] as string[] }));
vi.mock("../../src/lib/engines/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/engines/registry.js")>();
  return { ...actual, captureReadyEngineKeys: () => capture.ready };
});

const PRICE = 200;
const ENGINE_KEY = "perplexity";

describe("STORY-034 · a deep scan with nothing to capture, over HTTP", () => {
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
    capture.ready = [];
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
    readonly entered: CookieTokens;
  }

  /** A growth workspace with one project, one engine row, and — unless `prompts` is 0 — active prompts. */
  async function scenario(options: { prompts: number; included: number; wallet?: boolean }): Promise<Scenario> {
    const db = harness.db();
    const userId = uuidV7();
    await db.query(
      `INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`,
      [userId, `${userId}@example.test`],
    );
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
        applyPlanChange(tx, workspaceId, planKeyOnly("growth"), { requestId: "R", operator: "test", reason: "test" }),
      );
    } finally {
      client.release();
    }
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 2);

    const projectId = uuidV7();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, priority_prompt_limit)
       VALUES ($1,$2,'P','p-zero','https://e.test','e.test',10)`,
      [projectId, workspaceId],
    );
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version, cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ($1,$1,'v','api','1.0.0',86400,'medium','free','active') ON CONFLICT DO NOTHING`,
      [ENGINE_KEY],
    );
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count) VALUES ($1,$2,$3,true,1)`,
      [workspaceId, projectId, ENGINE_KEY],
    );
    for (let i = 0; i < options.prompts; i++) {
      const text = `best crm number ${String(i)}`;
      await db.query(
        `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
         VALUES (gen_random_uuid(), $1, $2, $3, sha256($4::bytea), 'recommendation', 'consideration', false, 'active')`,
        [workspaceId, projectId, text, Buffer.from(text, "utf8")],
      );
    }
    if (options.wallet !== false) {
      await db.query(
        `INSERT INTO credit_wallets (workspace_id, included_balance, purchased_balance, reserved, cycle_start, cycle_end)
         VALUES ($1, $2, 0, 0, (now() AT TIME ZONE 'UTC')::date, (now() AT TIME ZONE 'UTC')::date + 30)
         ON CONFLICT (workspace_id) DO UPDATE SET included_balance = $2, reserved = 0`,
        [workspaceId, options.included],
      );
    }
    return { workspaceId, projectId, entered };
  }

  function trigger(s: Scenario, over: { projectId?: string; key?: string } = {}) {
    return harness.app().inject({
      method: "POST",
      url: apiUrl(`/projects/${over.projectId ?? s.projectId}/runs`),
      headers: {
        cookie: cookieOf(s.entered),
        [CSRF_HEADER_NAME]: s.entered.csrfToken,
        "content-type": "application/json",
        "idempotency-key": over.key ?? uuidV7(),
        "x-nominara-confirmed-credits": String(PRICE),
      },
      payload: {},
    });
  }

  interface Books {
    readonly ledger: unknown[];
    readonly wallet: unknown;
    readonly runs: number;
  }

  /** Everything a refused scan must not have touched, read after any asynchronous settlement has had time to show itself. */
  async function books(s: Scenario): Promise<Books> {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const db = harness.db();
    const ledger = await db.query(
      `SELECT entry_type, action_code, credits, reserved_after FROM credit_ledger WHERE workspace_id = $1 ORDER BY seq`,
      [s.workspaceId],
    );
    const wallet = await db.query(
      `SELECT included_balance, purchased_balance, reserved FROM credit_wallets WHERE workspace_id = $1`,
      [s.workspaceId],
    );
    const runs = await db.query(`SELECT count(*)::int AS n FROM capture_runs WHERE project_id = $1`, [s.projectId]);
    return { ledger: ledger.rows, wallet: wallet.rows[0], runs: (runs.rows[0] as { n: number }).n };
  }

  it("STORY-034 · nothing to capture on a FUNDED wallet: 422 no_capturable_scope, and NO ledger row, NO reservation, NO run — not even a reserve-and-release pair", async () => {
    const s = await scenario({ prompts: 2, included: 2_400 });
    const before = await books(s);

    const res = await trigger(s);

    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({
      error: { code: "precondition_unmet", details: { reason: "no_capturable_scope" } },
    });
    expect(await books(s), "the refused scan left the customer's books exactly as it found them").toEqual(before);
    expect((await books(s)).wallet).toEqual({ included_balance: 2_400, purchased_balance: 0, reserved: 0 });
  });

  // Round-3 audit, MINOR: "no ledger row" held only for an existing wallet.
  // Wallet provisioning runs before the precondition — it is how every
  // workspace's wallet comes to exist, on its first priced request — so a
  // refused scan on a never-charged workspace still creates the wallet and its
  // included grant. That is the documented lazy provisioning, idempotent per
  // cycle; what must never appear is a reserve, a release, or a debit.
  it("STORY-034 · nothing to capture on a workspace with NO wallet yet: 422, and the only ledger row is the plan's opening grant — no reserve, no release, no run", async () => {
    const s = await scenario({ prompts: 2, included: 0, wallet: false });

    const res = await trigger(s);

    expect(res.statusCode, res.body).toBe(422);
    const after = await books(s);
    expect((after.ledger as Array<{ entry_type: string }>).map((row) => row.entry_type)).toEqual(["grant"]);
    expect((after.wallet as { reserved: number }).reserved).toBe(0);
    expect(after.runs).toBe(0);
  });

  it("STORY-034 · nothing to capture on a LOW balance: 422, never 402 — the customer is not told to buy credits for a scan that could not run", async () => {
    const s = await scenario({ prompts: 2, included: 50 });
    const before = await books(s);

    const res = await trigger(s);

    expect(res.statusCode, res.body).toBe(422);
    const body = res.json() as { error: { code: string; remediation?: unknown } };
    expect(body.error.code).toBe("precondition_unmet");
    expect(body.error.remediation, "no purchase_credits remediation").toBeUndefined();
    expect(await books(s)).toEqual(before);
  });

  it("STORY-034 · an engine that can capture but NO active prompts is the same refusal, before any reservation", async () => {
    capture.ready = [ENGINE_KEY];
    const s = await scenario({ prompts: 0, included: 2_400 });
    const before = await books(s);

    const res = await trigger(s);

    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({ error: { details: { reason: "no_capturable_scope" } } });
    expect(await books(s)).toEqual(before);
  });

  it("STORY-034 · an UNKNOWN project is a 404 before anything is reserved, as the handler would have answered after", async () => {
    const s = await scenario({ prompts: 2, included: 2_400 });
    const before = await books(s);

    const res = await trigger(s, { projectId: uuidV7() });

    expect(res.statusCode, res.body).toBe(404);
    expect(await books(s)).toEqual(before);
  });

  it("STORY-034 · a REAL scope still reserves, plans and DEBITS exactly as before: 202, reserve then commit, the wallet down by the flat price, one run", async () => {
    capture.ready = [ENGINE_KEY];
    const s = await scenario({ prompts: 2, included: 2_400 });

    const res = await trigger(s);

    expect(res.statusCode, res.body).toBe(202);
    const after = await books(s);
    expect((after.ledger as Array<{ entry_type: string; action_code: string; credits: number }>).map((row) => [row.entry_type, row.action_code, row.credits])).toEqual([
      ["reserve", "manual_scan", PRICE],
      ["commit", "manual_scan", PRICE],
    ]);
    expect(after.wallet).toEqual({ included_balance: 2_400 - PRICE, purchased_balance: 0, reserved: 0 });
    expect(after.runs).toBe(1);
  });

  it("STORY-034 · a REAL scope on a LOW balance is still 402 insufficient_credits — the wallet's refusal is not masked by the scope check", async () => {
    capture.ready = [ENGINE_KEY];
    const s = await scenario({ prompts: 2, included: 50 });
    const before = await books(s);

    const res = await trigger(s);

    expect(res.statusCode, res.body).toBe(402);
    expect(res.json()).toMatchObject({ error: { code: "insufficient_credits", remediation: { kind: "purchase_credits" } } });
    expect(await books(s)).toEqual(before);
  });
});
