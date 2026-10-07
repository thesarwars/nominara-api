import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { creditPackPurchaseResponseSchema, creditPackSchema } from "../../contracts/billing/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { STRIPE_GATEWAY, StripeUpstreamError } from "../../src/lib/billing/stripe/stripe-gateway.js";
import { incrementDailyCounter } from "../../src/lib/usage/daily-cap.js";
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
import { FakeStripeGateway, signFakeStripePayload } from "../support/fake-stripe-gateway.js";

// STORY-076a — the credit-pack catalog, the purchase, and credits landing in
// the ledger ONLY when the signature-verified webhook settles it. Real
// ApiModule, real Postgres, RLS in force. Stripe is the fake gateway.

const gateway = new FakeStripeGateway();
const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };

describe("STORY-076a · credit packs", () => {
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
  let log: MockInstance<(...args: unknown[]) => void>;
  let error: MockInstance<(...args: unknown[]) => void>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await harness.db().query(`ALTER ROLE nominara_app PASSWORD '${resolvePassword("nominara_app", {})}'`);
    gateway.objects.clear();
    gateway.packCheckouts.length = 0;
    gateway.fetches.length = 0;
    gateway.configured = true;
    gateway.failFetchWith = undefined;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const membership = new MembershipService(new MembershipCacheService());
    sessions = new SessionService(pool, membership, new InMemoryCacheAdapter());
    workspaces = new WorkspacesService(pool, new LocalDekProvisioner(Buffer.alloc(32, 7), "local:dev"), new AuditChainService(), membership, sessions, new NoopRealtimePublisher());
    log = vi.spyOn(Logger.prototype, "log") as unknown as typeof log;
    error = vi.spyOn(Logger.prototype, "error") as unknown as typeof error;
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
  async function newWorkspace(plan = "free"): Promise<{ workspaceId: string; owner: Actor }> {
    const ownerId = await createUser();
    const ws = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    if (plan !== "free") await harness.db().query("UPDATE workspaces SET plan_key = $2 WHERE id = $1", [ws.id, plan]);
    const tokens = await sessions.createSession(ownerId);
    const entered = await workspaces.switchTo(ownerId, tokens.sid, ws.id, meta);
    return { workspaceId: ws.id, owner: { ...entered, sid: tokens.sid, userId: ownerId } };
  }

  const cookies = (a: Actor) => ({ [ACCESS_COOKIE_NAME]: a.accessToken, [CSRF_COOKIE_NAME]: a.csrfToken });
  const post = (a: Actor, path: string, payload: unknown = {}, key: string | null = randomUUID()) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl(path),
      cookies: cookies(a),
      headers: { [CSRF_HEADER_NAME]: a.csrfToken, "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }) },
      payload: payload as object,
    });
  const get = (a: Actor, path: string) => harness.app().inject({ method: "GET", url: apiUrl(path), cookies: cookies(a) });
  const purchase = (a: Actor, packKey: string, key?: string | null) => post(a, `/billing/credit-packs/${packKey}/purchase`, {}, key);

  const eventBody = (id: string, type: string, objectId: string): string =>
    JSON.stringify({ id, object: "event", type, data: { object: { id: objectId } } });
  const deliver = (body: string) =>
    harness.app().inject({ method: "POST", url: apiUrl("/webhooks/stripe"), headers: { "content-type": "application/json", "stripe-signature": signFakeStripePayload(body) }, payload: body });

  /** Stripe's CURRENT state of the checkout session and PaymentIntent for a purchase. */
  function stripePaid(workspaceId: string, purchaseId: string, over: { pi?: string; cents?: number; currency?: string; paymentStatus?: string; metadata?: Record<string, string> } = {}): { sessionId: string; pi: string } {
    const pi = over.pi ?? `pi_${purchaseId.slice(0, 8)}`;
    const sessionId = `cs_${purchaseId.slice(0, 8)}`;
    const metadata = { workspace_id: workspaceId, purchase_id: purchaseId, ...over.metadata };
    gateway.putObject("checkout_session", sessionId, metadata, {
      mode: "payment",
      payment_status: over.paymentStatus ?? "paid",
      payment_intent: pi,
      amount_total: over.cents ?? 1500,
      currency: over.currency ?? "usd",
    });
    gateway.putObject("payment_intent", pi, metadata, { status: "succeeded", amount_received: over.cents ?? 1500, currency: over.currency ?? "usd" });
    return { sessionId, pi };
  }
  const settle = (sessionId: string, eventId = `evt_${randomUUID()}`) => deliver(eventBody(eventId, "checkout.session.completed", sessionId));

  const purchaseRow = async (id: string) =>
    (await harness.db().query("SELECT status, credits, amount_usd::text AS amount_usd, source, pack_key, purchased_by, stripe_payment_intent_id, expires_at, now() AS db_now FROM credit_purchases WHERE id = $1", [id])).rows[0];
  const ledger = async (workspaceId: string) =>
    (await harness.db().query("SELECT entry_type, bucket, credits, idempotency_key, reference_type, reference_id FROM credit_ledger WHERE workspace_id = $1 ORDER BY seq", [workspaceId])).rows;
  const wallet = async (workspaceId: string) =>
    (await harness.db().query("SELECT purchased_balance, included_balance, lifetime_purchased::text AS lifetime_purchased FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0];
  const audit = async (workspaceId: string, like: string) =>
    (await harness.db().query("SELECT action, resource_type, resource_id FROM audit_log WHERE workspace_id = $1 AND action LIKE $2 ORDER BY seq", [workspaceId, like])).rows;

  async function startPurchase(owner: Actor, pack = "starter_vault"): Promise<string> {
    const res = await purchase(owner, pack);
    expect(res.statusCode, res.body).toBe(200);
    return dataOf<{ purchase_id: string }>(res).purchase_id;
  }

  // ---- scenario 1 ------------------------------------------------------------------------------

  it("scenario 1 · the catalog is filtered to the tier in SQL: free sees only starter_vault, growth sees both, in the pack contract", async () => {
    const free = await newWorkspace();
    const freeList = dataOf<unknown[]>(await get(free.owner, "/billing/credit-packs")).map((p) => creditPackSchema.parse(p));
    expect(freeList.map((p) => p.key)).toEqual(["starter_vault"]);
    expect(freeList[0]).toMatchObject({ credits: 1000, price_usd: "15.00", currency: "USD", min_plan_key: null });
    const growth = await newWorkspace("growth");
    expect(dataOf<Array<{ key: string; credits: number; price_usd: string; min_plan_key: string | null }>>(await get(growth.owner, "/billing/credit-packs"))).toMatchObject([
      { key: "starter_vault" },
      { key: "agency_vault", credits: 5000, price_usd: "50.00", min_plan_key: "growth" },
    ]);
  });

  it("scenario 1 · a viewer may read the catalog (workspace:read) but not buy (403 naming billing:write)", async () => {
    const { workspaceId } = await newWorkspace();
    const viewer = await actorIn(workspaceId, "viewer");
    expect((await get(viewer, "/billing/credit-packs")).statusCode).toBe(200);
    const res = await purchase(viewer, "starter_vault");
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("billing:write");
    expect(gateway.packCheckouts).toHaveLength(0);
  });

  it("scenario 1 · a pack above the tier is a 403 feature_not_in_plan BEFORE any Stripe call and any row", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const res = await purchase(owner, "agency_vault");
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("feature_not_in_plan");
    expect(gateway.packCheckouts).toHaveLength(0);
    expect((await harness.db().query("SELECT 1 FROM credit_purchases WHERE workspace_id = $1", [workspaceId])).rowCount).toBe(0);
  });

  it("scenario 1 · an unknown pack is a 404, not a 403", async () => {
    const { owner } = await newWorkspace();
    expect((await purchase(owner, "no_such_pack")).statusCode).toBe(404);
    expect(gateway.packCheckouts).toHaveLength(0);
  });

  // ---- scenario 2 ------------------------------------------------------------------------------

  it("scenario 2 · a purchase inserts a pending credit_purchases row, creates the session with workspace and purchase ids, and moves no credits", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const before = await ledger(workspaceId);
    const res = await purchase(owner, "starter_vault");
    expect(res.statusCode, res.body).toBe(200);
    const body = creditPackPurchaseResponseSchema.parse(dataOf(res));
    expect(body.status).toBe("pending");
    expect(body.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//u);
    expect(await purchaseRow(body.purchase_id)).toMatchObject({ status: "pending", credits: 1000, amount_usd: "15.00", source: "manual", pack_key: "starter_vault", purchased_by: owner.userId, stripe_payment_intent_id: null, expires_at: null });
    expect(gateway.packCheckouts).toHaveLength(1);
    expect(gateway.packCheckouts[0]).toMatchObject({ workspaceId, purchaseId: body.purchase_id, packKey: "starter_vault", credits: 1000, unitAmountCents: 1500, currency: "USD" });
    expect(gateway.packCheckouts[0]!.successUrl).toContain("/settings/plan");
    expect(await ledger(workspaceId)).toEqual(before);
    expect((await wallet(workspaceId))?.purchased_balance ?? 0).toBe(0);
  });

  it("scenario 2 · a Stripe outage is a 503 with no Stripe text and leaves NO pending row; unconfigured is a 503 too", async () => {
    const { workspaceId, owner } = await newWorkspace();
    gateway.failFetchWith = new StripeUpstreamError(500);
    const res = await purchase(owner, "starter_vault");
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("StripeUpstreamError");
    gateway.failFetchWith = undefined;
    gateway.configured = false;
    expect((await purchase(owner, "starter_vault")).statusCode).toBe(503);
    expect((await harness.db().query("SELECT 1 FROM credit_purchases WHERE workspace_id = $1", [workspaceId])).rowCount).toBe(0);
  });

  it("the Idempotency-Key header is required on the purchase POST (400), and a body key is a 400 (.strict())", async () => {
    const { owner } = await newWorkspace();
    expect((await purchase(owner, "starter_vault", null)).statusCode).toBe(400);
    expect((await post(owner, "/billing/credit-packs/starter_vault/purchase", { credits: 99999 })).statusCode).toBe(400);
    expect(gateway.packCheckouts).toHaveLength(0);
  });

  it("the purchase route is rate limited (credit_pack_purchase, 5/hour per user): a rapid run is refused with 429 rate_limited", async () => {
    const { owner } = await newWorkspace();
    const codes: number[] = [];
    for (let i = 0; i < 8; i += 1) codes.push((await purchase(owner, "starter_vault")).statusCode);
    expect(codes).toContain(429);
    expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(5);
  });

  // ---- scenario 3 ------------------------------------------------------------------------------

  it("scenario 3 · on success one 'purchase' ledger entry keyed by the PaymentIntent id lands, the row succeeds with expires_at = paid + 12 months, and replay stays green", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const id = await startPurchase(owner);
    const { sessionId, pi } = stripePaid(workspaceId, id);
    const res = await settle(sessionId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await ledger(workspaceId)).toMatchObject([{ entry_type: "grant" }, { entry_type: "purchase", bucket: "purchased", credits: 1000, idempotency_key: pi, reference_type: "credit_purchase", reference_id: id }]);
    expect((await wallet(workspaceId))).toMatchObject({ purchased_balance: 1000, lifetime_purchased: "1000" });
    const row = await purchaseRow(id);
    expect(row).toMatchObject({ status: "succeeded", stripe_payment_intent_id: pi });
    const months = (await harness.db().query<{ ok: boolean }>("SELECT $1::timestamptz BETWEEN now() + interval '12 months' - interval '1 minute' AND now() + interval '12 months' + interval '1 minute' AS ok", [row.expires_at])).rows[0]!.ok;
    expect(months).toBe(true);
    expect(await verifyWorkspaceWallet(harness.db(), workspaceId)).toBeNull();
  });

  it("scenario 3 · the same event delivered twice, and the same payment arriving as a different event, credit exactly once", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const id = await startPurchase(owner);
    const { sessionId, pi } = stripePaid(workspaceId, id);
    await settle(sessionId, "evt_same");
    await settle(sessionId, "evt_same");
    expect((await deliver(eventBody("evt_pi", "payment_intent.succeeded", pi))).statusCode).toBe(200);
    expect((await ledger(workspaceId)).filter((e) => e.entry_type === "purchase")).toHaveLength(1);
    expect((await wallet(workspaceId))?.purchased_balance).toBe(1000);
  });

  it("scenario 3 · eight concurrent deliveries (mixed event ids and types) credit exactly once", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const id = await startPurchase(owner);
    const { sessionId, pi } = stripePaid(workspaceId, id);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? settle(sessionId, `evt_c${String(i)}`) : deliver(eventBody(`evt_c${String(i)}`, "payment_intent.succeeded", pi)))),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    expect((await ledger(workspaceId)).filter((e) => e.entry_type === "purchase")).toHaveLength(1);
    expect((await wallet(workspaceId))?.purchased_balance).toBe(1000);
    expect(await verifyWorkspaceWallet(harness.db(), workspaceId)).toBeNull();
    expect(await audit(workspaceId, "billing.credit_purchase.%"), "one settlement, one audit row").toHaveLength(1);
  });

  it("an unpaid session (payment_status != paid) credits nothing", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const id = await startPurchase(owner);
    const { sessionId } = stripePaid(workspaceId, id, { paymentStatus: "unpaid" });
    expect((await settle(sessionId)).statusCode).toBe(200);
    expect((await purchaseRow(id)).status).toBe("pending");
    expect((await ledger(workspaceId)).filter((e) => e.entry_type === "purchase")).toHaveLength(0);
  });

  it("the amount credited comes from the credit_purchases row, never the payload: forged metadata credits cannot raise it", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const id = await startPurchase(owner);
    const { sessionId } = stripePaid(workspaceId, id, { metadata: { credits: "999999", pack_key: "agency_vault" } });
    await settle(sessionId);
    expect((await wallet(workspaceId))?.purchased_balance).toBe(1000);
  });

  it("fail closed · a charged amount that differs from the purchase row credits nothing and is alarmed", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const id = await startPurchase(owner);
    const { sessionId } = stripePaid(workspaceId, id, { cents: 100 });
    expect((await settle(sessionId)).statusCode).toBe(200);
    expect((await purchaseRow(id)).status).toBe("pending");
    expect((await ledger(workspaceId)).filter((e) => e.entry_type === "purchase")).toHaveLength(0);
    expect(JSON.stringify(error.mock.calls)).toContain("does not match");
  });

  it("a purchase id that belongs to ANOTHER workspace credits nothing (RLS), whatever the metadata claims", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    const idOfA = await startPurchase(a.owner);
    const { sessionId } = stripePaid(b.workspaceId, idOfA);
    expect((await settle(sessionId)).statusCode).toBe(200);
    expect((await purchaseRow(idOfA)).status).toBe("pending");
    expect((await ledger(b.workspaceId)).filter((e) => e.entry_type === "purchase")).toHaveLength(0);
    expect((await ledger(a.workspaceId)).filter((e) => e.entry_type === "purchase")).toHaveLength(0);
  });

  it("a subscription-mode checkout is not a credit purchase: no credit_purchases effect", async () => {
    const { workspaceId } = await newWorkspace();
    gateway.putObject("checkout_session", "cs_sub", { workspace_id: workspaceId }, { mode: "subscription", subscription: "sub_x" });
    gateway.putObject("subscription", "sub_x", { workspace_id: workspaceId }, { status: "incomplete", items: { data: [] } });
    expect((await settle("cs_sub")).statusCode).toBe(200);
    expect((await ledger(workspaceId)).filter((e) => e.entry_type === "purchase")).toHaveLength(0);
  });

  // ---- failure ---------------------------------------------------------------------------------

  it("on payment failure the purchase is marked failed and no credits move; a later successful retry of the same payment still settles", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const id = await startPurchase(owner);
    const { sessionId, pi } = stripePaid(workspaceId, id);
    gateway.putObject("payment_intent", pi, { workspace_id: workspaceId, purchase_id: id }, { status: "requires_payment_method", amount: 1500, currency: "usd" });
    expect((await deliver(eventBody("evt_fail", "payment_intent.payment_failed", pi))).statusCode).toBe(200);
    expect((await purchaseRow(id)).status).toBe("failed");
    expect((await ledger(workspaceId)).filter((e) => e.entry_type === "purchase")).toHaveLength(0);
    expect((await wallet(workspaceId))?.purchased_balance ?? 0).toBe(0);
    stripePaid(workspaceId, id);
    await settle(sessionId);
    expect((await purchaseRow(id)).status).toBe("succeeded");
    expect((await wallet(workspaceId))?.purchased_balance).toBe(1000);
  });

  it("a failure event can never undo a purchase that already succeeded", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const id = await startPurchase(owner);
    const { sessionId, pi } = stripePaid(workspaceId, id);
    await settle(sessionId);
    gateway.putObject("payment_intent", pi, { workspace_id: workspaceId, purchase_id: id }, { status: "requires_payment_method" });
    await deliver(eventBody("evt_late_fail", "payment_intent.payment_failed", pi));
    expect((await purchaseRow(id)).status).toBe("succeeded");
    expect((await wallet(workspaceId))?.purchased_balance).toBe(1000);
  });

  // ---- scenario 5 ------------------------------------------------------------------------------

  it("scenario 5 · on a daily-capped tier, a purchase followed by exceeding the daily cap is still refused, and the counter is untouched by the purchase", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const db = harness.db();
    for (let i = 0; i < 3; i += 1) expect(await incrementDailyCounter(db, workspaceId, "lookup", 3)).not.toBeNull();
    const id = await startPurchase(owner);
    const { sessionId } = stripePaid(workspaceId, id);
    await settle(sessionId);
    expect((await wallet(workspaceId))?.purchased_balance).toBe(1000);
    expect(await incrementDailyCounter(db, workspaceId, "lookup", 3)).toBeNull();
    const counter = await db.query("SELECT used_count FROM credit_daily_counters WHERE workspace_id = $1 AND action_code = 'lookup'", [workspaceId]);
    expect(counter.rows[0].used_count).toBe(3);
  });

  // ---- scenario 14 -----------------------------------------------------------------------------

  it("scenario 14 · the purchase and its settlement each write an audit row against the purchase", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const id = await startPurchase(owner);
    expect(await audit(workspaceId, "billing.credit_pack.%")).toEqual([{ action: "billing.credit_pack.purchase_created", resource_type: "credit_purchase", resource_id: id }]);
    const { sessionId } = stripePaid(workspaceId, id);
    await settle(sessionId);
    await settle(sessionId, "evt_again");
    expect(await audit(workspaceId, "billing.credit_purchase.%")).toEqual([{ action: "billing.credit_purchase.succeeded", resource_type: "credit_purchase", resource_id: id }]);
  });

  it("a failed settlement writes its own audit row", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const id = await startPurchase(owner);
    const { pi } = stripePaid(workspaceId, id);
    gateway.putObject("payment_intent", pi, { workspace_id: workspaceId, purchase_id: id }, { status: "requires_payment_method" });
    await deliver(eventBody("evt_f", "payment_intent.payment_failed", pi));
    expect(await audit(workspaceId, "billing.credit_purchase.%")).toMatchObject([{ action: "billing.credit_purchase.failed", resource_id: id }]);
  });

  // ---- observability ---------------------------------------------------------------------------

  it("emits the purchase and settlement counters, and the log lines carry the workspace id and no PII or Stripe text", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const id = await startPurchase(owner);
    const { sessionId } = stripePaid(workspaceId, id, { metadata: { customer_email: "pii@example.com" } });
    await settle(sessionId);
    const metrics = log.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((c) => typeof c === "object" && typeof c?.metric === "string");
    expect(metrics).toContainEqual({ metric: "nominara_billing_credit_pack_purchase_total", value: 1, outcome: "created" });
    expect(metrics).toContainEqual({ metric: "nominara_billing_credit_pack_settlement_total", value: 1, outcome: "succeeded" });
    const emitted = JSON.stringify(log.mock.calls);
    expect(emitted).toContain(workspaceId);
    expect(emitted).not.toContain("pii@example.com");
  });
});
