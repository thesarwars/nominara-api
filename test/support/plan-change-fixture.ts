import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { RATE_LIMIT_DEFAULTS } from "../../src/api/rate-limit/defaults.js";
import { CACHE, type Cache } from "../../src/lib/cache/cache.port.js";
import { cacheKeyNamespace } from "../../src/lib/cache/key-namespace.js";
import { rateLimitConfigKey } from "../../src/lib/cache/valkey-keys.js";
import { STRIPE_GATEWAY } from "../../src/lib/billing/stripe/stripe-gateway.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { useApiHarness } from "./api-harness.js";
import { apiUrl } from "./api-url.js";
import { FakeStripeGateway, signFakeStripePayload } from "./fake-stripe-gateway.js";

// STORY-184 — the shared fixture of the plan-change specs: the REAL ApiModule on a real Postgres with RLS in force
// (nominara_app), Stripe replaced by the fake gateway (NO TEST CALLS THE REAL STRIPE API). A workspace is put on a paid
// plan the way production does it: a Stripe subscription fetched by the signed webhook, never a hand-written plan_key.

export type PlanName = "starter" | "growth" | "business";
export type Role = "owner" | "admin" | "manager" | "viewer";
export interface Held {
  kind: "extra_project" | "extra_seat";
  quantity: number;
}
export interface Actor {
  readonly accessToken: string;
  readonly csrfToken: string;
}

const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };
const DAY = 86_400;
/** Catalog prices in cents (migration 0002): monthly and annual. */
export const PRICES: Record<PlanName, Record<"monthly" | "annual", number>> = {
  starter: { monthly: 4_900, annual: 49_000 },
  growth: { monthly: 12_900, annual: 129_000 },
  business: { monthly: 34_900, annual: 349_000 },
};

/** The rate-limit document the specs install: `plan_change` at the TOP of what the envelope allows (x10), everything else the defaults. */
function widenedPlanChangeDocument(): string {
  return JSON.stringify(
    RATE_LIMIT_DEFAULTS.map((entry) =>
      entry.route_class === "plan_change_preview"
        ? { route_class: "plan_change_preview", burst: 50, buckets: [{ scope: "user", limit: 300, window: "rolling", window_ms: 3_600_000 }, { scope: "workspace", limit: 600, window: "rolling", window_ms: 3_600_000 }] }
        : entry.route_class === "plan_change"
        ? {
            route_class: "plan_change",
            burst: 20,
            buckets: [
              { scope: "user", limit: 50, window: "rolling", window_ms: 3_600_000 },
              { scope: "workspace", limit: 100, window: "rolling", window_ms: 3_600_000 },
            ],
          }
        : entry,
    ),
  );
}

export function usePlanChangeFixture(options: { readonly widenRateLimit?: boolean } = {}) {
  const gateway = new FakeStripeGateway();
  const harness = useApiHarness({
    env: () => {
      const url = new URL(process.env.DATABASE_URL!);
      url.username = "nominara_app";
      url.password = resolvePassword("nominara_app", {});
      return { DATABASE_URL_POOLED: url.toString() };
    },
    configure: (builder) => {
      builder.overrideProvider(STRIPE_GATEWAY).useValue(gateway);
    },
  });

  let pool: Pool;
  let sessions: SessionService;
  let workspaces: WorkspacesService;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await harness.db().query(`ALTER ROLE nominara_app PASSWORD '${resolvePassword("nominara_app", {})}'`);
    gateway.reset();
    // The production class lets a user spend 2 at once (burst 2, 5/hour); a spec that makes more calls than that per
    // workspace installs the widest document the envelope allows. plan-change-rate-limit.spec.ts runs on the defaults.
    if (options.widenRateLimit !== false) {
      await harness.app().get<Cache>(CACHE).set(rateLimitConfigKey(cacheKeyNamespace()), widenedPlanChangeDocument(), { ttlMs: 3_600_000 });
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const membership = new MembershipService(new MembershipCacheService());
    sessions = new SessionService(pool, membership, new InMemoryCacheAdapter());
    workspaces = new WorkspacesService(pool, new LocalDekProvisioner(Buffer.alloc(32, 7), "local:dev"), new AuditChainService(), membership, sessions, new NoopRealtimePublisher());
  });
  afterEach(async () => {
    await pool.end();
  });

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  /** The period the fake subscriptions run in: 10 days in, 20 to go. */
  const periodStart = () => nowSeconds() - 10 * DAY;
  const periodEnd = () => nowSeconds() + 20 * DAY;

  async function createUser(): Promise<string> {
    const r = await harness.db().query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${randomUUID()}@example.com`]);
    return r.rows[0]!.id;
  }
  async function enter(userId: string, workspaceId: string): Promise<Actor> {
    const tokens = await sessions.createSession(userId);
    return workspaces.switchTo(userId, tokens.sid, workspaceId, meta);
  }
  async function memberIn(workspaceId: string, role: Role): Promise<Actor> {
    const userId = await createUser();
    await harness.db().query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1,$2,$3,'active')", [workspaceId, userId, role]);
    return enter(userId, workspaceId);
  }

  const subIdOf = (workspaceId: string): string => `sub_${workspaceId}`;

  /** Stripe's CURRENT state of a workspace's subscription, as the gateway will fetch it. */
  function stripeSubscription(
    workspaceId: string,
    over: {
      plan?: PlanName;
      interval?: "monthly" | "annual";
      status?: string;
      held?: Held[];
      cancelAtPeriodEnd?: boolean;
      schedule?: string | null;
      metadata?: Record<string, string>;
      /** Overrides what the plan item is CHARGED (cents), to model a price that is not the catalog's. */
      amount?: number;
      periodStart?: number;
      periodEnd?: number;
    } = {},
  ): void {
    const plan = over.plan ?? "growth";
    const interval = over.interval ?? "monthly";
    const start = over.periodStart ?? periodStart();
    const end = over.periodEnd ?? periodEnd();
    const line = (kind: string, id: string, quantity: number, cents: number) => ({
      id,
      quantity,
      current_period_start: start,
      current_period_end: end,
      price: { id: `price_${id}`, unit_amount: cents, currency: "usd", recurring: { interval: interval === "annual" ? "year" : "month", interval_count: 1 }, product: { metadata: { nominara_kind: kind } } },
    });
    gateway.putObject(
      "subscription",
      subIdOf(workspaceId),
      { workspace_id: workspaceId, plan_key: plan, billing_interval: interval, ...(over.metadata ?? {}) },
      {
        customer: "cus_1",
        status: over.status ?? "active",
        cancel_at_period_end: over.cancelAtPeriodEnd ?? false,
        trial_end: null,
        schedule: over.schedule ?? null,
        metadata: { workspace_id: workspaceId, plan_key: plan, billing_interval: interval, ...(over.metadata ?? {}) },
        items: {
          data: [
            line("plan", "si_plan", 1, over.amount ?? PRICES[plan][interval]),
            ...(over.held ?? []).map((h) => line(h.kind, `si_${h.kind}`, h.quantity, h.kind === "extra_project" ? 4_900 : 1_500)),
          ],
        },
      },
    );
  }

  const eventBody = (id: string, type: string, objectId: string): string => JSON.stringify({ id, object: "event", type, data: { object: { id: objectId } } });
  const deliver = (body: string) =>
    harness.app().inject({ method: "POST", url: apiUrl("/webhooks/stripe"), headers: { "content-type": "application/json", "stripe-signature": signFakeStripePayload(body) }, payload: body });
  const reconcile = (workspaceId: string, eventId = `evt_${randomUUID()}`) => deliver(eventBody(eventId, "customer.subscription.updated", subIdOf(workspaceId)));

  /** A workspace on `plan`, its Stripe subscription adopted through the real webhook, plus its owner (re-entered after the version bump). */
  async function newWorkspace(plan: PlanName = "growth", opts: { interval?: "monthly" | "annual"; held?: Held[]; periodStart?: number; periodEnd?: number } = {}) {
    const ownerId = await createUser();
    const ws = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    stripeSubscription(ws.id, { plan, ...opts });
    const adopted = await deliver(eventBody(`evt_${randomUUID()}`, "customer.subscription.created", subIdOf(ws.id)));
    if (adopted.statusCode !== 200) throw new Error(`fixture: adoption failed ${adopted.body}`);
    return { workspaceId: ws.id, ownerId, owner: await enter(ownerId, ws.id) };
  }

  const cookies = (a: Actor) => ({ [ACCESS_COOKIE_NAME]: a.accessToken, [CSRF_COOKIE_NAME]: a.csrfToken });
  const get = (a: Actor, path: string) => harness.app().inject({ method: "GET", url: apiUrl(path), cookies: cookies(a) });
  const post = (a: Actor, path: string, payload: unknown, key: string | null = randomUUID()) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl(path),
      cookies: cookies(a),
      headers: { [CSRF_HEADER_NAME]: a.csrfToken, "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }) },
      payload: payload as object,
    });
  const put = (a: Actor, path: string, payload: unknown) =>
    harness.app().inject({ method: "PUT", url: apiUrl(path), cookies: cookies(a), headers: { [CSRF_HEADER_NAME]: a.csrfToken, "content-type": "application/json" }, payload: payload as object });
  const del = (a: Actor, path: string) => harness.app().inject({ method: "DELETE", url: apiUrl(path), cookies: cookies(a), headers: { [CSRF_HEADER_NAME]: a.csrfToken } });

  const planOf = async (workspaceId: string) =>
    (await harness.db().query<{ plan_key: string; ws_plan: string; entitlement_version: number }>(
      "SELECT s.plan_key, w.plan_key AS ws_plan, w.entitlement_version FROM subscriptions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.workspace_id = $1",
      [workspaceId],
    )).rows[0]!;
  const intentOf = async (workspaceId: string) =>
    (await harness.db().query<{ pending_plan_change: Record<string, unknown> | null }>("SELECT pending_plan_change FROM subscriptions WHERE workspace_id = $1", [workspaceId])).rows[0]!.pending_plan_change;
  const auditActions = async (workspaceId: string, action: string) =>
    (await harness.db().query("SELECT actor_type, action, before_state, after_state FROM audit_log WHERE workspace_id = $1 AND action = $2 ORDER BY seq", [workspaceId, action])).rows;
  /** A wallet mid-cycle: 10 days into a 30-day cycle. */
  async function walletFor(workspaceId: string, included = 450): Promise<void> {
    await harness.db().query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end) VALUES ($1, $2, (now() - interval '10 days')::date, (now() + interval '20 days')::date)`,
      [workspaceId, included],
    );
  }
  const includedOf = async (workspaceId: string): Promise<number> =>
    (await harness.db().query<{ included_balance: number }>("SELECT included_balance FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0]!.included_balance;
  const ledgerRows = async (workspaceId: string) =>
    (await harness.db().query<{ credits: number; reference_type: string }>("SELECT credits, reference_type FROM credit_ledger WHERE workspace_id = $1 ORDER BY id", [workspaceId])).rows;

  /** `n` live projects, the i-th created `n - i` hours ago (so index n-1 is the newest). */
  async function projects(workspaceId: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await harness.db().query<{ id: string }>(
        `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, created_at)
         VALUES ($1, $2, $3, 'https://example.com', 'example.com', now() - ($4 || ' hours')::interval) RETURNING id`,
        [workspaceId, `P${String(i)}`, `p${String(i)}-${randomUUID().slice(0, 6)}`, String(n - i)],
      );
      ids.push(r.rows[0]!.id);
    }
    return ids;
  }

  /** The workspace's owner user id (a fresh token is needed after a version bump). */
  const ownerOf = async (workspaceId: string): Promise<string> =>
    (await harness.db().query<{ user_id: string }>("SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'", [workspaceId])).rows[0]!.user_id;

  return {
    ownerOf, gateway, harness, meta, nowSeconds, periodStart, periodEnd, createUser, enter, memberIn, newWorkspace, stripeSubscription, subIdOf,
    eventBody, deliver, reconcile, cookies, get, post, put, del, planOf, intentOf, auditActions, walletFor, includedOf, ledgerRows, projects,
  };
}
