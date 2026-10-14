import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitBuckets } from "../../src/api/rate-limit/buckets.js";
import { RATE_LIMIT_DEFAULTS } from "../../src/api/rate-limit/defaults.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { cacheKeyNamespace } from "../../src/lib/cache/key-namespace.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { rateLimitConfigKey } from "../../src/lib/cache/valkey-keys.js";
import { ValkeyCacheAdapter } from "../../src/lib/cache/valkey-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-025 AC8 (second half), AC10 and the /auth/otp/request decision — through the REAL ApiModule against the REAL
// credit ledger (Postgres) and a testcontainers Valkey. Never a developer's own local Valkey.
//
// AC8: "a credit-spending call that is rate-limited never reaches CreditGuard, so no reservation is created" — the
// unit spec proves CreditGuard is not INVOKED. This proves the BOOKS: no credit_ledger row of any kind, the wallet
// untouched, no capture run. The control case runs the same request un-limited and shows it WOULD have reserved and
// debited, so "no rows" cannot be the vacuous result of a route that never spends.

const capture = vi.hoisted(() => ({ ready: [] as string[] }));
vi.mock("../../src/lib/engines/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/engines/registry.js")>();
  return { ...actual, captureReadyEngineKeys: () => capture.ready };
});

const PRICE = 200;
const ENGINE_KEY = "perplexity";

describe("STORY-025 · rate limiting against the real credit ledger and the real route table", () => {
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
    readonly userId: string;
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
    return { workspaceId, projectId, entered, userId };
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

  /**
   * Spends the user's bucket through the app's own limiter, so the NEXT request is the refused one. The class is
   * `project_runs` — the class `POST /projects/:id/runs` declares (§12: 6/hour per user, burst 2). The AC11 test below
   * proves the route really is in that class, so exhausting it here is not a bucket the route never touches.
   */
  async function exhaustRunsBucket(s: Scenario): Promise<void> {
    const limiter = harness.app().get(RateLimitBuckets, { strict: false });
    const identity = { env: cacheKeyNamespace(), workspaceId: s.workspaceId, userId: s.userId, ip: "127.0.0.1" };
    for (let i = 0; i < 100; i++) {
      if (!(await limiter.check("project_runs", identity)).allowed) return;
    }
    throw new Error("the project_runs bucket never refused; the fixture cannot exhaust it");
  }

  it("STORY-025 row 8 · CONTROL: the same funded deep scan, not rate-limited, DOES reserve and debit", async () => {
    capture.ready = [ENGINE_KEY];
    const s = await scenario({ prompts: 2, included: 2_400 });

    const res = await trigger(s);

    expect(res.statusCode, res.body).toBe(202);
    const after = await books(s);
    expect((after.ledger as Array<{ entry_type: string }>).map((row) => row.entry_type)).toEqual(["reserve", "commit"]);
    expect(after.wallet).toEqual({ included_balance: 2_400 - PRICE, purchased_balance: 0, reserved: 0 });
  });

  it("STORY-025 row 8 · a RATE-LIMITED credit-spending route leaves NO ledger row, NO reservation, NO debit and NO run", async () => {
    capture.ready = [ENGINE_KEY];
    const s = await scenario({ prompts: 2, included: 2_400 });
    await exhaustRunsBucket(s);
    const before = await books(s);

    const res = await trigger(s);

    expect(res.statusCode, res.body).toBe(429);
    expect(res.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(res.headers["retry-after"], "the refusal carries its retry hint").toBeDefined();

    const after = await books(s);
    const ledger = await harness
      .db()
      .query(`SELECT entry_type FROM credit_ledger WHERE workspace_id = $1 AND entry_type IN ('reserve','commit','release')`, [
        s.workspaceId,
      ]);
    expect(ledger.rowCount, "no reserve, commit or release row of any kind").toBe(0);
    expect(after.wallet).toEqual({ included_balance: 2_400, purchased_balance: 0, reserved: 0 });
    expect(after.runs).toBe(0);
    expect(after, "the books are exactly as the refused request found them").toEqual(before);
  });

  it("STORY-025 row 8 · a rate-limited request is not a 402: a poor wallet does not change the answer, the limiter answers first", async () => {
    capture.ready = [ENGINE_KEY];
    const s = await scenario({ prompts: 2, included: 50 });
    await exhaustRunsBucket(s);

    const res = await trigger(s);

    expect(res.statusCode, res.body).toBe(429);
  });

  it("STORY-025 AC11 · POST /projects/:id/runs is limited by the project_runs class: burst 2, then the third rapid request is refused (6/hour refill)", async () => {
    capture.ready = [ENGINE_KEY];
    const s = await scenario({ prompts: 2, included: 2_400 });

    const first = await trigger(s);
    const second = await trigger(s);
    const third = await trigger(s);

    expect(first.statusCode, first.body).toBe(202);
    expect(second.statusCode, second.body).toBe(202);
    // The header publishes the capacity of the bucket that applied: project_runs' burst is 2, writes' is 20.
    expect(first.headers["x-ratelimit-limit"], "the project_runs bucket applied, not writes").toBe("2");
    expect(third.statusCode, third.body).toBe(429);
    expect(third.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(third.headers["x-ratelimit-limit"]).toBe("2");
    expect(third.headers["x-ratelimit-remaining"]).toBe("0");
    expect(Number(third.headers["retry-after"]), "a refill takes minutes (6/hour), not seconds (60/min)").toBeGreaterThan(60);
  });

  // ---- /auth/otp/request keeps BOTH limits ---------------------------------------------------------------------

  it("STORY-025 decision · /auth/otp/request is refused by the §12 per-IP bucket (burst 5) over HTTP, with the standard headers, before the per-address ledger can speak", async () => {
    const statuses: number[] = [];
    let sixth: Awaited<ReturnType<ReturnType<typeof harness.app>["inject"]>> | undefined;
    for (let i = 0; i < 6; i++) {
      // A distinct address each time: no address is near its own 3/hour limit, and 6 is far below the 30/min per-source
      // ledger — so the only limiter that can refuse the sixth is the platform per-IP bucket.
      const res = await harness.app().inject({
        method: "POST",
        url: apiUrl("/auth/otp/request"),
        payload: { email: `ip-bucket-${String(i)}-${uuidV7()}@example.test` },
      });
      statuses.push(res.statusCode);
      sixth = res;
    }
    expect(statuses.slice(0, 5), "the first five are inside the burst").toEqual([201, 201, 201, 201, 201]);
    expect(statuses[5]).toBe(429);
    expect(sixth!.headers["x-ratelimit-limit"], "the platform guard, not the service, refused").toBeDefined();
    expect(sixth!.headers["retry-after"]).toBeDefined();
  });
});

// ---- AC10 against a REAL Valkey -----------------------------------------------------------------------------------

describe("STORY-025 AC10 · the configuration document in a real Valkey", () => {
  let valkey: StartedValkey;
  let adapter: ValkeyCacheAdapter;

  beforeAll(async () => {
    valkey = await startValkey();
    adapter = new ValkeyCacheAdapter(valkey.url);
    await adapter.connect();
  }, 180_000);
  afterAll(async () => {
    await adapter.onModuleDestroy();
    await valkey.stop();
  });

  const IDENTITY = { env: "test", workspaceId: "0192f1a0-0000-7000-8000-00000000000a", userId: "u", ip: "203.0.113.7" };

  it("STORY-025 row 9 · writing the document to Valkey changes the enforced limit with no redeploy, within the bound", async () => {
    const clock = { ms: Date.now() };
    const limiter = new RateLimitBuckets(adapter, RATE_LIMIT_DEFAULTS, () => clock.ms);
    const firstAllowed = async (userId: string): Promise<number> => {
      for (let i = 0; i < 40; i++) {
        if (!(await limiter.check("writes", { ...IDENTITY, workspaceId: `${IDENTITY.workspaceId.slice(0, -4)}${userId.slice(0, 4).padEnd(4, "0")}`, userId })).allowed) return i;
      }
      return 40;
    };

    expect(await firstAllowed("before")).toBe(20);

    const tight = RATE_LIMIT_DEFAULTS.map((entry) =>
      entry.route_class === "writes"
        ? {
            // The tightest the envelope allows (a tenth of the default's burst 20 / 60 / 240); a tighter document falls back.
            route_class: "writes",
            burst: 2,
            buckets: [
              { scope: "user", limit: 6, window: "rolling", window_ms: 60_000 },
              { scope: "workspace", limit: 24, window: "rolling", window_ms: 60_000 },
            ],
          }
        : entry,
    );
    await adapter.set(rateLimitConfigKey("test"), JSON.stringify(tight), { ttlMs: 60_000 });
    clock.ms += 15_000;

    expect(await firstAllowed("after")).toBe(2);

    await adapter.delete(rateLimitConfigKey("test"));
    clock.ms += 15_000;
    expect(await firstAllowed("restored")).toBe(20);
  });
});
