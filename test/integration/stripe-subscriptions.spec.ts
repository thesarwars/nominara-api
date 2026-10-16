import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscriptionSchema, type Subscription } from "../../contracts/billing/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { STRIPE_GATEWAY, StripeUpstreamError } from "../../src/lib/billing/stripe/stripe-gateway.js";
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
import { whileRequestConnectionIsKilledAfterStripeCreatesASession } from "../support/kill-request-connection.js";
import { dataOf } from "../support/envelope.js";
import { FakeStripeGateway, signFakeStripePayload } from "../support/fake-stripe-gateway.js";

// STORY-075a — subscription checkout, portal and fresh-fetch reconciliation
// through the REAL ApiModule, real Postgres, RLS in force (pool connects as
// nominara_app). Stripe is the fake gateway: NO TEST CALLS THE REAL STRIPE API.

const gateway = new FakeStripeGateway();
const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };
const T0 = Math.floor(Date.now() / 1000);

describe("STORY-075a · subscriptions", () => {
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
    gateway.objects.clear();
    gateway.checkouts.length = 0;
    gateway.expired.length = 0;
    gateway.completedSessions.clear();
    gateway.portals.length = 0;
    gateway.fetches.length = 0;
    gateway.configured = true;
    gateway.failFetchWith = undefined;
    gateway.onSessionCreated = undefined;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const membership = new MembershipService(new MembershipCacheService());
    sessions = new SessionService(pool, membership, new InMemoryCacheAdapter());
    workspaces = new WorkspacesService(
      pool,
      new LocalDekProvisioner(Buffer.alloc(32, 7), "local:dev"),
      new AuditChainService(),
      membership,
      sessions,
      new NoopRealtimePublisher(),
    );
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
    readonly sid: string;
    readonly userId: string;
  }
  async function actorIn(workspaceId: string, role: "owner" | "admin" | "manager" | "viewer"): Promise<Actor> {
    const userId = await createUser();
    await harness.db().query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1,$2,$3,'active')", [workspaceId, userId, role]);
    const tokens = await sessions.createSession(userId);
    const entered = await workspaces.switchTo(userId, tokens.sid, workspaceId, meta);
    return { ...entered, sid: tokens.sid, userId };
  }
  async function newWorkspace(): Promise<{ workspaceId: string; owner: Actor }> {
    const ownerId = await createUser();
    const ws = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    const tokens = await sessions.createSession(ownerId);
    const entered = await workspaces.switchTo(ownerId, tokens.sid, ws.id, meta);
    return { workspaceId: ws.id, owner: { ...entered, sid: tokens.sid, userId: ownerId } };
  }

  /** A fresh token after a version bump — the recovery a client performs on entitlement_stale. */
  async function reenter(a: Actor, workspaceId: string): Promise<Actor> {
    const entered = await workspaces.switchTo(a.userId, a.sid, workspaceId, meta);
    return { ...a, ...entered };
  }

  const cookies = (a: Actor) => ({ [ACCESS_COOKIE_NAME]: a.accessToken, [CSRF_COOKIE_NAME]: a.csrfToken });
  const post = (a: Actor, path: string, payload: unknown = {}, key: string = randomUUID()) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl(path),
      cookies: cookies(a),
      headers: { [CSRF_HEADER_NAME]: a.csrfToken, "content-type": "application/json", "idempotency-key": key },
      payload: payload as object,
    });
  const get = (a: Actor, path: string) => harness.app().inject({ method: "GET", url: apiUrl(path), cookies: cookies(a) });

  const eventBody = (id: string, type: string, objectId: string): string =>
    JSON.stringify({ id, object: "event", type, data: { object: { id: objectId } } });
  const deliver = (body: string) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl("/webhooks/stripe"),
      headers: { "content-type": "application/json", "stripe-signature": signFakeStripePayload(body) },
      payload: body,
    });
  const outcomeOf = (res: { json: <T>() => T }): string => res.json<{ data: { outcome: string } }>().data.outcome;

  /** Stripe's CURRENT state of a subscription, as the gateway will fetch it. */
  function stripeSubscription(
    workspaceId: string,
    over: {
      id?: string;
      customer?: string;
      status?: string;
      plan?: string;
      interval?: "month" | "year";
      cancelAtPeriodEnd?: boolean;
      extraSeats?: number;
      extraProjects?: number;
      /** What Stripe actually charges per interval, in cents; defaults to the catalog price of `plan`. */
      amount?: number;
      currency?: string;
      /** The checkout intent our own Checkout wrote into the subscription's metadata. */
      intentId?: string;
    } = {},
  ): string {
    // The catalog (migration 0002): monthly / annual dollars per plan.
    const catalog: Record<string, [number, number]> = { starter: [49, 490], growth: [129, 1290], business: [349, 3490] };
    const plan = over.plan ?? "growth";
    const charged = over.amount ?? (catalog[plan] ?? [0, 0])[over.interval === "year" ? 1 : 0]! * 100;
    const id = over.id ?? "sub_1";
    const data: unknown[] = [
      {
        quantity: 1,
        current_period_start: T0,
        current_period_end: T0 + 30 * 86_400,
        price: {
          unit_amount: charged,
          currency: over.currency ?? "usd",
          recurring: { interval: over.interval ?? "month" },
          product: { metadata: { nominara_kind: "plan" } },
        },
      },
    ];
    if (over.extraSeats) data.push({ quantity: over.extraSeats, price: { product: { metadata: { nominara_kind: "extra_seat" } } } });
    if (over.extraProjects) data.push({ quantity: over.extraProjects, price: { product: { metadata: { nominara_kind: "extra_project" } } } });
    gateway.putObject(
      "subscription",
      id,
      {
        workspace_id: workspaceId,
        plan_key: plan,
        billing_interval: over.interval === "year" ? "annual" : "monthly",
        ...(over.intentId === undefined ? {} : { checkout_intent_id: over.intentId }),
      },
      { customer: over.customer ?? "cus_1", status: over.status ?? "active", cancel_at_period_end: over.cancelAtPeriodEnd ?? false, trial_end: null, items: { data } },
    );
    return id;
  }

  const row = async (workspaceId: string) =>
    (
      await harness.db().query(
        `SELECT s.plan_key, s.billing_interval, s.status, s.provider, s.stripe_customer_id, s.stripe_subscription_id, s.cancel_at_period_end,
                s.seats_purchased, s.projects_purchased, s.current_period_start, s.current_period_end, w.plan_key AS ws_plan, w.entitlement_version
           FROM subscriptions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.workspace_id = $1`,
        [workspaceId],
      )
    ).rows[0];
  const auditRows = async (workspaceId: string) =>
    (await harness.db().query("SELECT actor_type, action, request_id, after_state FROM audit_log WHERE workspace_id = $1 AND action = 'workspace.plan_changed' ORDER BY seq", [workspaceId])).rows;

  /**
   * STORY-184 — a plan on a TRACKED subscription moves only through the workspace's own recorded intent (the in-app plan
   * change writes it before asking Stripe, and Stripe echoes its id in the subscription's metadata). A bare relabel is
   * refused (plan-change-webhook.spec.ts proves that and every wrong intent). Tests here that model "the customer changed
   * plan in Stripe" therefore carry the intent the product would have recorded: call AFTER `stripeSubscription(...)`.
   */
  async function withPlanChangeIntent(workspaceId: string, from: string, to: string, cents: number, subscriptionId = "sub_1"): Promise<string> {
    const intentId = randomUUID();
    const direction = ["free", "starter", "growth", "business"].indexOf(to) > ["free", "starter", "growth", "business"].indexOf(from) ? "upgrade" : "downgrade";
    await harness.db().query("UPDATE subscriptions SET pending_plan_change = $2::jsonb WHERE workspace_id = $1", [
      workspaceId,
      JSON.stringify({
        id: intentId, direction, from_plan_key: from, to_plan_key: to, billing_interval: "monthly", unit_amount_cents: cents, currency: "USD",
        effective: direction === "upgrade" ? "immediate" : "period_end", effective_at: null, stripe_subscription_id: subscriptionId, stripe_idempotency_key: `plan-change-${intentId}`,
        proration_date: null, amount_due_now_cents: null, schedule_id: null, created_at: new Date().toISOString(), settled_at: new Date().toISOString(),
      }),
    ]);
    const stored = gateway.objects.get(`subscription:${subscriptionId}`)!;
    gateway.objects.set(`subscription:${subscriptionId}`, { ...stored, metadata: { ...stored.metadata, plan_change_intent_id: intentId } });
    return intentId;
  }

  // ---- STORY-075 AC1 / scenario 1 -----------------------------------------------------------------

  it("scenario 1 · checkout is billing:write only; owner and admin get a hosted URL, manager and viewer a 403 naming the permission", async () => {
    const { workspaceId, owner } = await newWorkspace();
    expect((await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" })).statusCode).toBe(200);
    expect((await post(await actorIn(workspaceId, "admin"), "/billing/portal-session")).statusCode, "admin is allowed past the permission").not.toBe(403);
    for (const role of ["manager", "viewer"] as const) {
      const a = await actorIn(workspaceId, role);
      for (const path of ["/billing/checkout-session", "/billing/portal-session"]) {
        const res = await post(a, path, path.includes("checkout") ? { plan_key: "growth", billing_interval: "monthly" } : {});
        expect(res.statusCode, `${role} ${path}`).toBe(403);
        expect(res.body).toContain("billing:write");
      }
    }
  });

  it("scenario 1 · the session carries client_reference_id inputs and the workspace in subscription metadata, prices from the catalog, and never a client-chosen redirect", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const res = await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "annual" });
    expect(res.statusCode, res.body).toBe(200);
    expect(dataOf<{ checkout_url: string }>(res).checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//u);
    expect(gateway.checkouts).toHaveLength(1);
    const input = gateway.checkouts[0]!;
    expect(input).toMatchObject({ workspaceId, planKey: "growth", billingInterval: "annual", unitAmountCents: 129_000, currency: "USD" });
    expect(input.customerId, "a free workspace has no Stripe customer to reuse").toBeUndefined();
    expect(input.successUrl).toBe("http://localhost:3000/settings/plan?checkout=success");
    expect(input.cancelUrl).toBe("http://localhost:3000/settings/plan?checkout=cancel");
    // The plan has NOT changed: only the webhook may do that.
    expect((await row(workspaceId)).plan_key).toBe("free");
  });

  it("scenario 13 · creating a checkout or portal session is itself audited against the workspace, without touching the plan", async () => {
    const { workspaceId, owner } = await newWorkspace();
    await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" });
    const rows = await harness.db().query("SELECT action, resource_type, resource_id FROM audit_log WHERE workspace_id = $1 AND action LIKE 'billing.%'", [workspaceId]);
    expect(rows.rows).toEqual([{ action: "billing.checkout_session.created", resource_type: "workspace", resource_id: workspaceId }]);
  });

  it("scenario 1 · a request naming a redirect or any unknown key is a 400, not a silent drop (.strict())", async () => {
    const { owner } = await newWorkspace();
    const res = await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly", success_url: "https://evil.test" });
    expect(res.statusCode).toBe(400);
    expect(gateway.checkouts).toHaveLength(0);
  });

  it.each(["free", "enterprise", "nonexistent"])("a %s plan is refused before any Stripe call", async (plan) => {
    const { owner } = await newWorkspace();
    const res = await post(owner, "/billing/checkout-session", { plan_key: plan, billing_interval: "monthly" });
    expect(res.statusCode).toBe(400);
    expect(gateway.checkouts).toHaveLength(0);
  });

  it("a workspace already subscribed through Stripe is told to use the portal (409) — a second subscription is a double charge", async () => {
    const { workspaceId, owner: first } = await newWorkspace();
    await deliver(eventBody("evt_a", "customer.subscription.created", stripeSubscription(workspaceId)));
    const owner = await reenter(first, workspaceId);
    const res = await post(owner, "/billing/checkout-session", { plan_key: "business", billing_interval: "monthly" });
    expect(res.statusCode).toBe(409);
    expect(gateway.checkouts).toHaveLength(0);
  });

  it("unconfigured Stripe is a 503 degraded; a Stripe outage is a 503 with no Stripe text", async () => {
    const { owner } = await newWorkspace();
    gateway.configured = false;
    expect((await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" })).statusCode).toBe(503);
    gateway.configured = true;
    gateway.failFetchWith = new StripeUpstreamError(500);
    const res = await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("StripeUpstreamError");
  });

  it("scenario 1 · after the webhook, the subscription read and the entitlements resolve to the new plan", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const subId = stripeSubscription(workspaceId, { extraSeats: 2, extraProjects: 1 });
    const body = JSON.stringify({ id: "evt_co", object: "event", type: "checkout.session.completed", data: { object: { id: "cs_1" } } });
    gateway.putObject("checkout_session", "cs_1", { workspace_id: workspaceId }, { mode: "subscription", subscription: subId });
    const res = await deliver(body);
    expect(res.statusCode, res.body).toBe(200);
    expect(outcomeOf(res)).toBe("processed");

    const r = await row(workspaceId);
    expect(r).toMatchObject({ plan_key: "growth", ws_plan: "growth", provider: "stripe", status: "active", stripe_subscription_id: subId, stripe_customer_id: "cus_1", seats_purchased: 3, projects_purchased: 1 });

    // A fresh token: the version bump made the old one stale (scenario 6).
    const fresh = await reenter(owner, workspaceId);
    const sub = await get(fresh, "/billing/subscription");
    expect(sub.statusCode, sub.body).toBe(200);
    const parsed = subscriptionSchema.parse(dataOf<Subscription>(sub));
    expect(parsed).toMatchObject({ plan_key: "growth", provider: "stripe", status: "active", seats_purchased: 3, projects_purchased: 1, cancel_at_period_end: false });
    const ent = await get(fresh, "/billing/entitlements");
    expect(ent.statusCode, ent.body).toBe(200);
    expect(ent.body).toContain("growth");
  });

  it("GET /billing/subscription is billing:read: a viewer gets 403 naming it", async () => {
    const { workspaceId } = await newWorkspace();
    const res = await get(await actorIn(workspaceId, "viewer"), "/billing/subscription");
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("billing:read");
  });

  // ---- portal -------------------------------------------------------------------------------------

  it("portal · a workspace with no Stripe billing account gets 422, not a made-up customer", async () => {
    const { owner } = await newWorkspace();
    const res = await post(owner, "/billing/portal-session");
    expect(res.statusCode).toBe(422);
    expect(gateway.portals).toHaveLength(0);
  });

  it("portal · the customer comes from the caller's own workspace subscription, and a stray customer_id is a 400", async () => {
    const { workspaceId, owner } = await newWorkspace();
    await deliver(eventBody("evt_p", "customer.subscription.created", stripeSubscription(workspaceId)));
    const fresh = await reenter(owner, workspaceId);
    const bad = await post(fresh, "/billing/portal-session", { customer_id: "cus_other" });
    expect(bad.statusCode).toBe(400);
    const ok = await post(fresh, "/billing/portal-session");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(gateway.portals).toEqual([{ customerId: "cus_1", returnUrl: "http://localhost:3000/settings/plan" }]);
  });

  // ---- STORY-075 AC4 / scenario 5 -----------------------------------------------------------------

  it("scenario 5 · two events delivered in either order leave the same row", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    // Both workspaces end up pointing at the same Stripe state (business, annual, cancelling).
    for (const [ws, order] of [[a.workspaceId, ["evt_1", "evt_2"]], [b.workspaceId, ["evt_2", "evt_1"]]] as const) {
      const sub = stripeSubscription(ws, { id: `sub_${ws}`, plan: "business", interval: "year", cancelAtPeriodEnd: true });
      for (const [i, id] of order.entries()) {
        const type = id === "evt_1" ? "customer.subscription.created" : "customer.subscription.updated";
        const res = await deliver(eventBody(`${id}_${ws}`, type, sub));
        expect(res.statusCode, `${String(i)} ${res.body}`).toBe(200);
      }
    }
    const strip = (r: Record<string, unknown>) => {
      const { stripe_subscription_id: _s, entitlement_version: _v, ...rest } = r;
      return rest;
    };
    const [ra, rb] = [await row(a.workspaceId), await row(b.workspaceId)];
    expect(strip(ra)).toEqual(strip(rb));
    expect(ra).toMatchObject({ plan_key: "business", billing_interval: "annual", cancel_at_period_end: true, entitlement_version: rb.entitlement_version });
  });

  it("scenario 5 · the written state is Stripe's CURRENT state, not the state the event described", async () => {
    const { workspaceId } = await newWorkspace();
    // The "created" event is delivered late, after Stripe already moved on to business.
    const sub = stripeSubscription(workspaceId, { plan: "business" });
    await deliver(eventBody("evt_late", "customer.subscription.created", sub));
    expect((await row(workspaceId)).plan_key).toBe("business");
  });

  // ---- scenario 4 / 7: redelivery and idempotent upgrade ------------------------------------------

  it("scenario 4 + 7 · a redelivered event is a no-op, and a NEW event carrying unchanged state changes nothing (version, audit, credits)", async () => {
    const { workspaceId } = await newWorkspace();
    const sub = stripeSubscription(workspaceId);
    const first = await deliver(eventBody("evt_up", "customer.subscription.created", sub));
    expect(outcomeOf(first)).toBe("processed");
    const after = await row(workspaceId);

    expect(outcomeOf(await deliver(eventBody("evt_up", "customer.subscription.created", sub)))).toBe("duplicate");
    expect(outcomeOf(await deliver(eventBody("evt_up2", "customer.subscription.updated", sub)))).toBe("processed");

    expect(await row(workspaceId)).toEqual(after);
    expect(await auditRows(workspaceId)).toHaveLength(1);
  });

  it("scenario 7 · an upgrade applies immediately with a pro-rata top-up from plan-grant, written once", async () => {
    const { workspaceId } = await newWorkspace();
    const db = harness.db();
    // A wallet mid-cycle: 10 days into a 30-day cycle, on free's 60-credit grant.
    await db.query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end)
       VALUES ($1, 60, (now() - interval '10 days')::date, (now() + interval '20 days')::date)`,
      [workspaceId],
    );
    const sub = stripeSubscription(workspaceId, { plan: "growth" });
    await deliver(eventBody("evt_g1", "customer.subscription.created", sub));
    const granted = await db.query("SELECT credits, idempotency_key FROM credit_ledger WHERE workspace_id = $1 AND reference_type = 'plan_change'", [workspaceId]);
    expect(granted.rows).toHaveLength(1);
    // (1200 - 60) * ~20/30, floored: strictly between 0 and the full uplift, and recorded as a grant.
    expect(granted.rows[0].credits).toBeGreaterThan(600);
    expect(granted.rows[0].credits).toBeLessThan(1140);
    const included = (await db.query("SELECT included_balance FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0].included_balance;
    expect(included).toBe(60 + granted.rows[0].credits);

    await deliver(eventBody("evt_g2", "customer.subscription.updated", sub));
    const again = await db.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1 AND reference_type = 'plan_change'", [workspaceId]);
    expect(again.rows, "a redelivery must not top up twice").toHaveLength(1);
  });

  // ---- scenario 6 --------------------------------------------------------------------------------

  it("scenario 6 · a plan change bumps entitlement_version and a token minted before it gets 401 entitlement_stale", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const before = (await row(workspaceId)).entitlement_version as number;
    expect((await get(owner, "/billing/subscription")).statusCode).toBe(200);

    await deliver(eventBody("evt_v", "customer.subscription.created", stripeSubscription(workspaceId)));
    expect((await row(workspaceId)).entitlement_version).toBe(before + 1);

    const stale = await get(owner, "/billing/subscription");
    expect(stale.statusCode).toBe(401);
    expect(stale.json<{ error: { details?: { reason?: string } } }>().error.details?.reason).toBe("entitlement_stale");
  });

  // ---- scenario 8 --------------------------------------------------------------------------------

  it("scenario 8 · a downgrade changes feature access now and labels the structural reductions deferred; nothing is paused", async () => {
    const { workspaceId } = await newWorkspace();
    await deliver(eventBody("evt_d1", "customer.subscription.created", stripeSubscription(workspaceId, { plan: "business" })));
    const versionBefore = (await row(workspaceId)).entitlement_version as number;

    stripeSubscription(workspaceId, { plan: "starter" });
    await withPlanChangeIntent(workspaceId, "business", "starter", 4_900);
    const res = await deliver(eventBody("evt_d2", "customer.subscription.updated", "sub_1"));
    expect(res.statusCode, res.body).toBe(200);
    const r = await row(workspaceId);
    expect(r).toMatchObject({ plan_key: "starter", ws_plan: "starter" });
    expect(r.entitlement_version).toBe(versionBefore + 1);

    const audits = await auditRows(workspaceId);
    expect(audits.at(-1)!.after_state).toMatchObject({ downgrade: { feature_access: "applied", structural_reductions: "deferred_to_story_077" } });
    expect(audits.at(-1)!.after_state.credits_topped_up).toBe(0);
  });

  it("scenario 8 · cancellation at period end only sets the flag; the plan holds until Stripe deletes the subscription", async () => {
    const { workspaceId } = await newWorkspace();
    await deliver(eventBody("evt_c1", "customer.subscription.created", stripeSubscription(workspaceId)));
    stripeSubscription(workspaceId, { cancelAtPeriodEnd: true });
    await deliver(eventBody("evt_c2", "customer.subscription.updated", "sub_1"));
    expect(await row(workspaceId)).toMatchObject({ plan_key: "growth", cancel_at_period_end: true, status: "active" });

    stripeSubscription(workspaceId, { status: "canceled", cancelAtPeriodEnd: true });
    await deliver(eventBody("evt_c3", "customer.subscription.deleted", "sub_1"));
    // Back to free on the one live row, customer link kept, so the workspace can buy again.
    expect(await row(workspaceId)).toMatchObject({ plan_key: "free", ws_plan: "free", status: "active", provider: "stripe", stripe_customer_id: "cus_1" });
    stripeSubscription(workspaceId, { id: "sub_2", plan: "starter" });
    await deliver(eventBody("evt_c4", "customer.subscription.created", "sub_2"));
    expect(await row(workspaceId)).toMatchObject({ plan_key: "starter", stripe_subscription_id: "sub_2" });
  });

  it("a late event for an OLD, ended subscription cannot take the plan away from the newer one", async () => {
    const { workspaceId } = await newWorkspace();
    stripeSubscription(workspaceId, { id: "sub_old", status: "canceled" });
    stripeSubscription(workspaceId, { id: "sub_new", plan: "business" });
    await deliver(eventBody("evt_n1", "customer.subscription.created", "sub_new"));
    await deliver(eventBody("evt_n2", "customer.subscription.deleted", "sub_old"));
    expect(await row(workspaceId)).toMatchObject({ plan_key: "business", stripe_subscription_id: "sub_new" });
  });

  it("audit · two live Stripe subscriptions for one workspace: the first holds; delivering either's events alternately flips nothing and mints nothing", async () => {
    const { workspaceId } = await newWorkspace();
    const db = harness.db();
    await db.query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end)
       VALUES ($1, 60, (now() - interval '10 days')::date, (now() + interval '20 days')::date)`,
      [workspaceId],
    );
    // Two checkouts opened from free: each Stripe session created its own customer.
    stripeSubscription(workspaceId, { id: "sub_s2", customer: "cus_2", plan: "starter" });
    stripeSubscription(workspaceId, { id: "sub_s1", customer: "cus_9", plan: "growth" });
    await deliver(eventBody("evt_d0", "customer.subscription.created", "sub_s2"));
    const settled = await row(workspaceId);
    expect(settled).toMatchObject({ plan_key: "starter", stripe_subscription_id: "sub_s2", stripe_customer_id: "cus_2" });
    const ledger = async () => (await db.query("SELECT idempotency_key FROM credit_ledger WHERE workspace_id = $1 ORDER BY idempotency_key", [workspaceId])).rows;
    const ledgerSettled = await ledger();

    const alarm = vi.spyOn(Logger.prototype, "error");
    for (const [i, sub] of ["sub_s1", "sub_s2", "sub_s1", "sub_s2", "sub_s1"].entries()) {
      const res = await deliver(eventBody(`evt_d${String(i + 1)}`, "customer.subscription.updated", sub));
      expect(res.statusCode, res.body).toBe(200);
      expect(await row(workspaceId), `after event ${String(i)}`).toEqual(settled);
      expect(await ledger()).toEqual(ledgerSettled);
    }
    expect(alarm, "a double subscription is alarmed, not silently dropped").toHaveBeenCalled();
    expect(await auditRows(workspaceId)).toHaveLength(1);
  });

  it("audit · a fetch taken before a newer event committed cannot overwrite it", async () => {
    const { workspaceId } = await newWorkspace();
    const db = harness.db();
    await db.query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end)
       VALUES ($1, 60, (now() - interval '10 days')::date, (now() + interval '20 days')::date)`,
      [workspaceId],
    );
    stripeSubscription(workspaceId, { id: "sub_r", plan: "growth" });
    await deliver(eventBody("evt_r0", "customer.subscription.created", "sub_r"));
    expect(await row(workspaceId)).toMatchObject({ plan_key: "growth" });

    // Event A fetches while the subscription is active on growth, and is held.
    const release = gateway.holdNextFetch("subscription", "sub_r");
    const fetchesBefore = gateway.fetches.length;
    const stale = deliver(eventBody("evt_rA", "customer.subscription.updated", "sub_r"));
    await vi.waitFor(() => expect(gateway.fetches.length).toBe(fetchesBefore + 1));
    // Stripe cancels; event B fetches the canceled state and commits first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    stripeSubscription(workspaceId, { id: "sub_r", plan: "growth", status: "canceled" });
    expect(outcomeOf(await deliver(eventBody("evt_rB", "customer.subscription.deleted", "sub_r")))).toBe("processed");
    const afterB = await row(workspaceId);
    expect(afterB).toMatchObject({ plan_key: "free", ws_plan: "free" });
    const ledgerB = (await db.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1", [workspaceId])).rowCount;

    release();
    expect((await stale).statusCode).toBe(200);
    expect(await row(workspaceId), "the stale growth snapshot must not resurrect a canceled plan").toEqual(afterB);
    expect((await db.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1", [workspaceId])).rowCount).toBe(ledgerB);
  });

  it("an incomplete subscription (first payment not taken) changes nothing", async () => {
    const { workspaceId } = await newWorkspace();
    const warn = vi.spyOn(Logger.prototype, "warn");
    const before = await row(workspaceId);
    const res = await deliver(eventBody("evt_i", "customer.subscription.created", stripeSubscription(workspaceId, { status: "incomplete" })));
    expect(res.statusCode).toBe(200);
    expect(await row(workspaceId)).toEqual(before);
    expect(warn).toHaveBeenCalled();
  });

  // ---- scenario 13 + the STORY-151 invariant ------------------------------------------------------

  it("scenario 13 · every state change writes one audit row, actor_type 'system', carrying the Stripe event id", async () => {
    const { workspaceId } = await newWorkspace();
    await deliver(eventBody("evt_au1", "customer.subscription.created", stripeSubscription(workspaceId)));
    stripeSubscription(workspaceId, { plan: "business" });
    await withPlanChangeIntent(workspaceId, "growth", "business", 34_900);
    await deliver(eventBody("evt_au2", "customer.subscription.updated", "sub_1"));
    const audits = await auditRows(workspaceId);
    expect(audits.map((a) => [a.actor_type, a.request_id])).toEqual([
      ["system", "evt_au1"],
      ["system", "evt_au2"],
    ]);
  });

  it("STORY-151 invariant · after webhook-driven changes no paid plan has provider 'none'", async () => {
    const { workspaceId } = await newWorkspace();
    await deliver(eventBody("evt_inv", "customer.subscription.created", stripeSubscription(workspaceId)));
    const n = await harness.db().query("SELECT count(*)::int AS n FROM subscriptions WHERE plan_key <> 'free' AND provider = 'none'");
    expect(n.rows[0].n).toBe(0);
  });

  it("tenant isolation · a subscription event for workspace A writes nothing in workspace B", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    const bBefore = await row(b.workspaceId);
    await deliver(eventBody("evt_iso", "customer.subscription.created", stripeSubscription(a.workspaceId)));
    expect(await row(b.workspaceId)).toEqual(bBefore);
    expect((await row(a.workspaceId)).plan_key).toBe("growth");
  });

  // ---- checkpoint-1 · d-billing re-audit ----------------------------------------------------------

  async function walletFor(workspaceId: string): Promise<void> {
    await harness.db().query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end)
       VALUES ($1, 60, (now() - interval '10 days')::date, (now() + interval '20 days')::date)`,
      [workspaceId],
    );
  }
  const ledgerCount = async (workspaceId: string): Promise<number> =>
    (await harness.db().query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1", [workspaceId])).rowCount ?? 0;

  it("CP1 BLOCKER · a cancelled NEW subscription's held 'active' fetch cannot resurrect it or earn credits", async () => {
    const { workspaceId } = await newWorkspace();
    await walletFor(workspaceId);
    const before = await row(workspaceId);
    expect(before).toMatchObject({ plan_key: "free" });
    stripeSubscription(workspaceId, { id: "sub_n", plan: "growth" });

    // `customer.subscription.created` fetches the subscription active, and is held.
    const release = gateway.holdNextFetch("subscription", "sub_n");
    const fetchesBefore = gateway.fetches.length;
    const stale = deliver(eventBody("evt_nA", "customer.subscription.created", "sub_n"));
    await vi.waitFor(() => expect(gateway.fetches.length).toBe(fetchesBefore + 1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The customer cancels; `customer.subscription.deleted` fetches `canceled` and commits first.
    stripeSubscription(workspaceId, { id: "sub_n", plan: "growth", status: "canceled" });
    expect(outcomeOf(await deliver(eventBody("evt_nB", "customer.subscription.deleted", "sub_n")))).toBe("processed");
    const afterCancel = await row(workspaceId);
    expect(afterCancel).toMatchObject({ plan_key: "free", ws_plan: "free" });
    const ledgerAfterCancel = await ledgerCount(workspaceId);

    release();
    expect((await stale).statusCode).toBe(200);
    expect(await row(workspaceId), "the stale 'active growth' snapshot must not resurrect a cancelled subscription").toEqual(afterCancel);
    expect(await ledgerCount(workspaceId), "and must not earn a pro-rata grant").toBe(ledgerAfterCancel);
  });

  it("CP1 BLOCKER · the same through checkout.session.completed, and when re-subscribing after an earlier cancel", async () => {
    const { workspaceId } = await newWorkspace();
    await walletFor(workspaceId);
    // An earlier subscription was bought and cancelled.
    stripeSubscription(workspaceId, { id: "sub_first", plan: "starter" });
    await deliver(eventBody("evt_e1", "customer.subscription.created", "sub_first"));
    stripeSubscription(workspaceId, { id: "sub_first", plan: "starter", status: "canceled" });
    await deliver(eventBody("evt_e2", "customer.subscription.deleted", "sub_first"));
    expect(await row(workspaceId)).toMatchObject({ plan_key: "free" });

    // A second one: its checkout.session.completed follows the session to the subscription, and is held there.
    stripeSubscription(workspaceId, { id: "sub_second", plan: "business" });
    gateway.putObject("checkout_session", "cs_second", { workspace_id: workspaceId }, { mode: "subscription", subscription: "sub_second" });
    const release = gateway.holdNextFetch("subscription", "sub_second");
    const fetchesBefore = gateway.fetches.length;
    const stale = deliver(eventBody("evt_s1", "checkout.session.completed", "cs_second"));
    await vi.waitFor(() => expect(gateway.fetches.length).toBe(fetchesBefore + 2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    stripeSubscription(workspaceId, { id: "sub_second", plan: "business", status: "canceled" });
    await deliver(eventBody("evt_s2", "customer.subscription.deleted", "sub_second"));
    const settled = await row(workspaceId);
    const ledgerSettled = await ledgerCount(workspaceId);

    release();
    expect((await stale).statusCode).toBe(200);
    expect(await row(workspaceId)).toEqual(settled);
    expect(settled).toMatchObject({ plan_key: "free", ws_plan: "free" });
    expect(await ledgerCount(workspaceId)).toBe(ledgerSettled);
  });

  it("CP1 MINOR · the stale guard is ordered by the database clock: an instance whose wall clock runs an hour behind does not drop a newer write", async () => {
    const { workspaceId } = await newWorkspace();
    stripeSubscription(workspaceId, { id: "sub_k", plan: "growth" });
    expect(outcomeOf(await deliver(eventBody("evt_k1", "customer.subscription.created", "sub_k")))).toBe("processed");
    expect(await row(workspaceId)).toMatchObject({ plan_key: "growth" });

    // The customer upgrades; the API instance that handles it has a clock one hour slow.
    stripeSubscription(workspaceId, { id: "sub_k", plan: "business" });
    await withPlanChangeIntent(workspaceId, "growth", "business", 34_900, "sub_k");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 3_600_000 });
    try {
      expect(outcomeOf(await deliver(eventBody("evt_k2", "customer.subscription.updated", "sub_k")))).toBe("processed");
    } finally {
      vi.useRealTimers();
    }
    expect(await row(workspaceId), "a paid upgrade must not be dropped as 'stale' because of clock skew").toMatchObject({ plan_key: "business" });
  });

  // ---- checkpoint-1 · a double subscription is PREVENTED, not just detected -----------------------

  it("CP1 MAJOR · opening a second checkout expires the first open session at Stripe, so only one can be paid", async () => {
    const { owner } = await newWorkspace();
    const first = await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" });
    expect(first.statusCode, first.body).toBe(200);
    expect(gateway.expired).toEqual([]);
    const second = await post(owner, "/billing/checkout-session", { plan_key: "starter", billing_interval: "monthly" });
    expect(second.statusCode, second.body).toBe(200);
    expect(gateway.checkouts).toHaveLength(2);
    expect(gateway.expired, "the earlier session is expired before the new one is handed out").toEqual(["cs_test_1"]);
    // A third supersedes the second only.
    expect((await post(owner, "/billing/checkout-session", { plan_key: "business", billing_interval: "annual" })).statusCode).toBe(200);
    expect(gateway.expired).toEqual(["cs_test_1", "cs_test_2"]);
  });

  it("CP1 MAJOR · two checkouts opened at the same moment leave exactly one payable session", async () => {
    const { owner } = await newWorkspace();
    const results = await Promise.all([
      post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" }),
      post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" }),
    ]);
    const created = results.filter((r) => r.statusCode === 200).length;
    expect(results.every((r) => r.statusCode === 200 || r.statusCode === 409), results.map((r) => r.body).join("|")).toBe(true);
    expect(gateway.checkouts).toHaveLength(created);
    expect(gateway.checkouts.length - gateway.expired.length, "sessions created minus sessions expired = sessions still payable").toBe(1);
  });

  it("CP1 MAJOR · a previous session that was already PAID (webhook not yet applied) is a 409, and no second session is created", async () => {
    const { owner } = await newWorkspace();
    expect((await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" })).statusCode).toBe(200);
    gateway.completedSessions.set("cs_test_1", { subscriptionLive: true });
    const res = await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" });
    expect(res.statusCode, res.body).toBe(409);
    expect(gateway.checkouts).toHaveLength(1);
  });

  it("CP1 MAJOR · a paid session whose subscription has since ended does not block a new checkout forever", async () => {
    const { owner } = await newWorkspace();
    expect((await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" })).statusCode).toBe(200);
    gateway.completedSessions.set("cs_test_1", { subscriptionLive: false });
    expect((await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" })).statusCode).toBe(200);
    expect(gateway.checkouts).toHaveLength(2);
  });

  it("CP1 MAJOR · once the subscription is adopted the session is settled: a later cancel then re-checkout expires nothing", async () => {
    const { workspaceId, owner: first } = await newWorkspace();
    expect((await post(first, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" })).statusCode).toBe(200);
    stripeSubscription(workspaceId, { id: "sub_p", plan: "growth" });
    await deliver(eventBody("evt_p1", "customer.subscription.created", "sub_p"));
    stripeSubscription(workspaceId, { id: "sub_p", plan: "growth", status: "canceled" });
    await deliver(eventBody("evt_p2", "customer.subscription.deleted", "sub_p"));
    const owner = await reenter(first, workspaceId);
    expect((await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" })).statusCode).toBe(200);
    expect(gateway.expired, "the adopted session is not re-expired").toEqual([]);
  });

  it("CP1 MAJOR · the 409 for an already-subscribed workspace does not send plan changes to the portal", async () => {
    const { workspaceId, owner: first } = await newWorkspace();
    await deliver(eventBody("evt_pm", "customer.subscription.created", stripeSubscription(workspaceId)));
    const owner = await reenter(first, workspaceId);
    const res = await post(owner, "/billing/checkout-session", { plan_key: "business", billing_interval: "monthly" });
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toMatch(/change it in the billing portal/u);
  });

  // ---- checkpoint-1 · the plan is verified against what Stripe charges ----------------------------

  it("CP1 MAJOR · metadata that names a dearer plan than the price charged is refused and alarmed, and earns nothing", async () => {
    const { workspaceId } = await newWorkspace();
    await walletFor(workspaceId);
    const before = await row(workspaceId);
    const alarm = vi.spyOn(Logger.prototype, "error");
    // plan_key says business; the item charges the starter amount.
    stripeSubscription(workspaceId, { id: "sub_x", plan: "business", amount: 4_900 });
    const res = await deliver(eventBody("evt_x1", "customer.subscription.created", "sub_x"));
    expect(res.statusCode, "refusing is a 2xx: a retry cannot fix a price").toBe(200);
    expect(await row(workspaceId)).toEqual(before);
    expect(await ledgerCount(workspaceId)).toBe(0);
    expect(alarm, "a plan/price mismatch is alarmed").toHaveBeenCalled();
  });

  it.each([
    ["the amount of another plan", { plan: "growth", amount: 34_900 }],
    ["the right amount in the wrong currency", { plan: "growth", currency: "eur" }],
    ["a monthly amount on a yearly price", { plan: "growth", interval: "year" as const, amount: 12_900 }],
  ])("CP1 MAJOR · %s is not the plan it claims", async (_label, over) => {
    const { workspaceId } = await newWorkspace();
    const before = await row(workspaceId);
    stripeSubscription(workspaceId, { id: "sub_m", ...over });
    expect((await deliver(eventBody("evt_m1", "customer.subscription.created", "sub_m"))).statusCode).toBe(200);
    expect(await row(workspaceId)).toEqual(before);
  });

  it("CP1 MAJOR · a portal price switch (metadata unchanged, price changed) neither upgrades nor downgrades: the tracked plan holds and the mismatch is alarmed", async () => {
    const { workspaceId } = await newWorkspace();
    await deliver(eventBody("evt_q1", "customer.subscription.created", stripeSubscription(workspaceId, { id: "sub_q", plan: "growth" })));
    const tracked = await row(workspaceId);
    expect(tracked).toMatchObject({ plan_key: "growth" });
    const alarm = vi.spyOn(Logger.prototype, "error");
    // The portal switched the item to the business price; the metadata still says growth.
    stripeSubscription(workspaceId, { id: "sub_q", plan: "growth", amount: 34_900 });
    expect((await deliver(eventBody("evt_q2", "customer.subscription.updated", "sub_q"))).statusCode).toBe(200);
    expect(await row(workspaceId)).toEqual(tracked);
    expect(alarm).toHaveBeenCalled();
  });

  it("CP1 MAJOR · a correct annual price is accepted as the annual plan", async () => {
    const { workspaceId } = await newWorkspace();
    await deliver(eventBody("evt_y1", "customer.subscription.created", stripeSubscription(workspaceId, { id: "sub_y", plan: "growth", interval: "year" })));
    expect(await row(workspaceId)).toMatchObject({ plan_key: "growth", billing_interval: "annual" });
  });

  // ---- NEW-D-2 audit · a checkout whose request dies is not a second payable session --------------

  const dyingRequest = <T>(fn: () => Promise<T>): Promise<T> => whileRequestConnectionIsKilledAfterStripeCreatesASession(harness.app(), harness.db(), gateway, fn);
  const payable = (): number => gateway.checkouts.length - new Set(gateway.expired).size;

  it("AUDIT MAJOR (PROBE-B) · the retry after a request that died once Stripe had created the session expires it: one payable session, not two", async () => {
    const { owner } = await newWorkspace();
    const first = await dyingRequest(() => post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" }));
    expect(first.statusCode, "the first request failed").toBeGreaterThanOrEqual(500);
    expect(gateway.checkouts).toHaveLength(1);
    const second = await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" });
    expect(second.statusCode, second.body).toBe(200);
    expect(gateway.expired, "the session the dead request created is the one that was expired").toContain("cs_test_1");
    expect(payable(), "sessions created minus sessions expired = sessions still payable").toBe(1);
  });

  it("AUDIT MAJOR · a retry after a request that died BEFORE Stripe was reached leaves one payable session as well", async () => {
    const { owner } = await newWorkspace();
    gateway.failFetchWith = new StripeUpstreamError(500);
    expect((await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" })).statusCode).toBe(503);
    gateway.failFetchWith = undefined;
    expect((await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" })).statusCode).toBe(200);
    expect(payable()).toBe(1);
  });

  it("AUDIT MAJOR · a retry that asks for a DIFFERENT plan still finds and expires the session the dead request created", async () => {
    const { owner } = await newWorkspace();
    await dyingRequest(() => post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" }));
    const second = await post(owner, "/billing/checkout-session", { plan_key: "business", billing_interval: "annual" });
    expect(second.statusCode, second.body).toBe(200);
    expect(payable()).toBe(1);
  });

  it("AUDIT MAJOR · even when the write that recorded the session is lost too, the retry replays the intent, finds that session and expires it", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const first = await dyingRequest(() => post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" }));
    expect(first.statusCode).toBeGreaterThanOrEqual(500);
    // The session-id write was lost as well: only the intent (committed before Stripe) survives.
    await harness.db().query("UPDATE subscriptions SET open_checkout_session_id = NULL WHERE workspace_id = $1", [workspaceId]);
    const second = await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" });
    expect(second.statusCode, second.body).toBe(200);
    expect(gateway.checkouts, "the replay created nothing: it returned the first session").toHaveLength(2);
    expect(gateway.expired).toEqual(["cs_test_1"]);
    expect(payable()).toBe(1);
  });

  it("AUDIT MAJOR · every checkout names its intent and carries a Stripe idempotency key", async () => {
    const { owner } = await newWorkspace();
    await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" });
    const input = gateway.checkouts[0]!;
    expect(input.intentId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(input.idempotencyKey).toBeTruthy();
  });

  // ---- NEW-D-2 audit · the price ADOPTED at checkout is the one verified, not today's catalog -----

  /** Reprices `growth` for the duration of `fn`, whatever happens inside it: `plans` is shared by every test. */
  async function whileGrowthCosts139<T>(fn: () => Promise<T>): Promise<T> {
    await harness.db().query("UPDATE plans SET monthly_price = 139 WHERE key = 'growth'");
    try {
      return await fn();
    } finally {
      await harness.db().query("UPDATE plans SET monthly_price = 129 WHERE key = 'growth'");
    }
  }

  it("AUDIT MAJOR (PROBE-C) · after a catalog price change an existing subscription still takes its updates at the price it signed up at", async () => {
    const { workspaceId } = await newWorkspace();
    await deliver(eventBody("evt_c1", "customer.subscription.created", stripeSubscription(workspaceId, { id: "sub_c", plan: "growth" })));
    expect(await row(workspaceId)).toMatchObject({ plan_key: "growth", status: "active" });
    await whileGrowthCosts139(async () => {
      const alarm = vi.spyOn(Logger.prototype, "error");
      stripeSubscription(workspaceId, { id: "sub_c", plan: "growth", status: "past_due", cancelAtPeriodEnd: true });
      expect((await deliver(eventBody("evt_c2", "customer.subscription.updated", "sub_c"))).statusCode).toBe(200);
      expect(await row(workspaceId)).toMatchObject({ plan_key: "growth", status: "past_due", cancel_at_period_end: true });
      expect(alarm, "a customer who did nothing wrong is not alarmed").not.toHaveBeenCalled();
    });
  });

  it("AUDIT MAJOR · and the catalog's NEW price is still not accepted for that subscription: a portal switch to it is refused and alarmed", async () => {
    const { workspaceId } = await newWorkspace();
    await deliver(eventBody("evt_d1", "customer.subscription.created", stripeSubscription(workspaceId, { id: "sub_d", plan: "growth" })));
    const tracked = await row(workspaceId);
    await whileGrowthCosts139(async () => {
      const alarm = vi.spyOn(Logger.prototype, "error");
      stripeSubscription(workspaceId, { id: "sub_d", plan: "growth", amount: 13_900, cancelAtPeriodEnd: true });
      expect((await deliver(eventBody("evt_d2", "customer.subscription.updated", "sub_d"))).statusCode).toBe(200);
      expect(await row(workspaceId)).toEqual(tracked);
      expect(alarm).toHaveBeenCalled();
    });
  });

  it("AUDIT MAJOR · a frozen charge belongs to the plan it was frozen for: the same subscription re-labelled a dearer plan at the same price is refused", async () => {
    const { workspaceId } = await newWorkspace();
    await deliver(eventBody("evt_r1", "customer.subscription.created", stripeSubscription(workspaceId, { id: "sub_r", plan: "growth" })));
    const tracked = await row(workspaceId);
    // Metadata now says business; the item still charges growth's $129.
    stripeSubscription(workspaceId, { id: "sub_r", plan: "business", amount: 12_900 });
    expect((await deliver(eventBody("evt_r2", "customer.subscription.updated", "sub_r"))).statusCode).toBe(200);
    expect(await row(workspaceId)).toEqual(tracked);
  });

  it("AUDIT MAJOR · a checkout paid after the catalog moved is adopted at the price it was opened at", async () => {
    const { workspaceId, owner } = await newWorkspace();
    expect((await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" })).statusCode).toBe(200);
    const intentId = gateway.checkouts[0]!.intentId;
    expect(gateway.checkouts[0]!.unitAmountCents).toBe(12_900);
    await whileGrowthCosts139(async () => {
      stripeSubscription(workspaceId, { id: "sub_i", plan: "growth", ...(intentId === undefined ? {} : { intentId }) });
      expect((await deliver(eventBody("evt_i1", "customer.subscription.created", "sub_i"))).statusCode).toBe(200);
      expect(await row(workspaceId)).toMatchObject({ plan_key: "growth", provider: "stripe" });
    });
  });

  it("AUDIT MAJOR · an intent id that is not the workspace's own pending checkout buys no price: the catalog decides, and a cheaper charge is refused", async () => {
    const { workspaceId } = await newWorkspace();
    const before = await row(workspaceId);
    stripeSubscription(workspaceId, { id: "sub_f", plan: "business", amount: 4_900, intentId: randomUUID() });
    expect((await deliver(eventBody("evt_f1", "customer.subscription.created", "sub_f"))).statusCode).toBe(200);
    expect(await row(workspaceId)).toEqual(before);
  });
  it("AUDIT MAJOR · the frozen price of a pending checkout is honoured only for the subscription that checkout named: another subscription charged that same price is refused once the catalog has moved", async () => {
    const { workspaceId, owner } = await newWorkspace();
    expect((await post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" })).statusCode).toBe(200);
    expect(gateway.checkouts[0]!.unitAmountCents).toBe(12_900);
    const before = await row(workspaceId);
    await whileGrowthCosts139(async () => {
      const alarm = vi.spyOn(Logger.prototype, "error");
      // Charged exactly the pending intent's frozen $129, but naming an intent that is NOT the workspace's own.
      stripeSubscription(workspaceId, { id: "sub_x", plan: "growth", amount: 12_900, intentId: randomUUID() });
      expect((await deliver(eventBody("evt_x1", "customer.subscription.created", "sub_x"))).statusCode).toBe(200);
      expect(await row(workspaceId), "the catalog (now $139) decides for a stranger, so $129 buys nothing").toEqual(before);
      expect(alarm).toHaveBeenCalled();
    });
  });
});
