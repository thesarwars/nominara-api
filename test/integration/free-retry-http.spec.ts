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

// STORY-195 AC4 — POST /projects/{id}/runs/retry through the REAL ApiModule: the free retry of an all-degraded first run.
// The queue and cache Valkeys are this spec's own containers (never a developer's local services).

const capture = vi.hoisted(() => ({ ready: [] as string[] }));
vi.mock("../../src/lib/engines/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/engines/registry.js")>();
  return { ...actual, captureReadyEngineKeys: () => capture.ready };
});

const ENGINE_KEY = "perplexity";

describe("STORY-195 · the free retry, over HTTP", () => {
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

  async function seedRun(s: Scenario, status: string): Promise<string> {
    const id = uuidV7();
    await harness.db().query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells, failed_cells, status, created_at)
       VALUES ($1, $2, $3, 'manual', ARRAY[$4]::text[], 2, 2, $5, now() - interval '1 hour')`,
      [id, s.workspaceId, s.projectId, ENGINE_KEY, status],
    );
    return id;
  }

  function retry(s: Scenario, key: string = uuidV7()) {
    return harness.app().inject({
      method: "POST",
      url: apiUrl(`/projects/${s.projectId}/runs/retry`),
      // No x-nominara-confirmed-credits: the retry is free, so there is no price to confirm.
      headers: { cookie: cookieOf(s.entered), [CSRF_HEADER_NAME]: s.entered.csrfToken, "content-type": "application/json", "idempotency-key": key },
      payload: {},
    });
  }

  async function books(s: Scenario): Promise<{ ledger: number; wallet: unknown; retries: number }> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const db = harness.db();
    const ledger = await db.query("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1", [s.workspaceId]);
    const wallet = await db.query("SELECT included_balance, purchased_balance, reserved FROM credit_wallets WHERE workspace_id = $1", [s.workspaceId]);
    const retries = await db.query("SELECT count(*)::int AS n FROM capture_runs WHERE project_id = $1 AND retry_of IS NOT NULL", [s.projectId]);
    return { ledger: (ledger.rows[0] as { n: number }).n, wallet: wallet.rows[0], retries: (retries.rows[0] as { n: number }).n };
  }

  it("STORY-195-AC4 a failed first run is retried: 202, one linked run, and the wallet is not touched even at a zero balance", async () => {
    const s = await scenario({ prompts: 2, included: 0 });
    const first = await seedRun(s, "failed");
    const before = await books(s);

    const res = await retry(s);

    expect(res.statusCode, res.body).toBe(202);
    const body = (res.json() as { data: { run_id: string; project_id: string; status: string; charge: unknown; trigger: string } }).data;
    expect(body).toMatchObject({ project_id: s.projectId, status: "queued", charge: null });
    const linked = await harness.db().query("SELECT retry_of FROM capture_runs WHERE id = $1", [body.run_id]);
    expect((linked.rows[0] as { retry_of: string }).retry_of).toBe(first);
    const after = await books(s);
    expect(after.retries).toBe(1);
    expect(after.ledger, "no ledger row of any kind").toBe(before.ledger);
    expect(after.wallet).toEqual(before.wallet);
  });

  it("STORY-195-AC4 replaying the same Idempotency-Key returns the same run and starts no second one", async () => {
    const s = await scenario({ prompts: 2, included: 0 });
    await seedRun(s, "failed");
    const key = uuidV7();
    const one = await retry(s, key);
    const two = await retry(s, key);
    expect(one.statusCode, one.body).toBe(202);
    expect(two.statusCode, two.body).toBe(202);
    expect((two.json() as { data: { run_id: string } }).data.run_id).toBe((one.json() as { data: { run_id: string } }).data.run_id);
    expect((await books(s)).retries).toBe(1);
  });

  it("STORY-195-AC4 a second retry under a new key is 409 retry_already_used", async () => {
    const s = await scenario({ prompts: 2, included: 0 });
    await seedRun(s, "failed");
    expect((await retry(s)).statusCode).toBe(202);
    const res = await retry(s);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "conflict", details: { reason: "retry_already_used" } } });
    expect((await books(s)).retries).toBe(1);
  });

  it("STORY-195-AC4 a first run that delivered something is 409 not_all_degraded and nothing is created", async () => {
    const s = await scenario({ prompts: 2, included: 0 });
    await seedRun(s, "partial");
    const res = await retry(s);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: { details: { reason: "not_all_degraded" } } });
    expect((await books(s)).retries).toBe(0);
  });

  it("STORY-195-AC4 an unknown project is a 404", async () => {
    const s = await scenario({ prompts: 2, included: 0 });
    const res = await harness.app().inject({
      method: "POST",
      url: apiUrl(`/projects/${uuidV7()}/runs/retry`),
      headers: { cookie: cookieOf(s.entered), [CSRF_HEADER_NAME]: s.entered.csrfToken, "content-type": "application/json", "idempotency-key": uuidV7() },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(404);
  });

  it("STORY-195-AC4 a body with a field is a 400, never a silent drop (strict)", async () => {
    const s = await scenario({ prompts: 2, included: 0 });
    await seedRun(s, "failed");
    const res = await harness.app().inject({
      method: "POST",
      url: apiUrl(`/projects/${s.projectId}/runs/retry`),
      headers: { cookie: cookieOf(s.entered), [CSRF_HEADER_NAME]: s.entered.csrfToken, "content-type": "application/json", "idempotency-key": uuidV7() },
      payload: { engines: ["perplexity"] },
    });
    expect(res.statusCode, res.body).toBe(400);
  });
});
