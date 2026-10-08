import { createHmac, timingSafeEqual } from "node:crypto";
import {
  StripeSignatureError,
  StripeUpstreamError,
  type FetchedStripeObject,
  type StripeGateway,
  type AddonChangeInput,
  type AddonRemovalInput,
  type CreditPackCheckoutInput,
  type HostedSession,
  type OffSessionPaymentInput,
  type OffSessionPaymentResult,
  type OffSessionPaymentState,
  type SavedPaymentMethod,
  type StripeObjectKind,
  type SubscriptionCheckoutInput,
  type VerifiedStripeEvent,
} from "../../src/lib/billing/stripe/stripe-gateway.js";

// NEW-D-2 — the fake bound in every unit and integration test. It implements
// Stripe's real signing scheme (`t=<ts>,v1=HMAC_SHA256(secret, "<ts>.<body>")`,
// 300 s tolerance) so the route is tested against bytes that were really
// signed, but it never opens a socket: NO TEST CALLS THE REAL STRIPE API.

export const FAKE_WEBHOOK_SECRET = "whsec_fake_for_tests_only";

export function signFakeStripePayload(body: string, secret = FAKE_WEBHOOK_SECRET, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

export class FakeStripeGateway implements StripeGateway {
  /** What `fetchObject` answers, keyed `${kind}:${id}`. A missing key means "Stripe has no such object". */
  readonly objects = new Map<string, FetchedStripeObject>();
  readonly fetches: string[] = [];
  configured = true;
  /** Set to make the next fetch fail like an upstream outage. */
  failFetchWith: Error | undefined;

  constructor(private readonly secret = FAKE_WEBHOOK_SECRET, private readonly now: () => number = () => Date.now()) {}

  putObject(kind: StripeObjectKind, id: string, metadata: Record<string, string>, raw: Record<string, unknown> = {}): void {
    this.objects.set(`${kind}:${id}`, { kind, id, metadata, raw: { id, ...raw } });
  }

  isConfigured(): boolean {
    return this.configured;
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): VerifiedStripeEvent {
    if (signatureHeader === undefined) throw new StripeSignatureError();
    const parts = Object.fromEntries(signatureHeader.split(",").map((p) => p.split("=", 2) as [string, string]));
    const t = Number(parts.t);
    const v1 = parts.v1;
    if (!Number.isFinite(t) || typeof v1 !== "string") throw new StripeSignatureError();
    const expected = createHmac("sha256", this.secret).update(`${t}.${rawBody.toString("utf8")}`).digest();
    const given = Buffer.from(v1, "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new StripeSignatureError();
    if (Math.abs(this.now() / 1000 - t) > 300) throw new StripeSignatureError();
    const event = JSON.parse(rawBody.toString("utf8")) as { id: string; type: string; data: { object: { id: string } } };
    return { id: event.id, type: event.type, objectId: event.data.object.id };
  }

  readonly checkouts: SubscriptionCheckoutInput[] = [];
  readonly portals: Array<{ customerId: string; returnUrl: string }> = [];
  /** Session ids closed through `closeCheckoutSession`, in call order. */
  readonly expired: string[] = [];
  /** Sessions Stripe reports as already paid, with whether their subscription is still live. */
  readonly completedSessions = new Map<string, { subscriptionLive: boolean }>();

  closeCheckoutSession(sessionId: string): Promise<{ status: "expired" } | { status: "complete"; subscriptionLive: boolean }> {
    if (this.failFetchWith !== undefined) return Promise.reject(this.failFetchWith);
    const completed = this.completedSessions.get(sessionId);
    if (completed !== undefined) return Promise.resolve({ status: "complete", subscriptionLive: completed.subscriptionLive });
    this.expired.push(sessionId);
    return Promise.resolve({ status: "expired" });
  }

  /**
   * NEW-D-2 audit — runs AFTER Stripe created a session and BEFORE the call
   * returns to the API: the instant a crash (a killed pod, a dropped database
   * connection) strands a payable session the API never recorded.
   */
  onSessionCreated: (() => Promise<void>) | undefined;
  /** Sessions by Idempotency-Key, like Stripe: the same key returns the SAME session and creates nothing. */
  private readonly sessionsByKey = new Map<string, { session: HostedSession; body: string }>();

  async createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<HostedSession> {
    if (this.failFetchWith !== undefined) throw this.failFetchWith;
    if (input.idempotencyKey !== undefined) {
      const replay = this.sessionsByKey.get(input.idempotencyKey);
      // Stripe refuses a reused key whose parameters differ (idempotency_error, 400).
      if (replay !== undefined) {
        if (replay.body !== JSON.stringify(input)) throw new StripeUpstreamError(400);
        return replay.session;
      }
    }
    this.checkouts.push(input);
    const session = { id: `cs_test_${String(this.checkouts.length)}`, url: `https://checkout.stripe.test/c/pay/cs_test_${String(this.checkouts.length)}` };
    if (input.idempotencyKey !== undefined) this.sessionsByKey.set(input.idempotencyKey, { session, body: JSON.stringify(input) });
    await this.onSessionCreated?.();
    return session;
  }

  /** STORY-076a — credit-pack Checkout sessions created, in call order. */
  readonly packCheckouts: CreditPackCheckoutInput[] = [];

  async createCreditPackCheckout(input: CreditPackCheckoutInput): Promise<HostedSession> {
    if (this.failFetchWith !== undefined) throw this.failFetchWith;
    this.packCheckouts.push(input);
    const session = { id: `cs_pack_${String(this.packCheckouts.length)}`, url: `https://checkout.stripe.test/c/pay/cs_pack_${String(this.packCheckouts.length)}` };
    await this.onSessionCreated?.();
    return session;
  }

  /** NEW-D-7 — payment methods Stripe holds for a reference PaymentIntent (one saved with setup_future_usage). */
  readonly savedMethods = new Map<string, SavedPaymentMethod>();
  readonly savedMethodLookups: string[] = [];
  /** NEW-D-7 — off-session charges submitted, in call order. */
  readonly offSessionCharges: OffSessionPaymentInput[] = [];
  /** `declined` makes the next charges come back as a card decline. */
  offSessionOutcome: "submitted" | "declined" = "submitted";
  /** Makes only the charge (not the lookup) fail like an upstream outage. */
  failChargeWith: Error | undefined;

  /**
   * The lookups sit between the trigger's read-only PLAN and its CLAIM. Holding
   * them open lets a test interleave two triggers that both planned against the
   * same state. Returns `release` (also stops holding later lookups).
   */
  private lookupGate: Promise<void> | undefined;
  holdLookups(): () => void {
    let release!: () => void;
    this.lookupGate = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.lookupGate = undefined;
      release();
    };
  }
  /** Stops holding NEW lookups without releasing the ones already held. */
  stopHoldingNewLookups(): void {
    this.lookupGate = undefined;
  }

  async findSavedPaymentMethod(referencePaymentIntentId: string): Promise<SavedPaymentMethod | null> {
    if (this.failFetchWith !== undefined) throw this.failFetchWith;
    this.savedMethodLookups.push(referencePaymentIntentId);
    const gate = this.lookupGate;
    if (gate !== undefined) await gate;
    return this.savedMethods.get(referencePaymentIntentId) ?? null;
  }

  createOffSessionPayment(input: OffSessionPaymentInput): Promise<OffSessionPaymentResult> {
    if (this.failChargeWith !== undefined) return Promise.reject(this.failChargeWith);
    this.offSessionCharges.push(input);
    if (this.offSessionOutcome === "declined") return Promise.resolve({ outcome: "declined" });
    return Promise.resolve({ outcome: "submitted", paymentIntentId: `pi_auto_${input.purchaseId.slice(0, 8)}` });
  }

  /** What Stripe holds per purchase id; a missing key is `none`. A test sets it to model a charge the trigger never saw answered. */
  readonly offSessionStates = new Map<string, OffSessionPaymentState>();
  readonly offSessionStateLookups: string[] = [];
  /** Makes only the by-purchase lookup fail like an upstream outage. */
  failStateLookupWith: Error | undefined;

  findOffSessionPayment(purchaseId: string): Promise<OffSessionPaymentState> {
    if (this.failStateLookupWith !== undefined) return Promise.reject(this.failStateLookupWith);
    this.offSessionStateLookups.push(purchaseId);
    return Promise.resolve(this.offSessionStates.get(purchaseId) ?? "none");
  }

  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    if (this.failFetchWith !== undefined) return Promise.reject(this.failFetchWith);
    this.portals.push(input);
    return Promise.resolve({ url: `https://billing.stripe.test/p/session_${input.customerId}` });
  }

  /** STORY-076b — add-on quantity changes and scheduled removals sent to Stripe, in call order. */
  readonly addonChanges: AddonChangeInput[] = [];
  readonly addonRemovals: AddonRemovalInput[] = [];
  /** Set to make the next add-on call fail like an upstream outage. */
  failAddonWith: Error | undefined;

  /** Every change ATTEMPTED, recorded before a failure is raised: a timed-out call that Stripe may still apply is still an attempt. */
  readonly addonAttempts: AddonChangeInput[] = [];

  /**
   * STORY-076b checkpoint-3 — set to model the hazard the audit named: Stripe APPLIES the change
   * to the subscription (the fetched state moves) and the reply is then lost. Honours Stripe's own
   * idempotency: a key it has already applied is replayed, not applied twice.
   */
  failAfterApplyingAddon: Error | undefined;
  private readonly appliedAddonKeys = new Set<string>();

  changeAddonQuantity(input: AddonChangeInput): Promise<void> {
    this.addonAttempts.push(input);
    if (this.failAfterApplyingAddon !== undefined) {
      if (!this.appliedAddonKeys.has(input.idempotencyKey)) {
        this.appliedAddonKeys.add(input.idempotencyKey);
        this.addonChanges.push(input);
        this.applyAddonToObject(input);
      }
      return Promise.reject(this.failAfterApplyingAddon);
    }
    if (this.failAddonWith !== undefined) return Promise.reject(this.failAddonWith);
    // Stripe replays the stored answer for a repeated idempotency key instead of applying the change again.
    if (this.appliedAddonKeys.has(input.idempotencyKey)) return Promise.resolve();
    this.appliedAddonKeys.add(input.idempotencyKey);
    this.addonChanges.push(input);
    return Promise.resolve();
  }

  /** Moves the stored subscription's add-on line to `input.quantity`, as Stripe does when it applies the change. */
  private applyAddonToObject(input: AddonChangeInput): void {
    const raw = this.objects.get(`subscription:${input.subscriptionId}`)?.raw as { items: { data: Array<Record<string, unknown>> } } | undefined;
    if (raw === undefined) return;
    const existing = raw.items.data.find((line) => line.id === input.existingItemId);
    if (existing !== undefined) {
      existing.quantity = input.quantity;
      return;
    }
    raw.items.data.push({
      id: `si_${input.kind}`,
      quantity: input.quantity,
      price: { id: `price_${input.kind}`, unit_amount: input.unitAmountCents, currency: input.currency, recurring: { interval: input.interval }, product: { metadata: { nominara_kind: input.kind } } },
    });
  }

  scheduleAddonRemoval(input: AddonRemovalInput): Promise<void> {
    if (this.failAddonWith !== undefined) return Promise.reject(this.failAddonWith);
    this.addonRemovals.push(input);
    return Promise.resolve();
  }

  /** Back to a clean slate between tests (the instance is shared by a whole spec file). */
  reset(): void {
    this.objects.clear();
    this.fetches.length = 0;
    this.checkouts.length = 0;
    this.portals.length = 0;
    this.expired.length = 0;
    this.completedSessions.clear();
    this.packCheckouts.length = 0;
    this.addonChanges.length = 0;
    this.addonAttempts.length = 0;
    this.addonRemovals.length = 0;
    this.configured = true;
    this.failFetchWith = undefined;
    this.failAddonWith = undefined;
    this.failAfterApplyingAddon = undefined;
    this.appliedAddonKeys.clear();
    this.onSessionCreated = undefined;
  }

  /** Fetches held open by `holdNextFetch`, keyed `${kind}:${id}`. */
  private readonly held = new Map<string, Promise<void>>();

  /**
   * Makes the NEXT fetch of this object snapshot Stripe's state now and then wait
   * for the returned release — the interleaving a stale fetch needs: the answer is
   * old by the time it is used. Returns `release`.
   */
  holdNextFetch(kind: StripeObjectKind, objectId: string): () => void {
    let release!: () => void;
    this.held.set(`${kind}:${objectId}`, new Promise<void>((resolve) => (release = resolve)));
    return release;
  }

  async fetchObject(kind: StripeObjectKind, objectId: string): Promise<FetchedStripeObject | null> {
    const key = `${kind}:${objectId}`;
    this.fetches.push(key);
    if (this.failFetchWith !== undefined) throw this.failFetchWith;
    const snapshot = this.objects.get(key) ?? null;
    const hold = this.held.get(key);
    if (hold !== undefined) {
      this.held.delete(key);
      await hold;
    }
    return snapshot;
  }
}
