import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

// STORY-046 AC3 - the confirmed-price header through the REAL HTTP pipeline. Every price-quote scenario in
// prompt-activation-charge.spec.ts calls the services directly, so a controller that stopped passing the
// `X-Nominara-Confirmed-Credits` header on to the service would survive all of them. These go through
// harness.app().inject, on both doors: POST /projects/{id}/prompts/activate and PATCH /prompts/{id}.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

describe("STORY-046 AC3 · the confirmed-price header over HTTP", () => {
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
    await pool.end();
  });

  interface Actor {
    readonly workspaceId: string;
    readonly userId: string;
    readonly cookie: string;
    readonly csrf: string;
  }

  async function newUser(): Promise<string> {
    const userId = uuidV7();
    await harness.db().query(
      `INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`,
      [userId, `${userId}@example.test`],
    );
    return userId;
  }

  async function owner(plan: "starter" | "growth" | "business", opts: { stepUp?: boolean; role?: "owner" | "admin" } = {}): Promise<Actor> {
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
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 2);
    if (opts.stepUp !== false) await sessions.recordStrongAuth(tokens.sid, "webauthn");
    return { userId, workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  const HEADER = "x-nominara-confirmed-credits";
  const writeHeaders = (a: Actor, confirmed?: string): Record<string, string> => ({
    cookie: a.cookie,
    [CSRF_HEADER_NAME]: a.csrf,
    "content-type": "application/json",
    "idempotency-key": randomUUID(),
    ...(confirmed === undefined ? {} : { [HEADER]: confirmed }),
  });
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; details?: Record<string, unknown> } }).error;

  async function project(a: Actor): Promise<string> {
    const id = uuidV7();
    await harness.db().query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, status, cadence)
       VALUES ($1,$2,'P',$3,'https://e.test','e.test','active','weekly')`,
      [id, a.workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    return id;
  }
  async function fund(a: Actor): Promise<void> {
    await harness.db().query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end)
       VALUES ($1,100,(now() AT TIME ZONE 'UTC')::date,(now() AT TIME ZONE 'UTC')::date + 30)
       ON CONFLICT (workspace_id) DO UPDATE SET included_balance = 100`,
      [a.workspaceId],
    );
  }
  async function seed(a: Actor, projectId: string, count: number, status: string, stamped: boolean): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = uuidV7();
      ids.push(id);
      const text = `prompt ${randomUUID()}`;
      await harness.db().query(
        `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status,
                                      generation_source, first_activated_at)
         VALUES ($1,$2,$3,$4::text,sha256(convert_to($4::text,'UTF8')),'recommendation','consideration',$5,'generated',
                 CASE WHEN $6::boolean THEN now() ELSE NULL END)`,
        [id, a.workspaceId, projectId, text, status, stamped],
      );
    }
    return ids;
  }
  const ledgerRows = async (a: Actor): Promise<number> =>
    (await harness.db().query("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1", [a.workspaceId])).rows[0].n;
  const statusOf = async (id: string): Promise<string> =>
    (await harness.db().query("SELECT status FROM tracked_prompts WHERE id = $1", [id])).rows[0].status;

  /** Growth allows 10 free activations per project; the eleventh generated prompt costs 1 credit. */
  async function pricedActivate(): Promise<{ a: Actor; projectId: string; ids: string[]; price: number }> {
    const a = await owner("growth");
    await fund(a);
    const projectId = await project(a);
    const ids = await seed(a, projectId, 11, "archived", false);
    const quote = await harness.app().inject({
      method: "POST",
      url: apiUrl(`/projects/${projectId}/prompts/activate/preview`),
      headers: writeHeaders(a),
      payload: { prompt_ids: ids },
    });
    expect(quote.statusCode, quote.body).toBe(200);
    const price = (quote.json() as { data: { credits: number } }).data.credits;
    expect(price).toBeGreaterThan(0);
    return { a, projectId, ids, price };
  }
  const post = (a: Actor, projectId: string, ids: string[], confirmed?: string) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl(`/projects/${projectId}/prompts/activate`),
      headers: writeHeaders(a, confirmed),
      payload: { prompt_ids: ids },
    });

  it("STORY-046 AC3 · POST activate with a charge above 0 and NO header is refused, nothing activated, no ledger row", async () => {
    const { a, projectId, ids } = await pricedActivate();
    const res = await post(a, projectId, ids);
    expect(res.statusCode, res.body).toBe(400);
    expect(await ledgerRows(a)).toBe(0);
    expect(await statusOf(ids[0]!)).toBe("archived");
  }, 90_000);

  it("STORY-046 AC3 · POST activate with a MISMATCHED header is 409 price_changed, nothing activated, no ledger row", async () => {
    const { a, projectId, ids, price } = await pricedActivate();
    const res = await post(a, projectId, ids, String(price + 1));
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).code).toBe("price_changed");
    expect(await ledgerRows(a)).toBe(0);
    expect(await statusOf(ids[0]!)).toBe("archived");
  }, 90_000);

  it("STORY-046 AC3 · POST activate with the MATCHING header succeeds and debits exactly the quoted price", async () => {
    const { a, projectId, ids, price } = await pricedActivate();
    const res = await post(a, projectId, ids, String(price));
    expect(res.statusCode, res.body).toBe(200);
    expect(await ledgerRows(a)).toBeGreaterThan(0);
    const wallet = (await harness.db().query("SELECT included_balance::int AS b FROM credit_wallets WHERE workspace_id = $1", [a.workspaceId])).rows[0];
    expect(wallet.b).toBe(100 - price);
    expect(await statusOf(ids[0]!)).toBe("active");
  }, 90_000);

  /** Ten prompts already activated (free allowance spent, parked paused), one archived: re-activating it by PATCH costs. */
  async function pricedPatch(): Promise<{ a: Actor; id: string; price: number }> {
    const a = await owner("growth");
    await fund(a);
    const projectId = await project(a);
    await seed(a, projectId, 10, "paused", true);
    const [id] = await seed(a, projectId, 1, "archived", false);
    const quote = await harness.app().inject({
      method: "POST",
      url: apiUrl(`/projects/${projectId}/prompts/activate/preview`),
      headers: writeHeaders(a),
      payload: { prompt_ids: [id] },
    });
    expect(quote.statusCode, quote.body).toBe(200);
    const price = (quote.json() as { data: { credits: number } }).data.credits;
    expect(price).toBeGreaterThan(0);
    return { a, id: id!, price };
  }
  const patch = (a: Actor, id: string, confirmed?: string) =>
    harness.app().inject({
      method: "PATCH",
      url: apiUrl(`/prompts/${id}`),
      headers: writeHeaders(a, confirmed),
      payload: { status: "active" },
    });

  it("STORY-046 AC3 · PATCH /prompts/{id} that activates, charge above 0, NO header: refused, still archived, no ledger row", async () => {
    const { a, id } = await pricedPatch();
    const res = await patch(a, id);
    expect(res.statusCode, res.body).toBe(400);
    expect(await ledgerRows(a)).toBe(0);
    expect(await statusOf(id)).toBe("archived");
  }, 90_000);

  it("STORY-046 AC3 · PATCH /prompts/{id} that activates with a MISMATCHED header is 409 price_changed, no ledger row", async () => {
    const { a, id, price } = await pricedPatch();
    const res = await patch(a, id, String(price + 1));
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).code).toBe("price_changed");
    expect(await ledgerRows(a)).toBe(0);
    expect(await statusOf(id)).toBe("archived");
  }, 90_000);

  it("STORY-046 AC3 · PATCH /prompts/{id} that activates with the MATCHING header succeeds and debits the quoted price", async () => {
    const { a, id, price } = await pricedPatch();
    const res = await patch(a, id, String(price));
    expect(res.statusCode, res.body).toBe(200);
    expect(await ledgerRows(a)).toBeGreaterThan(0);
    const wallet = (await harness.db().query("SELECT included_balance::int AS b FROM credit_wallets WHERE workspace_id = $1", [a.workspaceId])).rows[0];
    expect(wallet.b).toBe(100 - price);
    expect(await statusOf(id)).toBe("active");
  }, 90_000);
});
