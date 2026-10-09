import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { Pool, type PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { autoTopupConfigSchema } from "../../contracts/billing/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { STRIPE_GATEWAY, StripeUpstreamError, type OffSessionPaymentInput } from "../../src/lib/billing/stripe/stripe-gateway.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { createBillingAutoTopupHandler } from "../../src/lib/queue/handlers/billing-auto-topup.handler.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { topologyFor } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { AutoTopupService } from "../../src/modules/billing/auto-topup.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { EMAIL_SENDER, type EmailMessage, type EmailSender } from "../../src/modules/identity/ports/email-sender.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { dataOf } from "../support/envelope.js";
import { FakeStripeGateway, signFakeStripePayload } from "../support/fake-stripe-gateway.js";

// NEW-D-7 — the auto-top-up trigger. Real ApiModule, real Postgres, requests
// served as `nominara_app` (RLS in force). Stripe is the fake gateway; the
// email port is a recording fake. STORY-076 scenarios 7 and 9.

const gateway = new FakeStripeGateway();

class RecordingEmail implements EmailSender {
  readonly sent: EmailMessage[] = [];
  failNext = false;
  send(message: EmailMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("smtp down"));
    }
    this.sent.push(message);
    return Promise.resolve();
  }
}
const email = new RecordingEmail();
const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };
const BILLING_EMAIL = "billing-contact@example.com";

describe("NEW-D-7 · auto-top-up trigger", () => {
  const harness = useApiHarness({
    env: () => {
      const url = new URL(process.env.DATABASE_URL!);
      url.username = "nominara_app";
      url.password = resolvePassword("nominara_app", {});
      return { DATABASE_URL_POOLED: url.toString() };
    },
    configure: (builder) => {
      builder.overrideProvider(STRIPE_GATEWAY).useValue(gateway);
      builder.overrideProvider(EMAIL_SENDER).useValue(email);
    },
  });

  let pool: Pool;
  let sessions: SessionService;
  let workspaces: WorkspacesService;
  let log: MockInstance<(...args: unknown[]) => void>;
  let service: AutoTopupService;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await harness.db().query(`ALTER ROLE nominara_app PASSWORD '${resolvePassword("nominara_app", {})}'`);
    gateway.objects.clear();
    gateway.savedMethods.clear();
    gateway.savedMethodLookups.length = 0;
    gateway.resetOffSession();
    gateway.failFetchWith = undefined;
    gateway.offSessionStates.clear();
    gateway.offSessionStateLookups.length = 0;
    gateway.failStateLookupWith = undefined;
    gateway.configured = true;
    email.sent.length = 0;
    email.failNext = false;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const membership = new MembershipService(new MembershipCacheService());
    sessions = new SessionService(pool, membership, new InMemoryCacheAdapter());
    workspaces = new WorkspacesService(pool, new LocalDekProvisioner(Buffer.alloc(32, 7), "local:dev"), new AuditChainService(), membership, sessions, new NoopRealtimePublisher());
    log = vi.spyOn(Logger.prototype, "log") as unknown as typeof log;
    service = harness.app().get(AutoTopupService, { strict: false });
  });
  afterEach(async () => {
    await pool.end();
  });

  interface Actor {
    readonly accessToken: string;
    readonly csrfToken: string;
    readonly userId: string;
  }
  async function createUser(): Promise<string> {
    const r = await harness.db().query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${randomUUID()}@example.com`]);
    return r.rows[0]!.id;
  }
  const cookies = (a: Actor) => ({ [ACCESS_COOKIE_NAME]: a.accessToken, [CSRF_COOKIE_NAME]: a.csrfToken });
  const put = (a: Actor, payload: unknown) =>
    harness.app().inject({
      method: "PUT",
      url: apiUrl("/billing/wallet/auto-topup"),
      cookies: cookies(a),
      headers: { [CSRF_HEADER_NAME]: a.csrfToken, "content-type": "application/json", "idempotency-key": randomUUID() },
      payload: payload as object,
    });
  const getWallet = (a: Actor) => harness.app().inject({ method: "GET", url: apiUrl("/billing/wallet"), cookies: cookies(a) });

  interface Armed {
    workspaceId: string;
    owner: Actor;
    referencePi: string;
  }
  /** A Growth workspace with auto-top-up on (starter_vault, below 100, cap `max`), a low balance, a billing contact and a saved card. */
  async function armed(over: { max?: number; saved?: boolean; plan?: string; billingEmail?: string | null; reference?: boolean } = {}): Promise<Armed> {
    const ownerId = await createUser();
    const ws = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    await harness.db().query("UPDATE workspaces SET plan_key = $2, billing_email = $3 WHERE id = $1", [ws.id, over.plan ?? "growth", over.billingEmail === undefined ? BILLING_EMAIL : over.billingEmail]);
    const tokens = await sessions.createSession(ownerId);
    const entered = await workspaces.switchTo(ownerId, tokens.sid, ws.id, meta);
    const owner: Actor = { ...entered, userId: ownerId };
    const res = await put(owner, { enabled: true, pack_key: "starter_vault", threshold: 100, max_per_cycle: over.max ?? 3 });
    expect(res.statusCode, res.body).toBe(200);
    await setBalance(ws.id, 50);
    const referencePi = `pi_ref_${ws.id}`;
    if (over.reference !== false) {
      await harness.db().query(
        `INSERT INTO credit_purchases (workspace_id, pack_key, credits, amount_usd, source, status, stripe_payment_intent_id, expires_at, purchased_by)
         VALUES ($1,'starter_vault',1000,15.00,'manual','succeeded',$2, now() + interval '12 months', $3)`,
        [ws.id, referencePi, ownerId],
      );
    }
    if (over.saved !== false) gateway.savedMethods.set(referencePi, { customerId: "cus_saved_1", paymentMethodId: "pm_saved_1" });
    return { workspaceId: ws.id, owner, referencePi };
  }
  const setBalance = (workspaceId: string, available: number, reserved = 0) =>
    harness.db().query("UPDATE credit_wallets SET included_balance = $2, purchased_balance = 0, reserved = $3 WHERE workspace_id = $1", [workspaceId, available + reserved, reserved]);

  const autoPurchases = async (workspaceId: string) =>
    (await harness.db().query("SELECT id, status, source, pack_key, credits, amount_usd::text AS amount_usd, purchased_by, stripe_payment_intent_id FROM credit_purchases WHERE workspace_id = $1 AND source = 'auto_topup' ORDER BY created_at, id", [workspaceId])).rows;
  const wallet = async (workspaceId: string) =>
    (await harness.db().query("SELECT included_balance, purchased_balance, auto_topup_enabled, auto_topup_count_cycle FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0];
  const ledger = async (workspaceId: string) => (await harness.db().query("SELECT entry_type, credits, idempotency_key FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'purchase' ORDER BY seq", [workspaceId])).rows;
  const audit = async (workspaceId: string, like: string) =>
    (await harness.db().query("SELECT action, resource_type, resource_id, after_state FROM audit_log WHERE workspace_id = $1 AND action LIKE $2 ORDER BY seq", [workspaceId, like])).rows;

  const eventBody = (id: string, type: string, objectId: string): string => JSON.stringify({ id, object: "event", type, data: { object: { id: objectId } } });
  const deliver = (body: string) =>
    harness.app().inject({ method: "POST", url: apiUrl("/webhooks/stripe"), headers: { "content-type": "application/json", "stripe-signature": signFakeStripePayload(body) }, payload: body });
  /** Stripe's CURRENT state of the auto-top-up PaymentIntent, then the event that points at it. */
  async function stripeSays(workspaceId: string, purchaseId: string, pi: string, kind: "succeeded" | "failed", eventId = `evt_${randomUUID()}`, cents = 1500) {
    const metadata = { workspace_id: workspaceId, purchase_id: purchaseId, source: "auto_topup" };
    gateway.putObject("payment_intent", pi, metadata, kind === "succeeded" ? { status: "succeeded", amount_received: cents, currency: "usd" } : { status: "requires_payment_method", amount_received: 0, currency: "usd" });
    return deliver(eventBody(eventId, kind === "succeeded" ? "payment_intent.succeeded" : "payment_intent.payment_failed", pi));
  }
  const piOf = (purchaseId: string) => `pi_auto_${purchaseId.slice(0, 8)}`;

  // ---- STORY-076 scenario 7 --------------------------------------------------------------------

  it("STORY-076 scenario 7 · firing repeatedly stops at the cap, and every one of those triggers was emailed", async () => {
    const { workspaceId } = await armed({ max: 3 });
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      outcomes.push(await service.trigger(workspaceId));
      const pending = (await autoPurchases(workspaceId)).find((p) => p.status === "pending");
      if (pending !== undefined) {
        expect((await stripeSays(workspaceId, pending.id as string, piOf(pending.id as string), "succeeded")).statusCode).toBe(200);
      }
      await setBalance(workspaceId, 50);
    }
    expect(outcomes).toEqual(["charge_submitted", "charge_submitted", "charge_submitted", "cap_reached", "cap_reached"]);
    expect(gateway.offSessionCharges).toHaveLength(3);
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(3);
    expect(await autoPurchases(workspaceId)).toHaveLength(3);
    const triggered = email.sent.filter((m) => m.subject === "Nominara auto top-up triggered");
    expect(triggered).toHaveLength(3);
    expect(triggered.every((m) => m.to === BILLING_EMAIL)).toBe(true);
  });

  it("STORY-076 scenario 7 · concurrent triggers cannot exceed the cap: eight at once against one slot left charge exactly once", async () => {
    const { workspaceId } = await armed({ max: 2 });
    await harness.db().query("UPDATE credit_wallets SET auto_topup_count_cycle = 1 WHERE workspace_id = $1", [workspaceId]);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => service.trigger(workspaceId)));
    expect(outcomes.filter((o) => o === "charge_submitted")).toHaveLength(1);
    expect(outcomes.filter((o) => o !== "charge_submitted").every((o) => o === "in_flight" || o === "cap_reached")).toBe(true);
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(2);
    expect(gateway.offSessionCharges).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
  });

  const lookupsReached = async (n: number) => {
    for (let i = 0; i < 200 && gateway.savedMethodLookups.length < n; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(gateway.savedMethodLookups.length).toBeGreaterThanOrEqual(n);
  };

  it("STORY-076 scenario 7 · the cap is enforced by the claim itself: a trigger that planned before the cap was spent is refused at the UPDATE", async () => {
    const { workspaceId } = await armed({ max: 1 });
    const release = gateway.holdLookups();
    const stale = service.trigger(workspaceId); // planned with count 0 of 1, parked before its claim
    await lookupsReached(1);
    gateway.stopHoldingNewLookups();
    expect(await service.trigger(workspaceId)).toBe("charge_submitted");
    const purchase = (await autoPurchases(workspaceId))[0]!;
    expect((await stripeSays(workspaceId, purchase.id as string, piOf(purchase.id as string), "succeeded")).statusCode).toBe(200);
    await setBalance(workspaceId, 50);
    release();
    expect(await stale).toBe("cap_reached");
    expect(gateway.offSessionCharges).toHaveLength(1);
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(1);
    expect(email.sent.filter((m) => m.subject === "Nominara auto top-up triggered")).toHaveLength(1);
  });

  it("STORY-076 scenario 7 · two triggers that both planned with nothing in flight charge once, with cap left (the claim serialises on the wallet row)", async () => {
    const { workspaceId } = await armed({ max: 5 });
    const release = gateway.holdLookups();
    const both = Promise.all([service.trigger(workspaceId), service.trigger(workspaceId)]);
    await lookupsReached(2);
    release();
    const outcomes = (await both).sort();
    expect(outcomes).toEqual(["charge_submitted", "in_flight"]);
    expect(gateway.offSessionCharges).toHaveLength(1);
    expect(await autoPurchases(workspaceId)).toHaveLength(1);
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(1);
  });

  it("STORY-076 scenario 7 · with a charge still in flight a further trigger charges nothing, even with cap left (in_flight)", async () => {
    const { workspaceId } = await armed({ max: 5 });
    expect(await service.trigger(workspaceId)).toBe("charge_submitted");
    expect(await service.trigger(workspaceId)).toBe("in_flight");
    expect(await service.trigger(workspaceId)).toBe("in_flight");
    expect(gateway.offSessionCharges).toHaveLength(1);
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(1);
  });

  it("STORY-076 scenario 7 · the threshold boundary: available equal to the threshold does not fire, one below does; reserved credits are not available", async () => {
    const { workspaceId } = await armed();
    await setBalance(workspaceId, 100);
    expect(await service.trigger(workspaceId)).toBe("above_threshold");
    await setBalance(workspaceId, 99);
    expect(await service.trigger(workspaceId)).toBe("charge_submitted");
    const second = await armed();
    await setBalance(second.workspaceId, 90, 20); // 110 on hand, 20 reserved -> 90 available
    expect(await service.trigger(second.workspaceId)).toBe("charge_submitted");
  });

  it("STORY-076 scenario 7 · a disabled configuration never fires, and nothing is emailed or charged", async () => {
    const { workspaceId, owner } = await armed();
    expect((await put(owner, { enabled: false, pack_key: null, threshold: null, max_per_cycle: null })).statusCode).toBe(200);
    expect(await service.trigger(workspaceId)).toBe("not_enabled");
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect(gateway.savedMethodLookups).toHaveLength(0);
  });

  it("NEW-D-7 · a workspace with no wallet at all is not_enabled, not an error", async () => {
    const ownerId = await createUser();
    const ws = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    expect(await service.trigger(ws.id)).toBe("not_enabled");
  });

  it("STORY-076 scenario 7 · the charge is the pack's own price from the catalog, to the saved customer and method, keyed on the purchase", async () => {
    const { workspaceId } = await armed();
    expect(await service.trigger(workspaceId)).toBe("charge_submitted");
    const [row] = await autoPurchases(workspaceId);
    expect(row).toMatchObject({ status: "pending", source: "auto_topup", pack_key: "starter_vault", credits: 1000, amount_usd: "15.00", purchased_by: null, stripe_payment_intent_id: null });
    expect(gateway.offSessionCharges[0]).toMatchObject({
      workspaceId,
      purchaseId: row!.id,
      packKey: "starter_vault",
      unitAmountCents: 1500,
      currency: "USD",
      customerId: "cus_saved_1",
      paymentMethodId: "pm_saved_1",
    });
  });

  it("STORY-076 scenario 7 · the email names the pack and amount, goes to the billing contact, and an owner's address is the fallback when there is none", async () => {
    const { workspaceId } = await armed();
    await service.trigger(workspaceId);
    expect(email.sent[0]).toMatchObject({ to: BILLING_EMAIL, subject: "Nominara auto top-up triggered" });
    expect(email.sent[0]!.textBody).toContain("1000");
    expect(email.sent[0]!.textBody).toContain("15.00");

    const noContact = await armed({ billingEmail: null });
    const ownerEmail = (await harness.db().query<{ email: string }>("SELECT email FROM users WHERE id = $1", [noContact.owner.userId])).rows[0]!.email;
    email.sent.length = 0;
    expect(await service.trigger(noContact.workspaceId)).toBe("charge_submitted");
    expect(email.sent.map((m) => m.to)).toEqual([ownerEmail]);
  });

  it("NEW-D-7 · nobody to email means nobody is charged: no_billing_contact consumes no cap slot and creates no purchase", async () => {
    const { workspaceId } = await armed({ billingEmail: null });
    await harness.db().query("DELETE FROM workspace_members WHERE workspace_id = $1", [workspaceId]);
    expect(await service.trigger(workspaceId)).toBe("no_billing_contact");
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect(await autoPurchases(workspaceId)).toHaveLength(0);
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(0);
  });

  it("NEW-D-7 · if the email cannot be sent the card is not charged (fail closed): the purchase is failed and auto-top-up stays on", async () => {
    const { workspaceId } = await armed();
    email.failNext = true;
    expect(await service.trigger(workspaceId)).toBe("email_failed");
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect((await autoPurchases(workspaceId))[0]).toMatchObject({ status: "failed" });
    expect(await wallet(workspaceId)).toMatchObject({ auto_topup_enabled: true, auto_topup_count_cycle: 1 });
  });

  it("NEW-D-7 · a pack the catalog no longer sells to this workspace is pack_unavailable: nothing charged, no slot consumed", async () => {
    const { workspaceId } = await armed({ plan: "growth" });
    await harness.db().query("UPDATE credit_packs SET is_public = false WHERE key = 'starter_vault'");
    try {
      expect(await service.trigger(workspaceId)).toBe("pack_unavailable");
    } finally {
      await harness.db().query("UPDATE credit_packs SET is_public = true WHERE key = 'starter_vault'");
    }
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(0);
  });

  // ---- credits land through the webhook ---------------------------------------------------------

  it("STORY-076a path · a trigger moves no credit: the purchase is pending and the ledger and wallet are unchanged until the webhook", async () => {
    const { workspaceId } = await armed();
    const before = { ledger: await ledger(workspaceId), wallet: await wallet(workspaceId) };
    expect(await service.trigger(workspaceId)).toBe("charge_submitted");
    expect(await ledger(workspaceId)).toEqual(before.ledger);
    expect((await wallet(workspaceId))?.purchased_balance).toBe(before.wallet?.purchased_balance);
    expect((await wallet(workspaceId))?.included_balance).toBe(before.wallet?.included_balance);
  });

  it("STORY-076a path · payment_intent.succeeded lands the credits through credit_purchases (source auto_topup), keyed on the PaymentIntent, and a redelivery adds nothing", async () => {
    const { workspaceId } = await armed();
    await service.trigger(workspaceId);
    const purchase = (await autoPurchases(workspaceId))[0]!;
    const pi = piOf(purchase.id as string);
    expect((await stripeSays(workspaceId, purchase.id as string, pi, "succeeded", "evt_ok_1")).statusCode).toBe(200);
    expect(dataOf<{ outcome: string }>(await stripeSays(workspaceId, purchase.id as string, pi, "succeeded", "evt_ok_1")).outcome).toBe("duplicate");
    expect((await stripeSays(workspaceId, purchase.id as string, pi, "succeeded", "evt_ok_2")).statusCode).toBe(200);
    expect((await autoPurchases(workspaceId))[0]).toMatchObject({ status: "succeeded", stripe_payment_intent_id: pi });
    expect(await ledger(workspaceId)).toEqual([expect.objectContaining({ entry_type: "purchase", credits: 1000, idempotency_key: pi })]);
    expect((await wallet(workspaceId))?.purchased_balance).toBe(1000);
  });

  it("STORY-076a path · a charge whose amount differs from the purchase row credits nothing", async () => {
    const { workspaceId } = await armed();
    await service.trigger(workspaceId);
    const purchase = (await autoPurchases(workspaceId))[0]!;
    await stripeSays(workspaceId, purchase.id as string, piOf(purchase.id as string), "succeeded", `evt_${randomUUID()}`, 100);
    expect((await autoPurchases(workspaceId))[0]).toMatchObject({ status: "pending" });
    expect(await ledger(workspaceId)).toEqual([]);
  });

  // ---- STORY-076 scenario 9 ---------------------------------------------------------------------

  it("STORY-076 scenario 9 · a payment that fails at the webhook disables auto-top-up, notifies the billing contact, and records why", async () => {
    const { workspaceId, owner } = await armed();
    await service.trigger(workspaceId);
    const purchase = (await autoPurchases(workspaceId))[0]!;
    email.sent.length = 0;
    expect((await stripeSays(workspaceId, purchase.id as string, piOf(purchase.id as string), "failed")).statusCode).toBe(200);
    expect(await wallet(workspaceId)).toMatchObject({ auto_topup_enabled: false, auto_topup_count_cycle: 1 });
    expect((await autoPurchases(workspaceId))[0]).toMatchObject({ status: "failed" });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ to: BILLING_EMAIL, subject: "Nominara auto top-up disabled after a failed payment" });
    expect(await audit(workspaceId, "billing.auto_topup.disabled")).toEqual([
      expect.objectContaining({ resource_type: "credit_wallet", after_state: expect.objectContaining({ reason: "payment_failed", enabled: false }) }),
    ]);
    const config = autoTopupConfigSchema.parse(dataOf<{ auto_topup: unknown }>(await getWallet(owner)).auto_topup);
    expect(config).toMatchObject({ enabled: false, used_this_cycle: 1, disabled_reason: "payment_failed" });
  });

  it("STORY-076 scenario 9 · it never retries: after the failure further triggers are not_enabled and no second charge is made", async () => {
    const { workspaceId } = await armed({ max: 5 });
    await service.trigger(workspaceId);
    const purchase = (await autoPurchases(workspaceId))[0]!;
    await stripeSays(workspaceId, purchase.id as string, piOf(purchase.id as string), "failed");
    expect(await service.trigger(workspaceId)).toBe("not_enabled");
    expect(await service.trigger(workspaceId)).toBe("not_enabled");
    expect(gateway.offSessionCharges).toHaveLength(1);
  });

  it("STORY-076 scenario 9 · a redelivered failure, and a second event for the same failed purchase, notify only once", async () => {
    const { workspaceId } = await armed();
    await service.trigger(workspaceId);
    const purchase = (await autoPurchases(workspaceId))[0]!;
    email.sent.length = 0;
    await stripeSays(workspaceId, purchase.id as string, piOf(purchase.id as string), "failed", "evt_f_1");
    await stripeSays(workspaceId, purchase.id as string, piOf(purchase.id as string), "failed", "evt_f_1");
    await stripeSays(workspaceId, purchase.id as string, piOf(purchase.id as string), "failed", "evt_f_2");
    expect(email.sent).toHaveLength(1);
    expect(await audit(workspaceId, "billing.auto_topup.disabled")).toHaveLength(1);
  });

  it("STORY-076 scenario 9 · a decline answered synchronously by the provider takes the same path: disabled, notified, failed, never retried", async () => {
    const { workspaceId } = await armed({ max: 5 });
    gateway.offSessionOutcome = "declined";
    expect(await service.trigger(workspaceId)).toBe("declined");
    expect(await wallet(workspaceId)).toMatchObject({ auto_topup_enabled: false, auto_topup_count_cycle: 1 });
    expect((await autoPurchases(workspaceId))[0]).toMatchObject({ status: "failed" });
    expect(email.sent.map((m) => m.subject)).toEqual(["Nominara auto top-up triggered", "Nominara auto top-up disabled after a failed payment"]);
    expect(await service.trigger(workspaceId)).toBe("not_enabled");
    expect(gateway.offSessionCharges).toHaveLength(1);
  });

  it("STORY-076 scenario 9 · a customer who turns it back on clears the reason, and the cycle counter is not reset by doing so", async () => {
    const { workspaceId, owner } = await armed({ max: 5 });
    gateway.offSessionOutcome = "declined";
    await service.trigger(workspaceId);
    expect((await put(owner, { enabled: true, pack_key: "starter_vault", threshold: 100, max_per_cycle: 5 })).statusCode).toBe(200);
    const config = autoTopupConfigSchema.parse(dataOf<{ auto_topup: unknown }>(await getWallet(owner)).auto_topup);
    expect(config.enabled).toBe(true);
    expect(config.disabled_reason).toBeUndefined();
    expect(config.used_this_cycle).toBe(1);
  });

  it("STORY-076 scenario 9 · a failed MANUAL purchase does not touch the auto-top-up setting", async () => {
    const { workspaceId } = await armed();
    const manual = (
      await harness.db().query<{ id: string }>(
        "INSERT INTO credit_purchases (workspace_id, pack_key, credits, amount_usd, source, status) VALUES ($1,'starter_vault',1000,15.00,'manual','pending') RETURNING id",
        [workspaceId],
      )
    ).rows[0]!.id;
    gateway.putObject("payment_intent", "pi_manual_fail", { workspace_id: workspaceId, purchase_id: manual }, { status: "requires_payment_method", amount_received: 0, currency: "usd" });
    expect((await deliver(eventBody("evt_manual_fail", "payment_intent.payment_failed", "pi_manual_fail"))).statusCode).toBe(200);
    expect((await wallet(workspaceId))?.auto_topup_enabled).toBe(true);
    expect(email.sent).toHaveLength(0);
  });

  it("NEW-D-7 audit F2 · a provider outage on the charge leaves the purchase pending: the in-flight guard stays closed, so the card is never charged twice and a late success still settles", async () => {
    const { workspaceId } = await armed({ max: 5 });
    gateway.failChargeWith = new StripeUpstreamError(503);
    expect(await service.trigger(workspaceId)).toBe("upstream_error");
    expect((await autoPurchases(workspaceId))[0]).toMatchObject({ status: "pending" });
    expect(await wallet(workspaceId)).toMatchObject({ auto_topup_enabled: true, auto_topup_count_cycle: 1 });
    // The charge may have gone through. Provider recovered: a further trigger must NOT charge again.
    gateway.failChargeWith = undefined;
    expect(await service.trigger(workspaceId)).toBe("in_flight");
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect(await autoPurchases(workspaceId)).toHaveLength(1);
    const purchase = (await autoPurchases(workspaceId))[0]!;
    await stripeSays(workspaceId, purchase.id as string, piOf(purchase.id as string), "succeeded");
    expect((await autoPurchases(workspaceId))[0]).toMatchObject({ status: "succeeded" });
  });

  // ---- NEW-D-7 audit F3: a downgrade ------------------------------------------------------------

  it("NEW-D-7 audit F3 · a workspace downgraded below Growth after enabling auto-top-up is not_in_plan: nothing charged, emailed or counted", async () => {
    const { workspaceId } = await armed({ plan: "growth" });
    await harness.db().query("UPDATE workspaces SET plan_key = 'free' WHERE id = $1", [workspaceId]);
    expect(await service.trigger(workspaceId)).toBe("not_in_plan");
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect(await autoPurchases(workspaceId)).toHaveLength(0);
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(0);
  });

  it("NEW-D-7 audit F3 · the claim re-checks the plan: a downgrade between plan and claim is refused at the UPDATE", async () => {
    const { workspaceId } = await armed({ plan: "growth" });
    const release = gateway.holdLookups();
    const stale = service.trigger(workspaceId);
    await lookupsReached(1);
    await harness.db().query("UPDATE workspaces SET plan_key = 'free' WHERE id = $1", [workspaceId]);
    release();
    expect(await stale).toBe("not_in_plan");
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(0);
  });

  // ---- NEW-D-7 audit: every guard in the claim UPDATE has a test that fails without it -------------

  // The second shape is the realistic one (the settings page flips the switch and keeps the rest), and the
  // only one that isolates the `enabled` predicate: with pack_key kept, the pack predicate cannot refuse it.
  it.each([
    ["clears the configuration", { enabled: false, pack_key: null, threshold: null, max_per_cycle: null }],
    ["keeps pack, threshold and cap", { enabled: false, pack_key: "starter_vault", threshold: 100, max_per_cycle: 5 }],
  ] as const)("NEW-D-7 audit · the claim re-checks `enabled`: opting out between plan and claim (switch off, %s) is refused at the UPDATE: not_enabled, no charge, no email, no slot", async (_shape, off) => {
    const { workspaceId, owner } = await armed({ max: 5 });
    const release = gateway.holdLookups();
    const stale = service.trigger(workspaceId); // planned while enabled, parked in the card lookup
    await lookupsReached(1);
    expect((await put(owner, off)).statusCode).toBe(200);
    release();
    expect(await stale).toBe("not_enabled");
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect(await autoPurchases(workspaceId)).toHaveLength(0);
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(0);
  });

  it("NEW-D-7 audit · the claim re-checks the threshold: a balance that recovered between plan and claim is above_threshold at the UPDATE, nothing charged", async () => {
    const { workspaceId } = await armed({ max: 5 });
    const release = gateway.holdLookups();
    const stale = service.trigger(workspaceId); // planned at 50 of 100
    await lookupsReached(1);
    await setBalance(workspaceId, 500); // a manual pack settled
    release();
    expect(await stale).toBe("above_threshold");
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect(await autoPurchases(workspaceId)).toHaveLength(0);
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(0);
  });

  it("NEW-D-7 audit · the claim re-checks the pack: a pack switched between plan and claim is not charged at the stale pack's price", async () => {
    const { workspaceId, owner } = await armed({ max: 5 });
    expect((await put(owner, { enabled: true, pack_key: "agency_vault", threshold: 100, max_per_cycle: 5 })).statusCode).toBe(200);
    const release = gateway.holdLookups();
    const stale = service.trigger(workspaceId); // planned for agency_vault ($50)
    await lookupsReached(1);
    expect((await put(owner, { enabled: true, pack_key: "starter_vault", threshold: 100, max_per_cycle: 5 })).statusCode).toBe(200);
    release();
    expect(await stale).not.toBe("charge_submitted");
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect(await autoPurchases(workspaceId)).toHaveLength(0);
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(0);
  });

  // ---- NEW-D-7 audit F6: a stuck pending purchase ----------------------------------------------

  /** An auto-top-up charge whose answer never came back (503) and whose purchase is now `minutes` old. */
  async function stuckPending(minutes = 61, how: "never_reached" | "reached" = "never_reached") {
    const armedWs = await armed({ max: 5 });
    if (how === "reached") gateway.failChargeAfterReaching = new StripeUpstreamError(503);
    else gateway.failChargeWith = new StripeUpstreamError(503);
    expect(await service.trigger(armedWs.workspaceId)).toBe("upstream_error");
    gateway.failChargeWith = undefined;
    gateway.failChargeAfterReaching = undefined;
    const stuck = (await autoPurchases(armedWs.workspaceId))[0]!;
    await harness.db().query("UPDATE credit_purchases SET created_at = now() - make_interval(mins => $2::int) WHERE id = $1", [stuck.id, minutes]);
    return { workspaceId: armedWs.workspaceId, stuck };
  }

  it.each(["in_progress", "succeeded"] as const)(
    "NEW-D-7 audit F6 · a stale pending purchase that Stripe says is %s is NOT expired and is NOT charged again (a clock alone proves nothing about the money)",
    async (state) => {
      const { workspaceId, stuck } = await stuckPending();
      gateway.offSessionStates.set(stuck.id as string, state);
      expect(await service.trigger(workspaceId)).toBe("in_flight");
      expect(gateway.offSessionStateLookups).toEqual([stuck.id]);
      expect(gateway.offSessionCharges).toHaveLength(0);
      expect(email.sent.filter((m) => m.subject === "Nominara auto top-up triggered")).toHaveLength(1);
      const purchases = await autoPurchases(workspaceId);
      expect(purchases).toHaveLength(1);
      expect(purchases[0]).toMatchObject({ id: stuck.id, status: "pending" });
      expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(1);
      expect(await audit(workspaceId, "billing.auto_topup.pending_expired")).toEqual([]);
    },
  );

  it("NEW-D-7 checkpoint-3 F1 · a stale pending purchase that Stripe says FAILED (the card declined) goes down the decline path: failed, disabled, notified, and NO new charge in that run", async () => {
    const { workspaceId, stuck } = await stuckPending();
    gateway.offSessionStates.set(stuck.id as string, "failed");
    expect(await service.trigger(workspaceId)).toBe("declined");
    expect(await wallet(workspaceId)).toMatchObject({ auto_topup_enabled: false, auto_topup_count_cycle: 1 });
    const purchases = await autoPurchases(workspaceId);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({ id: stuck.id, status: "failed" });
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect(email.sent.map((m) => m.subject)).toEqual(["Nominara auto top-up triggered", "Nominara auto top-up disabled after a failed payment"]);
    expect(await audit(workspaceId, "billing.auto_topup.disabled")).toHaveLength(1);
    expect(await service.trigger(workspaceId)).toBe("not_enabled");
    expect(gateway.offSessionCharges).toHaveLength(0);
  });

  it("NEW-D-7 checkpoint-3 F2 · Search saying `none` proves nothing (Search lags in an outage): the SAME purchase is replayed under its own idempotency key, and no new purchase, slot or purchase id is taken", async () => {
    const { workspaceId, stuck } = await stuckPending();
    expect(await service.trigger(workspaceId)).toBe("charge_submitted");
    expect(gateway.offSessionStateLookups).toEqual([stuck.id]);
    expect(gateway.offSessionCharges).toHaveLength(1);
    expect(gateway.offSessionCharges[0]!.purchaseId).toBe(stuck.id);
    // The replay is only safe if it is IDENTICAL to the original request: if the original never reached Stripe
    // (the timeout / 503 that sent this row down this path) the replay IS the charge. Field by field, against
    // the original attempt (which failed before Stripe recorded it) and against absolute values.
    expect(gateway.offSessionAttempts).toHaveLength(2);
    const [original, replay] = gateway.offSessionAttempts as [OffSessionPaymentInput, OffSessionPaymentInput];
    expect(Object.keys(replay).sort()).toEqual(Object.keys(original).sort());
    for (const field of Object.keys(original) as Array<keyof OffSessionPaymentInput>) expect(replay[field], `replay.${field}`).toBe(original[field]);
    expect(replay).toMatchObject({ unitAmountCents: 1500, currency: "USD", customerId: "cus_saved_1", paymentMethodId: "pm_saved_1", packKey: "starter_vault", workspaceId });
    expect(replay.productName).toBe(original.productName);
    const purchases = await autoPurchases(workspaceId);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({ id: stuck.id, status: "pending" });
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(1);
    expect(await audit(workspaceId, "billing.auto_topup.pending_expired")).toEqual([]);
    expect(email.sent.filter((m) => m.subject === "Nominara auto top-up triggered")).toHaveLength(1);
  });

  it("NEW-D-7 checkpoint-3 F2 · when the replay of the same purchase comes back declined it takes the decline path (disabled, notified, failed), still with no second purchase", async () => {
    const { workspaceId, stuck } = await stuckPending();
    gateway.offSessionOutcome = "declined";
    expect(await service.trigger(workspaceId)).toBe("declined");
    expect(gateway.offSessionCharges.map((c) => c.purchaseId)).toEqual([stuck.id]);
    expect(await wallet(workspaceId)).toMatchObject({ auto_topup_enabled: false, auto_topup_count_cycle: 1 });
    const purchases = await autoPurchases(workspaceId);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({ id: stuck.id, status: "failed" });
    expect(email.sent.map((m) => m.subject)).toContain("Nominara auto top-up disabled after a failed payment");
  });

  it("NEW-D-7 checkpoint-3 F2 · when the replay itself cannot be answered the purchase stays pending: nothing expired, no second charge, no slot taken", async () => {
    const { workspaceId, stuck } = await stuckPending();
    gateway.failChargeWith = new StripeUpstreamError(503);
    expect(await service.trigger(workspaceId)).toBe("upstream_error");
    gateway.failChargeWith = undefined;
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect(await autoPurchases(workspaceId)).toEqual([expect.objectContaining({ id: stuck.id, status: "pending" })]);
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(1);
  });

  /** A later manual pack purchase: Checkout (`customer_creation: "always"`) leaves a NEW customer and payment method. */
  async function manualPurchaseWithNewCard(workspaceId: string) {
    const pi = `pi_ref2_${workspaceId}`;
    await harness.db().query(
      `INSERT INTO credit_purchases (workspace_id, pack_key, credits, amount_usd, source, status, stripe_payment_intent_id, expires_at)
       VALUES ($1,'starter_vault',1000,15.00,'manual','succeeded',$2, now() + interval '12 months')`,
      [workspaceId, pi],
    );
    gateway.savedMethods.set(pi, { customerId: "cus_saved_2", paymentMethodId: "pm_saved_2" });
  }

  it("NEW-D-7 checkpoint-4 F2b · the original reached Stripe (reply lost) and a manual purchase since then changed the saved card: Stripe refuses the replay (idempotency_error 400) and that is ALERTED NOW as unreconcilable, not logged as a generic upstream_error until the 23 h alert", async () => {
    const { workspaceId, stuck } = await stuckPending(61, "reached");
    await manualPurchaseWithNewCard(workspaceId);
    const alert = vi.spyOn(Logger.prototype, "error");
    expect(await service.trigger(workspaceId)).toBe("in_flight");
    expect(gateway.offSessionAttempts).toHaveLength(2);
    expect(gateway.offSessionAttempts[1]).toMatchObject({ customerId: "cus_saved_2" });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("ALERT"), workspace_id: workspaceId, purchase_id: stuck.id, reason: "replay_rejected" }));
    alert.mockRestore();
    const metrics = log.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((c) => typeof c === "object" && typeof c?.metric === "string");
    expect(metrics).toContainEqual({ metric: "nominara_billing_auto_topup_stale_unreconcilable_total", value: 1, reason: "replay_rejected" });
    // Fails closed: the row stays pending (the in-flight guard stays closed), no slot, no second purchase, nothing disabled.
    expect(await autoPurchases(workspaceId)).toEqual([expect.objectContaining({ id: stuck.id, status: "pending" })]);
    expect(await wallet(workspaceId)).toMatchObject({ auto_topup_enabled: true, auto_topup_count_cycle: 1 });
    expect(gateway.offSessionCharges).toHaveLength(0);
  });

  it("NEW-D-7 checkpoint-4 F2b · the original never reached Stripe and the saved card changed since: the replay is the first request Stripe sees, so it charges the CURRENT card for the original amount, once", async () => {
    const { workspaceId, stuck } = await stuckPending();
    await manualPurchaseWithNewCard(workspaceId);
    expect(await service.trigger(workspaceId)).toBe("charge_submitted");
    expect(gateway.offSessionCharges).toHaveLength(1);
    expect(gateway.offSessionCharges[0]).toMatchObject({ purchaseId: stuck.id, unitAmountCents: 1500, currency: "USD", customerId: "cus_saved_2", paymentMethodId: "pm_saved_2" });
    expect(await autoPurchases(workspaceId)).toEqual([expect.objectContaining({ id: stuck.id, status: "pending" })]);
  });

  it("NEW-D-7 checkpoint-4 F2b · the original reached Stripe (reply lost) and nothing changed: the replay is identical, Stripe answers from the first request, one charge", async () => {
    const { workspaceId, stuck } = await stuckPending(61, "reached");
    expect(await service.trigger(workspaceId)).toBe("charge_submitted");
    expect(gateway.offSessionAttempts).toHaveLength(2);
    expect(gateway.offSessionAttempts[1]).toEqual(gateway.offSessionAttempts[0]);
    expect(gateway.offSessionCharges.map((c) => c.purchaseId)).toEqual([stuck.id]);
  });

  it("NEW-D-7 checkpoint-4 F2a · the fake refuses a reused key whose parameters differ, like Stripe (idempotency_error 400), and answers an identical one", async () => {
    const base: OffSessionPaymentInput = { workspaceId: "w", purchaseId: "p1", packKey: "k", productName: "n", unitAmountCents: 1500, currency: "USD", customerId: "c", paymentMethodId: "m" };
    await expect(gateway.createOffSessionPayment(base)).resolves.toMatchObject({ outcome: "submitted" });
    await expect(gateway.createOffSessionPayment({ ...base })).resolves.toMatchObject({ outcome: "submitted" });
    for (const changed of [{ unitAmountCents: 1600 }, { currency: "EUR" }, { customerId: "c2" }, { paymentMethodId: "m2" }, { productName: "x" }, { packKey: "k2" }, { workspaceId: "w2" }]) {
      await expect(gateway.createOffSessionPayment({ ...base, ...changed })).rejects.toMatchObject({ name: "StripeUpstreamError", statusCode: 400 });
    }
  });

  it("NEW-D-7 checkpoint-3 F2 · past Stripe's idempotency-key retention a replay would be a NEW charge, so it fails closed: stays pending, no charge, no lookup-driven expiry", async () => {
    const { workspaceId, stuck } = await stuckPending(25 * 60);
    const alert = vi.spyOn(Logger.prototype, "error");
    expect(await service.trigger(workspaceId)).toBe("in_flight");
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: workspaceId, purchase_id: stuck.id, reason: "past_idempotency_retention" }));
    alert.mockRestore();
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect(await autoPurchases(workspaceId)).toEqual([expect.objectContaining({ id: stuck.id, status: "pending" })]);
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(1);
    expect(await audit(workspaceId, "billing.auto_topup.pending_expired")).toEqual([]);
  });

  it("NEW-D-7 audit F6 · when Stripe cannot be asked about a stale pending purchase it stays pending: nothing expired, nothing charged, no slot taken", async () => {
    const { workspaceId, stuck } = await stuckPending();
    gateway.failStateLookupWith = new StripeUpstreamError(503);
    expect(await service.trigger(workspaceId)).toBe("upstream_error");
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect(email.sent.filter((m) => m.subject === "Nominara auto top-up triggered")).toHaveLength(1);
    expect((await autoPurchases(workspaceId))[0]).toMatchObject({ id: stuck.id, status: "pending" });
    expect((await wallet(workspaceId))?.auto_topup_count_cycle).toBe(1);
    expect(await audit(workspaceId, "billing.auto_topup.pending_expired")).toEqual([]);
  });

  it("NEW-D-7 audit F6 · KAD-06: the SERVICE opens no transaction of its own across the Stripe lookup for a stale purchase (called directly; production reaches it through the job processor, see the checkpoint-4 KAD-06 test below)", async () => {
    const { workspaceId } = await stuckPending();
    let open = -1;
    const original = gateway.findOffSessionPayment.bind(gateway);
    gateway.findOffSessionPayment = async (id: string) => {
      open = Number((await harness.db().query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'")).rows[0].n);
      return original(id);
    };
    try {
      await service.trigger(workspaceId);
    } finally {
      gateway.findOffSessionPayment = original;
    }
    expect(open).toBe(0);
  });

  // KAD-06 through the PRODUCTION entry: createJobProcessor -> withTenantJob -> BEGIN + set_config -> the handler -> trigger.
  // The processor passes every tenant handler a transaction and holds it (idle, having run only set_config) until the handler
  // returns, i.e. across every Stripe and mail await. OPEN DECISION (docs/plans/evidence/NEW-D-7.md, "Checkpoint-4 fix pass"):
  // either an ADR adds a processor mode that verifies the signature and runs the handler without holding the job
  // transaction, or a bounded written exception is recorded in coding-standards/KAD-06. `it.fails` pins today's fact so the
  // suite stays green AND flips to a failure the moment the fix lands (then change it to `it`); it does not weaken the assertion.
  it.fails("NEW-D-7 checkpoint-4 F7 · KAD-06: through createJobProcessor, no job transaction is open while the Stripe lookup is awaited", async () => {
    const { workspaceId } = await armed();
    const key = Buffer.from("kad06-processor-test-key");
    const run = createJobProcessor(topologyFor("billing.auto_topup"), {
      keys: { current: { kid: "k1", key } },
      getClient: () => pool.connect(),
      releaseClient: (client) => (client as PoolClient).release(),
      process: createBillingAutoTopupHandler({ pool, env: {} as never }, { service }),
    });
    let open = -1;
    const original = gateway.findSavedPaymentMethod.bind(gateway);
    gateway.findSavedPaymentMethod = async (ref: string) => {
      open = Number((await harness.db().query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'")).rows[0].n);
      return original(ref);
    };
    try {
      await run({ data: signQueueJobPayload({ workspaceId, kid: "k1" }, key) } as unknown as Job);
    } finally {
      gateway.findSavedPaymentMethod = original;
    }
    expect(gateway.savedMethodLookups).toHaveLength(1); // the probe ran inside the real flow
    expect(open).toBe(0);
  });

  it("NEW-D-7 audit F6 · a stale purchase that settles between the Stripe lookup and the claim is not failed over (the webhook wins): it stays succeeded and no expiry is audited", async () => {
    const { workspaceId, stuck } = await stuckPending();
    // Stripe says `none`; the late success webhook then lands before the claim: the row is succeeded, not pending.
    const original = gateway.findOffSessionPayment.bind(gateway);
    gateway.findOffSessionPayment = async (id: string) => {
      const state = await original(id);
      await harness.db().query("UPDATE credit_purchases SET status = 'succeeded' WHERE id = $1", [id]);
      return state;
    };
    try {
      await service.trigger(workspaceId);
    } finally {
      gateway.findOffSessionPayment = original;
    }
    expect((await autoPurchases(workspaceId)).find((p) => p.id === stuck.id)).toMatchObject({ status: "succeeded" });
    expect(await audit(workspaceId, "billing.auto_topup.pending_expired")).toEqual([]);
  });

  it("NEW-D-7 audit F6 · a pending purchase younger than an hour still blocks (in_flight): the sweep never reopens a live charge", async () => {
    const { workspaceId } = await armed({ max: 5 });
    expect(await service.trigger(workspaceId)).toBe("charge_submitted");
    const live = (await autoPurchases(workspaceId))[0]!;
    await harness.db().query("UPDATE credit_purchases SET created_at = now() - interval '59 minutes' WHERE id = $1", [live.id]);
    expect(await service.trigger(workspaceId)).toBe("in_flight");
    expect((await autoPurchases(workspaceId))[0]).toMatchObject({ status: "pending" });
    expect(await audit(workspaceId, "billing.auto_topup.pending_expired")).toEqual([]);
  });

  // ---- AC4: no saved payment method ------------------------------------------------------------

  it("owner decision 4 · the card is saved for off-session use only when the workspace has auto-top-up enabled", async () => {
    const { workspaceId, owner } = await armed();
    const buy = () =>
      harness.app().inject({
        method: "POST",
        url: apiUrl("/billing/credit-packs/starter_vault/purchase"),
        cookies: cookies(owner),
        headers: { [CSRF_HEADER_NAME]: owner.csrfToken, "content-type": "application/json", "idempotency-key": randomUUID() },
        payload: {},
      });
    gateway.packCheckouts.length = 0;
    expect((await buy()).statusCode).toBeLessThan(300);
    expect(gateway.packCheckouts.at(-1)).toMatchObject({ workspaceId, saveCard: true });
    expect((await put(owner, { enabled: false, pack_key: null, threshold: null, max_per_cycle: null })).statusCode).toBe(200);
    expect((await buy()).statusCode).toBeLessThan(300);
    expect(gateway.packCheckouts.at(-1)).toMatchObject({ workspaceId, saveCard: false });
  });

  it("NEW-D-7 AC4 · without a saved payment method the trigger is a no-op that records why: no purchase, no slot, no email, no charge", async () => {
    const { workspaceId } = await armed({ saved: false });
    expect(await service.trigger(workspaceId)).toBe("no_payment_method");
    expect(gateway.offSessionCharges).toHaveLength(0);
    expect(await autoPurchases(workspaceId)).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect(await wallet(workspaceId)).toMatchObject({ auto_topup_enabled: true, auto_topup_count_cycle: 0 });
    expect(await audit(workspaceId, "billing.auto_topup.skipped")).toEqual([
      expect.objectContaining({ resource_type: "credit_wallet", after_state: expect.objectContaining({ reason: "no_payment_method" }) }),
    ]);
  });

  it("NEW-D-7 AC4 · with no completed pack purchase at all there is nothing to look up: no_payment_method without asking Stripe", async () => {
    const { workspaceId } = await armed({ reference: false });
    expect(await service.trigger(workspaceId)).toBe("no_payment_method");
    expect(gateway.savedMethodLookups).toHaveLength(0);
    expect(await audit(workspaceId, "billing.auto_topup.skipped")).toHaveLength(1);
  });

  it("NEW-D-7 AC4 · only a manual purchase can be the reference: an earlier auto-top-up purchase is not a source of a saved card", async () => {
    const { workspaceId } = await armed({ reference: false });
    await harness.db().query(
      `INSERT INTO credit_purchases (workspace_id, pack_key, credits, amount_usd, source, status, stripe_payment_intent_id, expires_at)
       VALUES ($1,'starter_vault',1000,15.00,'auto_topup','succeeded','pi_auto_old', now() + interval '12 months')`,
      [workspaceId],
    );
    gateway.savedMethods.set("pi_auto_old", { customerId: "cus_x", paymentMethodId: "pm_x" });
    expect(await service.trigger(workspaceId)).toBe("no_payment_method");
  });

  // ---- tenancy, audit, observability -----------------------------------------------------------

  it("NEW-D-7 · tenant isolation: triggering one workspace touches no other workspace's wallet, purchases or mail", async () => {
    const a = await armed();
    const b = await armed({ billingEmail: "other-billing@example.com" });
    expect(await service.trigger(a.workspaceId)).toBe("charge_submitted");
    expect(await autoPurchases(b.workspaceId)).toHaveLength(0);
    expect((await wallet(b.workspaceId))?.auto_topup_count_cycle).toBe(0);
    expect(email.sent.every((m) => m.to === BILLING_EMAIL)).toBe(true);
    expect(gateway.offSessionCharges.every((c) => c.workspaceId === a.workspaceId)).toBe(true);
  });

  it("NEW-D-7 · the trigger itself runs as nominara_app (RLS in force): a purchase row it wrote is invisible from another workspace's context", async () => {
    const a = await armed();
    const b = await armed();
    await service.trigger(a.workspaceId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE nominara_app");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [b.workspaceId]);
      const seen = await client.query("SELECT 1 FROM credit_purchases WHERE workspace_id = $1", [a.workspaceId]);
      expect(seen.rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("STORY-076 AC · a trigger writes an audit row naming the purchase", async () => {
    const { workspaceId } = await armed();
    await service.trigger(workspaceId);
    const purchase = (await autoPurchases(workspaceId))[0]!;
    expect(await audit(workspaceId, "billing.auto_topup.triggered")).toEqual([
      expect.objectContaining({ resource_type: "credit_purchase", resource_id: purchase.id, after_state: expect.objectContaining({ pack_key: "starter_vault", credits: 1000 }) }),
    ]);
  });

  it("NEW-D-7 · observability: a trigger emits nominara_billing_auto_topup_trigger_total by outcome, and its log lines carry the workspace id but no address, card or customer id", async () => {
    const { workspaceId } = await armed({ max: 3 });
    await service.trigger(workspaceId);
    await service.trigger(workspaceId);
    const metrics = log.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((c) => typeof c === "object" && typeof c?.metric === "string");
    expect(metrics).toContainEqual({ metric: "nominara_billing_auto_topup_trigger_total", value: 1, outcome: "charge_submitted" });
    expect(metrics).toContainEqual({ metric: "nominara_billing_auto_topup_trigger_total", value: 1, outcome: "in_flight" });
    const emitted = JSON.stringify(log.mock.calls);
    expect(emitted).toContain(workspaceId);
    for (const secret of [BILLING_EMAIL, "cus_saved_1", "pm_saved_1"]) expect(emitted).not.toContain(secret);
  });
});
