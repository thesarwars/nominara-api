import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addonChangeResponseSchema, addonListResponseSchema } from "../../contracts/billing/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { STRIPE_GATEWAY, StripeUpstreamError } from "../../src/lib/billing/stripe/stripe-gateway.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { resolveEntitlements } from "../../src/lib/entitlements/resolution.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { useApiHarness } from "../support/api-harness.js";
import { apiUrl } from "../support/api-url.js";
import { dataOf } from "../support/envelope.js";
import { FakeStripeGateway, signFakeStripePayload } from "../support/fake-stripe-gateway.js";

// STORY-076b — add-ons as Stripe subscription items. The REAL ApiModule, real
// Postgres, RLS in force (nominara_app). Stripe is the fake gateway: NO TEST
// CALLS THE REAL STRIPE API.
//
// The invariant under test: the POST/DELETE handlers change STRIPE and write
// NOTHING local; `subscription_addons`, `seats_purchased` and
// `projects_purchased` change only when the signed webhook reconciles the
// freshly fetched subscription.

const gateway = new FakeStripeGateway();
const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };
const T0 = Math.floor(Date.now() / 1000);
const PERIOD_END = T0 + 30 * 86_400;

type Kind = "extra_project" | "extra_seat";
interface Held {
  kind: Kind;
  quantity: number;
}

describe("STORY-076b · add-ons", () => {
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
  }
  async function enter(userId: string, workspaceId: string): Promise<Actor> {
    const tokens = await sessions.createSession(userId);
    return workspaces.switchTo(userId, tokens.sid, workspaceId, meta);
  }
  async function memberIn(workspaceId: string, role: "owner" | "admin" | "manager" | "viewer"): Promise<Actor> {
    const userId = await createUser();
    await harness.db().query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1,$2,$3,'active')", [workspaceId, userId, role]);
    return enter(userId, workspaceId);
  }
  /** A workspace on `plan` (its Stripe subscription adopted through the real webhook), plus its owner. */
  async function newWorkspace(plan: "free" | "starter" | "growth" = "growth", interval: "monthly" | "annual" = "monthly") {
    const ownerId = await createUser();
    const ws = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    if (plan !== "free") {
      stripeSubscription(ws.id, { plan, interval });
      expect((await deliver(eventBody(`evt_${randomUUID()}`, "customer.subscription.created", subIdOf(ws.id)))).statusCode).toBe(200);
    }
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
  const del = (a: Actor, path: string) =>
    harness.app().inject({ method: "DELETE", url: apiUrl(path), cookies: cookies(a), headers: { [CSRF_HEADER_NAME]: a.csrfToken } });

  const eventBody = (id: string, type: string, objectId: string): string =>
    JSON.stringify({ id, object: "event", type, data: { object: { id: objectId } } });
  const deliver = (body: string) =>
    harness.app().inject({ method: "POST", url: apiUrl("/webhooks/stripe"), headers: { "content-type": "application/json", "stripe-signature": signFakeStripePayload(body) }, payload: body });
  const reconcile = (workspaceId: string, eventId = `evt_${randomUUID()}`) =>
    deliver(eventBody(eventId, "customer.subscription.updated", subIdOf(workspaceId)));

  const subIdOf = (workspaceId: string): string => `sub_${workspaceId}`;
  const PRICES: Record<string, Record<string, number>> = { starter: { monthly: 4_900, annual: 49_000 }, growth: { monthly: 12_900, annual: 129_000 } };

  /** Stripe's CURRENT state of a workspace's subscription, as the gateway will fetch it. */
  function stripeSubscription(workspaceId: string, over: { plan?: "starter" | "growth"; interval?: "monthly" | "annual"; status?: string; held?: Held[] } = {}): void {
    const plan = over.plan ?? "growth";
    const interval = over.interval ?? "monthly";
    const line = (kind: string, id: string, quantity: number, cents: number) => ({
      id,
      quantity,
      current_period_start: T0,
      current_period_end: PERIOD_END,
      price: { id: `price_${id}`, unit_amount: cents, currency: "usd", recurring: { interval: interval === "annual" ? "year" : "month" }, product: { metadata: { nominara_kind: kind } } },
    });
    gateway.putObject(
      "subscription",
      subIdOf(workspaceId),
      { workspace_id: workspaceId, plan_key: plan, billing_interval: interval },
      {
        customer: "cus_1",
        status: over.status ?? "active",
        cancel_at_period_end: false,
        trial_end: null,
        items: {
          data: [
            line("plan", "si_plan", 1, PRICES[plan]![interval]!),
            ...(over.held ?? []).map((h) => line(h.kind, `si_${h.kind}`, h.quantity, h.kind === "extra_project" ? 4_900 : 1_500)),
          ],
        },
      },
    );
  }

  const localSub = async (workspaceId: string) =>
    (await harness.db().query("SELECT seats_purchased, projects_purchased, stripe_subscription_id FROM subscriptions WHERE workspace_id = $1", [workspaceId])).rows[0] as {
      seats_purchased: number;
      projects_purchased: number;
      stripe_subscription_id: string;
    };
  const addonRows = async (workspaceId: string) =>
    (await harness.db().query("SELECT kind, quantity, unit_price_usd::text AS unit_price_usd, stripe_subscription_item_id, active_until FROM subscription_addons WHERE workspace_id = $1 ORDER BY kind, created_at", [workspaceId])).rows as Array<{
      kind: string;
      quantity: number;
      unit_price_usd: string;
      stripe_subscription_item_id: string;
      active_until: Date | null;
    }>;
  const versionOf = async (workspaceId: string): Promise<number> =>
    (await harness.db().query<{ entitlement_version: number }>("SELECT entitlement_version FROM workspaces WHERE id = $1", [workspaceId])).rows[0]!.entitlement_version;
  const auditActions = async (workspaceId: string, action: string) =>
    (await harness.db().query("SELECT actor_type, action, request_id, before_state, after_state FROM audit_log WHERE workspace_id = $1 AND action = $2 ORDER BY seq", [workspaceId, action])).rows;
  async function resolved(workspaceId: string) {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => resolveEntitlements(tx, workspaceId));
    } finally {
      client.release();
    }
  }

  // ---- AC1 (STORY-076 AC10 / scenario 10): Stripe changes; the POST handler writes nothing local --------

  it("AC1 · POST adds a NEW subscription item in Stripe with proration and writes NOTHING local", async () => {
    const { workspaceId, owner } = await newWorkspace("growth");
    const before = { sub: await localSub(workspaceId), version: await versionOf(workspaceId) };

    const res = await post(owner, "/billing/addons", { kind: "extra_project", quantity: 2 });
    expect(res.statusCode, res.body).toBe(202);
    const body = addonChangeResponseSchema.parse(dataOf(res));
    expect(body).toMatchObject({ kind: "extra_project", status: "pending", quantity_requested: 2, effective: "immediate" });

    expect(gateway.addonChanges).toHaveLength(1);
    expect(gateway.addonChanges[0]).toMatchObject({
      subscriptionId: subIdOf(workspaceId),
      kind: "extra_project",
      quantity: 2,
      existingItemId: null,
      unitAmountCents: 4_900,
      currency: "usd",
      interval: "month",
      proration: "create_prorations",
    });
    // The handler wrote nothing: not the rows, not the counters, not the version.
    expect(await addonRows(workspaceId)).toEqual([]);
    expect(await localSub(workspaceId)).toEqual(before.sub);
    expect(await versionOf(workspaceId)).toBe(before.version);
  });

  it("AC1 · the price and currency come from OUR catalog (extra_seat $15), never from the request", async () => {
    const { owner } = await newWorkspace("growth");
    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 })).statusCode).toBe(202);
    expect(gateway.addonChanges[0]).toMatchObject({ kind: "extra_seat", unitAmountCents: 1_500, currency: "usd" });
    const forged = await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1, unit_price_usd: "0.01" });
    expect(forged.statusCode).toBe(400);
    expect(gateway.addonChanges).toHaveLength(1);
  });

  it("AC1 · POST ADDS to the held quantity: Stripe holds 3 seats (webhook not landed), +2 sets the SAME item to 5, from a FRESH fetch and not the local row", async () => {
    const { workspaceId, owner } = await newWorkspace("growth");
    // Stripe already holds 3 seats; the webhook that would tell us has not landed (local rows: none).
    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 3 }] });
    expect(await addonRows(workspaceId)).toEqual([]);

    const res = await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 2 });
    expect(res.statusCode, res.body).toBe(202);
    expect(gateway.fetches).toContain(`subscription:${subIdOf(workspaceId)}`);
    expect(gateway.addonChanges[0]).toMatchObject({ kind: "extra_seat", quantity: 5, existingItemId: "si_extra_seat" });
    expect(dataOf<{ quantity_requested: number }>(res).quantity_requested).toBe(5);
  });

  it("AC1 boundary · held plus added above the cap is a 400 before Stripe; held plus added AT the cap is allowed", async () => {
    const { workspaceId, owner } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 99 }] });
    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 2 })).statusCode).toBe(400);
    expect(gateway.addonChanges).toHaveLength(0);
    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 })).statusCode).toBe(202);
    expect(gateway.addonChanges[0]).toMatchObject({ quantity: 100 });
  });

  const intentsOf = async (workspaceId: string) =>
    (await harness.db().query<{ pending_addon_changes: Record<string, { kind: string; quantity: number; target_total: number; stripe_idempotency_key: string }> | null }>(
      "SELECT pending_addon_changes FROM subscriptions WHERE workspace_id = $1",
      [workspaceId],
    )).rows[0]!.pending_addon_changes;

  it("AC1 retry · Stripe APPLIED the change and the reply was lost: the same Idempotency-Key retried adds NOTHING more (one unit, one Stripe change), and a new key adds again", async () => {
    const { workspaceId, owner } = await newWorkspace("growth");
    stripeSubscription(workspaceId, {});
    const key = randomUUID();
    gateway.failAfterApplyingAddon = new StripeUpstreamError(504);
    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 }, key)).statusCode).toBe(503);
    gateway.failAfterApplyingAddon = undefined;
    const item = () => (gateway.objects.get(`subscription:${subIdOf(workspaceId)}`)!.raw as { items: { data: Array<{ id: string; quantity: number }> } }).items.data.find((l) => l.id === "si_extra_seat");
    expect(item()?.quantity).toBe(1); // Stripe did apply it

    const retry = await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 }, key);
    expect(retry.statusCode, retry.body).toBe(202);
    expect(dataOf<{ quantity_requested: number }>(retry).quantity_requested).toBe(1);
    expect(item()?.quantity).toBe(1);
    expect(gateway.addonChanges).toHaveLength(1);
    expect(gateway.addonAttempts.filter((a) => a.quantity !== 1)).toEqual([]);

    // A DIFFERENT Idempotency-Key is a different purchase: it adds.
    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 }, randomUUID())).statusCode).toBe(202);
    expect(item()?.quantity).toBe(2);
  });

  it("AC1 retry · the intent is COMMITTED before Stripe is asked: it survives the failed request and carries the target total and the Stripe key", async () => {
    const { workspaceId, owner } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 2 }] });
    const key = randomUUID();
    gateway.failAddonWith = new StripeUpstreamError(504);
    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 }, key)).statusCode).toBe(503);
    const intents = Object.values((await intentsOf(workspaceId)) ?? {});
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ kind: "extra_seat", quantity: 1, target_total: 3 });
    expect(gateway.addonAttempts[0]!.idempotencyKey).toBe(intents[0]!.stripe_idempotency_key);
    expect(JSON.stringify(intents)).not.toContain(key); // the caller's key is stored hashed only
  });

  it("AC1 retry · a retry replays the STORED total and the STORED Stripe key even if Stripe has moved on (the key is not re-derived from fresh arithmetic)", async () => {
    const { workspaceId, owner } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 2 }] });
    const key = randomUUID();
    gateway.failAddonWith = new StripeUpstreamError(504);
    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 }, key)).statusCode).toBe(503); // not applied; target 3
    gateway.failAddonWith = undefined;
    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 }, key)).statusCode).toBe(202);
    expect(gateway.addonAttempts).toHaveLength(2);
    expect(gateway.addonAttempts[1]).toMatchObject({ quantity: 3, idempotencyKey: gateway.addonAttempts[0]!.idempotencyKey });
  });

  it("AC1 retry · the same Idempotency-Key with a DIFFERENT request is 409 idempotency_conflict and Stripe is not called", async () => {
    const { workspaceId, owner } = await newWorkspace("growth");
    stripeSubscription(workspaceId, {});
    const key = randomUUID();
    gateway.failAddonWith = new StripeUpstreamError(504);
    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 }, key)).statusCode).toBe(503);
    gateway.failAddonWith = undefined;
    const before = gateway.addonAttempts.length;
    for (const payload of [{ kind: "extra_seat", quantity: 2 }, { kind: "extra_project", quantity: 1 }]) {
      const res = await post(owner, "/billing/addons", payload, key);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json<{ code: string }>().code).toBe("idempotency_conflict");
    }
    expect(gateway.addonAttempts).toHaveLength(before);
  });

  it("AC1 retry · a create that FAILS without changing Stripe is retried under the SAME derived Stripe key; a different Idempotency-Key derives a different one", async () => {
    const { workspaceId, owner } = await newWorkspace("growth");
    stripeSubscription(workspaceId, {});
    const key = randomUUID();
    gateway.addonAttempts.length = 0;
    gateway.failAddonWith = new StripeUpstreamError(504);
    // Stripe state is NOT changed: the retry's fresh fetch still shows nothing held, so it sends a second create.
    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 }, key)).statusCode).toBe(503);
    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 }, key)).statusCode).toBe(503);
    expect(gateway.addonAttempts).toHaveLength(2);
    const [first, retry] = gateway.addonAttempts;
    expect(first!.idempotencyKey).toBeTruthy();
    expect(retry!.idempotencyKey).toBe(first!.idempotencyKey);

    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 }, randomUUID())).statusCode).toBe(503);
    expect(gateway.addonAttempts).toHaveLength(3);
    expect(gateway.addonAttempts[2]!.idempotencyKey).not.toBe(first!.idempotencyKey);
    expect(gateway.addonChanges).toHaveLength(0);
  });

  it("AC1 · request validation: quantity 0, 101, a fractional quantity and an unknown kind are 400s; the Idempotency-Key is required", async () => {
    const { owner } = await newWorkspace("growth");
    for (const payload of [{ kind: "extra_seat", quantity: 0 }, { kind: "extra_seat", quantity: 101 }, { kind: "extra_seat", quantity: 1.5 }, { kind: "extra_gpu", quantity: 1 }, { kind: "extra_seat" }]) {
      expect((await post(owner, "/billing/addons", payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 }, null)).statusCode).toBe(400);
    expect(gateway.addonChanges).toHaveLength(0);
  });

  it("AC1 · Stripe unavailable is a 503 degraded with no local change; an unconfigured provider is a 503 before any call", async () => {
    const { workspaceId, owner } = await newWorkspace("growth");
    gateway.failAddonWith = new StripeUpstreamError(500);
    const failed = await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 });
    expect(failed.statusCode).toBe(503);
    expect(JSON.stringify(failed.json())).not.toContain("500");
    expect(await addonRows(workspaceId)).toEqual([]);
    gateway.failAddonWith = undefined;
    gateway.configured = false;
    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 })).statusCode).toBe(503);
    expect(gateway.addonChanges).toHaveLength(0);
  });

  it("AC1 · an annual subscription is refused (409): add-ons are priced monthly only until the owner decides an annual price", async () => {
    const { owner } = await newWorkspace("growth", "annual");
    const res = await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 });
    expect(res.statusCode).toBe(409);
    expect(gateway.addonChanges).toHaveLength(0);
  });

  // ---- AC1 / AC5: the reconciler is the only writer ------------------------------------------------

  it("AC1 + AC5 · the fresh-fetch reconciler writes the add-on row, seats_purchased and projects_purchased, and bumps entitlement_version", async () => {
    const { workspaceId } = await newWorkspace("growth");
    const v0 = await versionOf(workspaceId);
    stripeSubscription(workspaceId, { held: [{ kind: "extra_project", quantity: 2 }, { kind: "extra_seat", quantity: 3 }] });
    expect((await reconcile(workspaceId)).statusCode).toBe(200);

    expect(await addonRows(workspaceId)).toEqual([
      { kind: "extra_project", quantity: 2, unit_price_usd: "49.00", stripe_subscription_item_id: "si_extra_project", active_until: null },
      { kind: "extra_seat", quantity: 3, unit_price_usd: "15.00", stripe_subscription_item_id: "si_extra_seat", active_until: null },
    ]);
    expect(await localSub(workspaceId)).toMatchObject({ seats_purchased: 4, projects_purchased: 2 });
    expect(await versionOf(workspaceId)).toBeGreaterThan(v0);
  });

  it("AC5 · a change that moves ONLY the add-on rows (not the counters) still bumps entitlement_version", async () => {
    const { workspaceId } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 2 }] });
    await reconcile(workspaceId);
    const v1 = await versionOf(workspaceId);
    // Same quantity, a different item id: counters unchanged, the mirrored row is not.
    const raw = gateway.objects.get(`subscription:${subIdOf(workspaceId)}`)!.raw as { items: { data: Array<{ id: string }> } };
    raw.items.data[1]!.id = "si_replaced";
    await reconcile(workspaceId);
    expect((await addonRows(workspaceId))[0]!.stripe_subscription_item_id).toBe("si_replaced");
    expect(await versionOf(workspaceId)).toBe(v1 + 1);
  });

  it("AC1 · a redelivered or unchanged event writes nothing and does not bump the version again", async () => {
    const { workspaceId } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 2 }] });
    await reconcile(workspaceId, "evt_same");
    const v = await versionOf(workspaceId);
    const audits = (await auditActions(workspaceId, "billing.addons_reconciled")).length;
    await reconcile(workspaceId, "evt_same");
    await reconcile(workspaceId, "evt_other");
    expect(await versionOf(workspaceId)).toBe(v);
    expect(await auditActions(workspaceId, "billing.addons_reconciled")).toHaveLength(audits);
    expect(await addonRows(workspaceId)).toHaveLength(1);
  });

  it("AC1 · an add-on that left Stripe's subscription is closed (active_until), the counters fall back, and the version bumps", async () => {
    const { workspaceId } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_project", quantity: 1 }] });
    await reconcile(workspaceId);
    const v = await versionOf(workspaceId);
    stripeSubscription(workspaceId, { held: [] });
    await reconcile(workspaceId);
    const rows = await addonRows(workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.active_until).not.toBeNull();
    expect(await localSub(workspaceId)).toMatchObject({ projects_purchased: 0, seats_purchased: 1 });
    expect(await versionOf(workspaceId)).toBeGreaterThan(v);
    // …and buying it again afterwards opens a NEW active row (ux_addons_active is partial on active_until IS NULL).
    stripeSubscription(workspaceId, { held: [{ kind: "extra_project", quantity: 2 }] });
    await reconcile(workspaceId);
    expect((await addonRows(workspaceId)).filter((r) => r.active_until === null).map((r) => r.quantity)).toEqual([2]);
  });

  it("AC1 · an ended subscription closes every add-on", async () => {
    const { workspaceId } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 2 }] });
    await reconcile(workspaceId);
    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 2 }], status: "canceled" });
    await reconcile(workspaceId);
    expect((await addonRows(workspaceId)).every((r) => r.active_until !== null)).toBe(true);
    expect((await resolved(workspaceId)).entitlements["seats.max"]!.source).not.toBe("add_on");
  });

  it("audit · concurrent POSTs with DISTINCT Idempotency-Keys create exactly ONE Stripe item and every add lands once: the final quantity is the SUM (the workspace row lock)", async () => {
    const { workspaceId, owner } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [] });
    const key = `subscription:${subIdOf(workspaceId)}`;
    // Stripe applies a change after a delay, so an unserialised second request has already read held=0.
    vi.spyOn(gateway, "changeAddonQuantity").mockImplementation(async (input) => {
      gateway.addonChanges.push(input);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const raw = gateway.objects.get(key)!.raw as { items: { data: Array<Record<string, unknown>> } };
      const existing = raw.items.data.find((line) => line.id === input.existingItemId);
      if (existing !== undefined) existing.quantity = input.quantity;
      else
        raw.items.data.push({
          id: `si_${input.kind}_${randomUUID()}`,
          quantity: input.quantity,
          current_period_start: T0,
          current_period_end: PERIOD_END,
          price: { id: "price_seat", unit_amount: input.unitAmountCents, currency: "usd", recurring: { interval: "month" }, product: { metadata: { nominara_kind: input.kind } } },
        });
    });
    const adds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const responses = await Promise.all(adds.map((quantity) => post(owner, "/billing/addons", { kind: "extra_seat", quantity })));

    expect(responses.map((r) => r.statusCode), responses.map((r) => r.body).join("\n")).toEqual(adds.map(() => 202));
    // The hazard: two unserialised requests both create an item, and the customer pays for both.
    expect(gateway.addonChanges.filter((change) => change.existingItemId === null)).toHaveLength(1);
    const lines = (gateway.objects.get(key)!.raw as { items: { data: Array<{ quantity: number; price: { product: { metadata: { nominara_kind: string } } } }> } }).items.data.filter(
      (line) => line.price.product.metadata.nominara_kind === "extra_seat",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(78);
  });

  it("audit · a late event for an OLD, ended subscription leaves the CURRENT subscription's add-ons active (the reconcile filter binds the event's subscription)", async () => {
    const { workspaceId } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 2 }, { kind: "extra_project", quantity: 1 }] });
    expect((await reconcile(workspaceId)).statusCode).toBe(200);
    const before = { rows: await addonRows(workspaceId), version: await versionOf(workspaceId), sub: await localSub(workspaceId) };
    expect(before.rows.filter((r) => r.active_until === null)).toHaveLength(2);

    // An earlier subscription of the same workspace, ended in Stripe: it fetches as `canceled` with no items.
    const oldId = `sub_old_${workspaceId}`;
    gateway.putObject("subscription", oldId, { workspace_id: workspaceId, plan_key: "growth", billing_interval: "monthly" }, {
      customer: "cus_1",
      status: "canceled",
      cancel_at_period_end: false,
      trial_end: null,
      current_period_start: T0,
      current_period_end: PERIOD_END,
      items: { data: [] },
    });
    const res = await deliver(eventBody(`evt_${randomUUID()}`, "customer.subscription.deleted", oldId));
    expect(res.statusCode, res.body).toBe(200);

    const after = await addonRows(workspaceId);
    expect(after.filter((r) => r.active_until === null).map((r) => [r.kind, r.quantity]).sort()).toEqual([["extra_project", 1], ["extra_seat", 2]]);
    expect(await localSub(workspaceId)).toEqual(before.sub);
    expect(await versionOf(workspaceId)).toBe(before.version);
  });

  // ---- AC2 (STORY-076 AC11 / scenarios 10 and 11) --------------------------------------------------

  it("AC2 · scenario 10 · after an extra_project lands, projects.max is +1 AND the prompt slots are granted", async () => {
    const { workspaceId } = await newWorkspace("growth");
    const base = await resolved(workspaceId);
    stripeSubscription(workspaceId, { held: [{ kind: "extra_project", quantity: 1 }] });
    await reconcile(workspaceId);
    const after = await resolved(workspaceId);
    expect(after.entitlements["projects.max"]!.value).toBe((base.entitlements["projects.max"]!.value as number) + 1);
    expect(after.entitlements["projects.max"]!.source).toBe("add_on");
    expect(after.entitlements["prompts.max_total"]!.value).toBe(
      (base.entitlements["prompts.max_total"]!.value as number) + (base.entitlements["prompts.max_per_project"]!.value as number),
    );
    expect(after.entitlements["prompts.max_total"]!.source).toBe("add_on");
    expect(after.entitlement_version).toBeGreaterThan(base.entitlement_version);
  });

  it("AC2 · scenario 11 · GET /billing/addons returns the grant statement, the price and the cursor envelope", async () => {
    const { workspaceId, ownerId } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_project", quantity: 2 }, { kind: "extra_seat", quantity: 1 }] });
    await reconcile(workspaceId);
    const owner = await enter(ownerId, workspaceId); // the version bump invalidated the earlier token

    const res = await get(owner, "/billing/addons");
    expect(res.statusCode, res.body).toBe(200);
    const list = addonListResponseSchema.parse(dataOf(res));
    const project = list.find((a) => a.kind === "extra_project")!;
    expect(project).toMatchObject({ quantity: 2, unit_price_usd: "49.00", active_until: null });
    expect(project.grant.projects).toBe(1);
    expect(project.grant.prompt_slots).toBe(40); // growth: prompts.max_per_project
    expect(project.grant.statement).toContain("1 project");
    expect(project.grant.statement).toContain("40 prompt slots");
    expect(list.find((a) => a.kind === "extra_seat")!.grant).toMatchObject({ seats: 1, projects: 0, prompt_slots: 0 });
    expect(res.json<{ pagination: { has_more: boolean } }>().pagination.has_more).toBe(false);
  });

  it("AC2 · catalog · a workspace holding nothing still sees BOTH add-ons with their prices, grants and quantity 0 (owner decision 2026-10-08)", async () => {
    const { owner } = await newWorkspace("growth");
    const res = await get(owner, "/billing/addons");
    expect(res.statusCode, res.body).toBe(200);
    const list = addonListResponseSchema.parse(dataOf(res));
    expect(list.map((a) => a.kind)).toEqual(["extra_project", "extra_seat"]);
    expect(list[0]).toMatchObject({ unit_price_usd: "49.00", display_name: "Extra project", purchasable: true, quantity: 0, id: null, active_from: null, active_until: null });
    expect(list[0]!.grant).toMatchObject({ projects: 1, prompt_slots: 40 });
    expect(list[1]).toMatchObject({ unit_price_usd: "15.00", display_name: "Extra seat", purchasable: true, quantity: 0, id: null });
  });

  it("AC2 · catalog · purchasable follows the plan: free buys neither, starter buys a seat but not a project", async () => {
    const free = await newWorkspace("free");
    expect(addonListResponseSchema.parse(dataOf(await get(free.owner, "/billing/addons"))).map((a) => [a.kind, a.purchasable])).toEqual([["extra_project", false], ["extra_seat", false]]);
    const starter = await newWorkspace("starter");
    expect(addonListResponseSchema.parse(dataOf(await get(starter.owner, "/billing/addons"))).map((a) => [a.kind, a.purchasable])).toEqual([["extra_project", false], ["extra_seat", true]]);
  });

  it("AC2 · catalog · a held add-on shows its quantity and id beside the catalog entry of the one not held", async () => {
    const { workspaceId, ownerId } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 4 }] });
    await reconcile(workspaceId);
    const owner = await enter(ownerId, workspaceId);
    const list = addonListResponseSchema.parse(dataOf(await get(owner, "/billing/addons")));
    expect(list.map((a) => [a.kind, a.quantity])).toEqual([["extra_project", 0], ["extra_seat", 4]]);
    expect(list[1]!.id).not.toBeNull();
    expect(list[0]!.id).toBeNull();
  });

  it("AC2 · the list excludes closed add-ons and cursor-pages the rest", async () => {
    const { workspaceId, ownerId } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_project", quantity: 1 }, { kind: "extra_seat", quantity: 1 }] });
    await reconcile(workspaceId);
    const owner = await enter(ownerId, workspaceId);
    const first = await get(owner, "/billing/addons?limit=1");
    expect(dataOf<Array<{ kind: string }>>(first)).toHaveLength(1);
    const cursor = first.json<{ pagination: { cursor_next: string | null } }>().pagination.cursor_next;
    expect(cursor).not.toBeNull();
    const second = await get(owner, `/billing/addons?limit=1&cursor=${encodeURIComponent(cursor!)}`);
    expect(dataOf<Array<{ kind: string }>>(second)).toHaveLength(1);
    expect(dataOf<Array<{ kind: string }>>(second)[0]!.kind).not.toBe(dataOf<Array<{ kind: string }>>(first)[0]!.kind);
    expect((await get(owner, "/billing/addons?limit=1&cursor=forged")).statusCode).toBe(400);
  });

  // ---- AC3 (STORY-076 AC12 / scenario 12): a seat is not removed from under its members -------------

  it("AC3 · scenario 12 · removing seats while active members exceed the reduced limit is a 409 BEFORE any Stripe call", async () => {
    const { workspaceId, ownerId } = await newWorkspace("growth"); // growth seats.max = 7
    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 2 }] }); // 9 seats
    await reconcile(workspaceId);
    for (let i = 0; i < 7; i += 1) await memberIn(workspaceId, "viewer"); // + the owner = 8 active members
    const owner = await enter(ownerId, workspaceId);

    const fetchesBefore = gateway.fetches.length;
    const res = await del(owner, "/billing/addons/extra_seat");
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.stringify(res.json())).toContain("8 members are active but the reduced seat limit would be 7");
    expect(gateway.addonRemovals).toHaveLength(0);
    expect(gateway.addonChanges).toHaveLength(0);
    expect(gateway.fetches).toHaveLength(fetchesBefore); // no Stripe traffic of any kind
    expect((await addonRows(workspaceId))[0]!.active_until).toBeNull();
  });

  it("AC3 boundary · members exactly AT the reduced limit may remove; one over may not; a removed member frees the seat", async () => {
    const { workspaceId, ownerId } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 1 }] }); // 8 seats
    await reconcile(workspaceId);
    for (let i = 0; i < 6; i += 1) await memberIn(workspaceId, "viewer"); // 7 members = the reduced limit
    let owner = await enter(ownerId, workspaceId);
    expect((await del(owner, "/billing/addons/extra_seat")).statusCode).toBe(202);

    await memberIn(workspaceId, "viewer"); // 8 members
    owner = await enter(ownerId, workspaceId);
    expect((await del(owner, "/billing/addons/extra_seat")).statusCode).toBe(409);
    await harness.db().query(
      "UPDATE workspace_members SET status = 'removed' WHERE workspace_id = $1 AND role = 'viewer' AND user_id = (SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'viewer' LIMIT 1)",
      [workspaceId],
    );
    owner = await enter(ownerId, workspaceId);
    expect((await del(owner, "/billing/addons/extra_seat")).statusCode).toBe(202);
  });

  // ---- AC4 (STORY-076 AC13 / scenario 13): removal at the period end --------------------------------

  it("AC4 · scenario 13 · DELETE schedules the removal at the PERIOD END in Stripe and changes nothing local; the deferral is stated", async () => {
    const { workspaceId, ownerId } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_project", quantity: 1 }] });
    await reconcile(workspaceId);
    const owner = await enter(ownerId, workspaceId);
    const v = await versionOf(workspaceId);

    const res = await del(owner, "/billing/addons/extra_project");
    expect(res.statusCode, res.body).toBe(202);
    const body = addonChangeResponseSchema.parse(dataOf(res));
    expect(body).toMatchObject({ kind: "extra_project", status: "pending", quantity_requested: 0, effective: "period_end" });
    expect(new Date(body.effective_at!).getTime()).toBe(PERIOD_END * 1000);

    expect(gateway.addonRemovals).toEqual([expect.objectContaining({ subscriptionId: subIdOf(workspaceId), itemId: "si_extra_project" })]);
    // Still in force and still billed until the period end: nothing local moved.
    expect((await addonRows(workspaceId))[0]!.active_until).toBeNull();
    expect(await versionOf(workspaceId)).toBe(v);
    expect((await resolved(workspaceId)).entitlements["projects.max"]!.source).toBe("add_on");
  });

  it("AC4 · once Stripe applies the removal (the item is gone) the reconciler closes the add-on and the entitlement falls back", async () => {
    const { workspaceId, ownerId } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_project", quantity: 1 }] });
    await reconcile(workspaceId);
    await del(await enter(ownerId, workspaceId), "/billing/addons/extra_project");
    stripeSubscription(workspaceId, { held: [] }); // the period ended: the schedule dropped the item
    await reconcile(workspaceId);
    expect((await addonRows(workspaceId))[0]!.active_until).not.toBeNull();
    expect((await resolved(workspaceId)).entitlements["projects.max"]!.source).toBe("plan");
  });

  it("AC4 · removing an add-on the workspace does not hold is a 404 and calls nothing", async () => {
    const { owner } = await newWorkspace("growth");
    expect((await del(owner, "/billing/addons/extra_seat")).statusCode).toBe(404);
    expect((await del(owner, "/billing/addons/extra_gpu")).statusCode).toBe(400);
    expect(gateway.addonRemovals).toHaveLength(0);
  });

  // ---- AC6: eligibility -----------------------------------------------------------------------------

  it("AC6 · free is refused with 403 feature_not_in_plan naming min_plan, for both kinds, before any Stripe call", async () => {
    const { owner } = await newWorkspace("free");
    const project = await post(owner, "/billing/addons", { kind: "extra_project", quantity: 1 });
    expect(project.statusCode).toBe(403);
    expect(project.json<{ error: unknown }>().error).toMatchObject({ code: "feature_not_in_plan", details: { key: "projects.addon_allowed", min_plan: "growth" } });
    const seat = await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 });
    expect(seat.statusCode).toBe(403);
    expect(seat.json<{ error: { details: { min_plan: string } } }>().error.details.min_plan).toBe("starter");
    expect(gateway.addonChanges).toHaveLength(0);
  });

  it("AC6 · starter may buy a seat (202) but not a project (403 min_plan growth)", async () => {
    const { owner } = await newWorkspace("starter");
    expect((await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 })).statusCode).toBe(202);
    const project = await post(owner, "/billing/addons", { kind: "extra_project", quantity: 1 });
    expect(project.statusCode).toBe(403);
    expect(project.json<{ error: { details: { min_plan: string } } }>().error.details.min_plan).toBe("growth");
  });

  // ---- permissions, audit ---------------------------------------------------------------------------

  it("permissions · GET is billing:read and POST/DELETE are billing:write: a manager and a viewer are refused with a 403 naming the permission", async () => {
    const { workspaceId } = await newWorkspace("growth");
    const admin = await memberIn(workspaceId, "admin");
    const manager = await memberIn(workspaceId, "manager");
    const viewer = await memberIn(workspaceId, "viewer");
    expect((await get(admin, "/billing/addons")).statusCode).toBe(200);
    expect((await post(admin, "/billing/addons", { kind: "extra_seat", quantity: 1 })).statusCode).toBe(202);
    for (const actor of [manager, viewer]) {
      const read = await get(actor, "/billing/addons");
      expect(read.statusCode).toBe(403);
      expect(read.body).toContain("billing:read");
      const write = await post(actor, "/billing/addons", { kind: "extra_seat", quantity: 1 });
      expect(write.statusCode).toBe(403);
      expect(write.body).toContain("billing:write");
      expect((await del(actor, "/billing/addons/extra_seat")).statusCode).toBe(403);
    }
    expect(gateway.addonChanges).toHaveLength(1);
  });

  it("AC7 · every change writes an audit row: the request, the removal, and the reconciliation", async () => {
    const { workspaceId, ownerId } = await newWorkspace("growth");
    const owner = await enter(ownerId, workspaceId);
    await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 2 });
    expect(await auditActions(workspaceId, "billing.addon.change_requested")).toHaveLength(1);

    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 2 }] });
    await reconcile(workspaceId, "evt_audit_1");
    const reconciled = await auditActions(workspaceId, "billing.addons_reconciled");
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({ actor_type: "system", request_id: "evt_audit_1" });
    expect(reconciled[0]!.before_state).toMatchObject({ addons: {} });
    expect(reconciled[0]!.after_state).toMatchObject({ addons: { extra_seat: 2 } });

    await del(await enter(ownerId, workspaceId), "/billing/addons/extra_seat");
    expect(await auditActions(workspaceId, "billing.addon.removal_scheduled")).toHaveLength(1);
  });

  it("AC7 · a refused change writes no change audit row", async () => {
    const { workspaceId, owner } = await newWorkspace("free");
    await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 });
    expect(await auditActions(workspaceId, "billing.addon.change_requested")).toHaveLength(0);
  });

  it("redaction · the audit rows and responses carry no Stripe ids beyond the item id, and no secrets", async () => {
    const { workspaceId, ownerId } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 1 }] });
    await reconcile(workspaceId);
    const rows = await auditActions(workspaceId, "billing.addons_reconciled");
    expect(JSON.stringify(rows)).not.toMatch(/sk_(test|live)|whsec_|cus_1/u);
    const res = await get(await enter(ownerId, workspaceId), "/billing/addons");
    expect(res.body).not.toMatch(/sk_(test|live)|whsec_|si_extra|sub_/u);
  });

  // ---- tenant isolation: RLS alone ------------------------------------------------------------------

  it("tenant isolation · the list returns only the caller's add-ons", async () => {
    const a = await newWorkspace("growth");
    const b = await newWorkspace("growth");
    stripeSubscription(a.workspaceId, { held: [{ kind: "extra_seat", quantity: 1 }] });
    stripeSubscription(b.workspaceId, { held: [{ kind: "extra_project", quantity: 4 }] });
    await reconcile(a.workspaceId);
    await reconcile(b.workspaceId);
    const owner = await enter(a.ownerId, a.workspaceId);
    expect(dataOf<Array<{ kind: string; quantity: number }>>(await get(owner, "/billing/addons")).map((r) => `${r.kind}:${String(r.quantity)}`)).toEqual(["extra_seat:1"]);
  });

  it("tenant isolation · as nominara_app, an unfiltered read in A's context sees none of B's add-ons and cannot write one for B", async () => {
    const a = await newWorkspace("growth");
    const b = await newWorkspace("growth");
    stripeSubscription(a.workspaceId, { held: [{ kind: "extra_seat", quantity: 1 }] });
    stripeSubscription(b.workspaceId, { held: [{ kind: "extra_seat", quantity: 1 }] });
    await reconcile(a.workspaceId);
    await reconcile(b.workspaceId);
    // B's real subscription id, read as the superuser: the forged INSERT must be refused by RLS WITH CHECK, not be a vacuous zero-row INSERT.
    const bSubscriptionId = (await harness.db().query<{ id: string }>("SELECT id FROM subscriptions WHERE workspace_id = $1", [b.workspaceId])).rows[0]!.id;
    const url = new URL(process.env.DATABASE_URL!);
    url.username = "nominara_app";
    url.password = resolvePassword("nominara_app", {});
    const app = new Pool({ connectionString: url.toString() });
    try {
      const client = await app.connect();
      try {
        await withTenantContext(client, { workspaceId: a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
          const seen = await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM subscription_addons");
          expect(seen.rows.map((r) => r.workspace_id)).toEqual([a.workspaceId]);
        });
        await expect(
          withTenantContext(client, { workspaceId: a.workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
            tx.query(
              `INSERT INTO subscription_addons (workspace_id, subscription_id, kind, quantity, unit_price_usd, stripe_subscription_item_id)
               VALUES ($1, $2, 'extra_seat', 1, 15, 'si_forged')`,
              [b.workspaceId, bSubscriptionId],
            ),
          ),
        ).rejects.toThrow();
      } finally {
        client.release();
      }
    } finally {
      await app.end();
    }
  });

  it("tenant isolation · an add-on event for workspace A writes nothing in workspace B, and A cannot remove B's add-on by kind", async () => {
    const a = await newWorkspace("growth");
    const b = await newWorkspace("growth");
    stripeSubscription(b.workspaceId, { held: [{ kind: "extra_seat", quantity: 1 }] });
    await reconcile(b.workspaceId);
    stripeSubscription(a.workspaceId, { held: [{ kind: "extra_seat", quantity: 5 }] });
    await reconcile(a.workspaceId);
    expect((await addonRows(b.workspaceId)).map((r) => r.quantity)).toEqual([1]);
    // A holds extra_seat too; removing it targets A's own item id only.
    await del(await enter(a.ownerId, a.workspaceId), "/billing/addons/extra_seat");
    expect(gateway.addonRemovals).toHaveLength(1);
    expect(gateway.addonRemovals[0]!.subscriptionId).toBe(subIdOf(a.workspaceId));
  });

  it("audit · Stripe holding TWO extra_seat lines (a timed-out create, retried under a new key): POST {3} and DELETE are both 409, and Stripe is never changed", async () => {
    const { workspaceId, ownerId } = await newWorkspace("growth");
    stripeSubscription(workspaceId, { held: [{ kind: "extra_seat", quantity: 1 }] });
    expect((await reconcile(workspaceId)).statusCode).toBe(200);
    // The reconcile bumped entitlement_version: a session minted before it is stale.
    const owner = await enter(ownerId, workspaceId);
    // The second line: Stripe applied the first request's create after its gateway timeout.
    const raw = gateway.objects.get(`subscription:${subIdOf(workspaceId)}`)!.raw as { items: { data: Array<Record<string, unknown>> } };
    const first = raw.items.data.find((line) => line.id === "si_extra_seat")!;
    raw.items.data.push({ ...first, id: "si_extra_seat_dup" });
    const rowsBefore = await addonRows(workspaceId);
    const versionBefore = await versionOf(workspaceId);

    const add = await post(owner, "/billing/addons", { kind: "extra_seat", quantity: 3 });
    expect(add.statusCode, add.body).toBe(409);
    const remove = await del(owner, "/billing/addons/extra_seat");
    expect(remove.statusCode, remove.body).toBe(409);

    expect(gateway.addonChanges).toEqual([]);
    expect(gateway.addonRemovals).toEqual([]);
    // Nothing local moved either: the handlers write nothing.
    expect(await addonRows(workspaceId)).toEqual(rowsBefore);
    expect(await versionOf(workspaceId)).toBe(versionBefore);
  });
});
