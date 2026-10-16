import { isFinishedSchedule } from "../../src/lib/billing/stripe/schedule-phases.js";
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
  type FinishedScheduleInput,
  type PlanChangePreviewInput,
  type PlanChangePreviewResult,
  type PlanDowngradeInput,
  type PlanDowngradeReleaseInput,
  type PlanUpgradeInput,
  type PlanUpgradeResult,
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

  /**
   * EVERY off-session request the service MADE, recorded before any failure is raised: a charge that timed
   * out is still an attempt, and its parameters are what a replay under the same key must repeat.
   */
  readonly offSessionAttempts: OffSessionPaymentInput[] = [];
  /**
   * Models the hazard of a lost reply: Stripe RECEIVED and recorded the request (so its idempotency key is held),
   * and the answer never came back. Unlike `failChargeWith`, where the request never reached Stripe.
   */
  failChargeAfterReaching: Error | undefined;
  /** The first request Stripe saw per idempotency key (`auto-topup-<purchaseId>`), canonicalised. */
  private readonly offSessionByKey = new Map<string, string>();

  /** Back to a clean off-session slate (the instance is shared by a whole spec file). */
  resetOffSession(): void {
    this.offSessionCharges.length = 0;
    this.offSessionAttempts.length = 0;
    this.offSessionByKey.clear();
    this.offSessionOutcome = "submitted";
    this.failChargeWith = undefined;
    this.failChargeAfterReaching = undefined;
  }

  createOffSessionPayment(input: OffSessionPaymentInput): Promise<OffSessionPaymentResult> {
    this.offSessionAttempts.push(input);
    if (this.failChargeWith !== undefined) return Promise.reject(this.failChargeWith);
    // Like Stripe: the same key with DIFFERENT parameters is refused (idempotency_error, HTTP 400); the same
    // key with the same parameters is answered from the first request.
    const key = `auto-topup-${input.purchaseId}`;
    const body = JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))));
    const first = this.offSessionByKey.get(key);
    if (first !== undefined && first !== body) return Promise.reject(new StripeUpstreamError(400));
    this.offSessionByKey.set(key, body);
    if (this.failChargeAfterReaching !== undefined) return Promise.reject(this.failChargeAfterReaching);
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

  /** STORY-021 — customer billing-email re-points, in call order. */
  readonly customerEmailUpdates: Array<{ customerId: string; email: string }> = [];
  updateCustomerBillingEmail(input: { customerId: string; email: string }): Promise<void> {
    if (this.failFetchWith !== undefined) return Promise.reject(this.failFetchWith);
    this.customerEmailUpdates.push(input);
    return Promise.resolve();
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

  /**
   * What Stripe compares when a key is reused: the endpoint (create vs update), the item and the parameters.
   * A reused key whose call differs is refused (400 `idempotency_error`), exactly as `createSubscriptionCheckout`
   * does for checkout. Without this the fake replays ANY repeat of a key, which hid a retry that changed its call.
   */
  private readonly addonFingerprints = new Map<string, string>();
  private static addonFingerprint(input: AddonChangeInput): string {
    const { idempotencyKey: _key, ...call } = input;
    return JSON.stringify(call);
  }

  changeAddonQuantity(input: AddonChangeInput): Promise<void> {
    this.addonAttempts.push(input);
    const fingerprint = FakeStripeGateway.addonFingerprint(input);
    const earlier = this.addonFingerprints.get(input.idempotencyKey);
    if (earlier !== undefined && earlier !== fingerprint) return Promise.reject(new StripeUpstreamError(400, "idempotency_error"));
    this.addonFingerprints.set(input.idempotencyKey, fingerprint);
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

  /** A slow Stripe: how long `scheduleAddonRemoval` takes to answer, in ms (0 = immediately). */
  addonRemovalDelayMs = 0;

  async scheduleAddonRemoval(input: AddonRemovalInput): Promise<void> {
    if (this.addonRemovalDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.addonRemovalDelayMs));
    if (this.failAddonWith !== undefined) throw this.failAddonWith;
    this.addonRemovals.push(input);
  }

  // ---- STORY-184 · the in-app plan change ----------------------------------------------------------------------
  /** Every preview asked for, in call order. */
  readonly planPreviews: PlanChangePreviewInput[] = [];
  /** What Stripe says the upgrade costs: a number, or a function of the preview asked for. */
  previewAmountCents: number | ((input: PlanChangePreviewInput) => number) = 3850;
  /** Every upgrade ATTEMPTED (recorded before any failure is raised) and every one Stripe actually applied. */
  readonly upgradeAttempts: PlanUpgradeInput[] = [];
  readonly upgrades: PlanUpgradeInput[] = [];
  /** `payment_failed` models a declined card or a 3-D Secure requirement: Stripe applies NOTHING. */
  upgradeOutcome: "applied" | "payment_failed" = "applied";
  /** Makes plan-change calls fail like an upstream outage (the request never reached Stripe). */
  failPlanChangeWith: Error | undefined;
  /** Makes ONLY the upgrade call fail (the request never reached Stripe): previews and fetches still work. */
  failUpgradeWith: Error | undefined;
  /** Stripe APPLIES the upgrade and the reply is lost: the stored subscription moves, the call then rejects. */
  failUpgradeAfterApplying: Error | undefined;
  private readonly upgradeFingerprints = new Map<string, string>();
  /** Stripe CREATES the schedule and the reply is lost: the stored subscription now holds a schedule, the call then rejects. */
  failDowngradeAfterApplying: Error | undefined;
  private readonly downgradeKeys = new Map<string, string>();
  readonly downgradeAttempts: PlanDowngradeInput[] = [];
  readonly downgrades: PlanDowngradeInput[] = [];
  readonly releases: PlanDowngradeReleaseInput[] = [];
  releaseOutcome: "released" | "not_releasable" = "released";

  previewPlanChange(input: PlanChangePreviewInput): Promise<PlanChangePreviewResult> {
    if (this.failPlanChangeWith !== undefined) return Promise.reject(this.failPlanChangeWith);
    this.planPreviews.push(input);
    const amountDueCents = typeof this.previewAmountCents === "function" ? this.previewAmountCents(input) : this.previewAmountCents;
    return Promise.resolve({ amountDueCents, currency: input.target.currency.toLowerCase() });
  }

  /** Runs at the instant a plan-change call REACHES Stripe (upgrade or schedule): lets a test look at what was committed by then. */
  beforePlanChangeCall: (() => Promise<void>) | undefined;

  async applyPlanUpgrade(input: PlanUpgradeInput): Promise<PlanUpgradeResult> {
    await this.beforePlanChangeCall?.();
    this.upgradeAttempts.push(input);
    // Like Stripe: a reused key with a DIFFERENT call is refused (idempotency_error); the same call is answered from the first.
    const { idempotencyKey: _key, ...call } = input;
    const fingerprint = JSON.stringify(call);
    const earlier = this.upgradeFingerprints.get(input.idempotencyKey);
    if (earlier !== undefined && earlier !== fingerprint) return Promise.reject(new StripeUpstreamError(400, "idempotency_error"));
    this.upgradeFingerprints.set(input.idempotencyKey, fingerprint);
    if (this.failPlanChangeWith !== undefined) return Promise.reject(this.failPlanChangeWith);
    if (this.failUpgradeWith !== undefined) return Promise.reject(this.failUpgradeWith);
    if (this.upgradeOutcome === "payment_failed") return Promise.resolve({ outcome: "payment_failed" });
    if (!this.upgrades.some((u) => u.idempotencyKey === input.idempotencyKey)) {
      this.upgrades.push(input);
      this.applyUpgradeToObject(input);
    }
    if (this.failUpgradeAfterApplying !== undefined) return Promise.reject(this.failUpgradeAfterApplying);
    return Promise.resolve({ outcome: "applied" });
  }

  /** Moves the stored subscription's PLAN line to the target price and merges the metadata, as Stripe does when it applies the update. */
  private applyUpgradeToObject(input: PlanUpgradeInput): void {
    const stored = this.objects.get(`subscription:${input.subscriptionId}`);
    if (stored === undefined) return;
    const raw = stored.raw as { items?: { data: Array<Record<string, unknown> & { id?: unknown; price?: Record<string, unknown> }> }; metadata?: Record<string, string> };
    const line = raw.items?.data.find((candidate) => candidate.id === input.planItemId);
    if (line !== undefined) {
      line.price = {
        ...(line.price ?? {}),
        unit_amount: input.target.unitAmountCents,
        currency: input.target.currency.toLowerCase(),
        recurring: { interval: input.target.interval, interval_count: 1 },
        product: { metadata: { nominara_kind: "plan" } },
      };
    }
    this.objects.set(`subscription:${input.subscriptionId}`, { ...stored, metadata: { ...stored.metadata, ...input.metadata }, raw: { ...stored.raw, metadata: { ...raw.metadata, ...input.metadata } } });
  }

  /**
   * Modelled schedules (id -> shape Stripe returns), for the flows that need the REAL `isFinishedSchedule` predicate to run: a
   * schedule created by `from_subscription` has ONE phase until the downgrade's update gives it a second.
   */
  readonly schedules = new Map<string, { status: string; end_behavior: string; phases: Array<{ start_date: number; metadata: Record<string, string> }>; current_phase: { start_date: number } | null }>();
  /** Does `from_subscription` copy the subscription's metadata onto the new schedule's phase? (Unknown at Stripe; the checklist asks.) */
  fromSubscriptionCopiesMetadata = true;
  /** Stripe CREATES the schedule (one phase) and the reply is lost before the update: the retry must COMPLETE it. */
  failDowngradeBetweenCreateAndUpdate: Error | undefined;
  /** Schedules the downgrade replaced because it found a finished one attached (should stay empty for a replay). */
  readonly replacedSchedules: string[] = [];
  private scheduleSeq = 0;

  async schedulePlanDowngrade(input: PlanDowngradeInput): Promise<{ readonly scheduleId: string }> {
    await this.beforePlanChangeCall?.();
    this.downgradeAttempts.push(input);
    if (this.failPlanChangeWith !== undefined) return Promise.reject(this.failPlanChangeWith);
    const subKey = `subscription:${input.subscriptionId}`;
    const attach = (id: string | null): void => {
      const stored = this.objects.get(subKey);
      if (stored !== undefined) this.objects.set(subKey, { ...stored, raw: { ...stored.raw, schedule: id } });
    };

    // The modelled path (like the real gateway's scheduleIdOf): reuse an attached schedule unless it is FINISHED.
    const modelled = this.failDowngradeBetweenCreateAndUpdate !== undefined || [...this.schedules.keys()].length > 0;
    if (modelled && !this.downgradeKeys.has(input.idempotencyKey)) {
      const stored = this.objects.get(subKey);
      const planKey = stored?.metadata.plan_key;
      const attached = (stored?.raw as { schedule?: unknown } | undefined)?.schedule;
      let id: string | null = typeof attached === "string" ? attached : null;
      let existing = id === null ? undefined : this.schedules.get(id);
      if (id !== null && existing !== undefined && isFinishedSchedule(existing, planKey)) {
        this.replacedSchedules.push(id);
        existing = undefined;
        id = null;
      }
      if (existing === undefined || id === null) {
        id = `sub_sched_m${String(++this.scheduleSeq)}`;
        this.schedules.set(id, {
          status: "active",
          end_behavior: "release",
          phases: [{ start_date: 1, metadata: this.fromSubscriptionCopiesMetadata ? { ...(stored?.metadata ?? {}) } : {} }],
          current_phase: { start_date: 1 },
        });
        attach(id);
        if (this.failDowngradeBetweenCreateAndUpdate !== undefined) return Promise.reject(this.failDowngradeBetweenCreateAndUpdate);
      }
      // the update: the schedule gets its second phase
      const schedule = this.schedules.get(id)!;
      schedule.phases = [schedule.phases[0]!, { start_date: 2, metadata: { ...input.metadata } }];
      this.downgrades.push(input);
      this.downgradeKeys.set(input.idempotencyKey, id);
      return Promise.resolve({ scheduleId: id });
    }

    // Like Stripe: the same key answers from the first call and applies nothing twice.
    let scheduleId = this.downgradeKeys.get(input.idempotencyKey);
    if (scheduleId === undefined) {
      this.downgrades.push(input);
      scheduleId = `sub_sched_${String(this.downgrades.length)}`;
      this.downgradeKeys.set(input.idempotencyKey, scheduleId);
      if (this.failDowngradeAfterApplying !== undefined) attach(scheduleId);
    }
    if (this.failDowngradeAfterApplying !== undefined) return Promise.reject(this.failDowngradeAfterApplying);
    return Promise.resolve({ scheduleId });
  }

  /** Schedule ids the fake treats as released already (so a repeat release is `not_releasable`, like Stripe's). */
  private readonly releasedScheduleIds = new Set<string>();
  /** Runs when a release is APPLIED, before the call answers: lets a test move Stripe on at that instant (the boundary race). */
  onReleaseApplied: (() => void) | undefined;
  /** Stripe APPLIES the release and the reply is lost. */
  failReleaseAfterApplying: Error | undefined;

  releasePlanDowngrade(input: PlanDowngradeReleaseInput): Promise<{ readonly outcome: "released" | "not_releasable" }> {
    if (this.failPlanChangeWith !== undefined) return Promise.reject(this.failPlanChangeWith);
    this.releases.push(input);
    if (this.releaseOutcome === "not_releasable" || this.releasedScheduleIds.has(input.scheduleId)) return Promise.resolve({ outcome: "not_releasable" });
    this.releasedScheduleIds.add(input.scheduleId);
    // Releasing detaches the schedule from the stored subscription.
    for (const [key, stored] of this.objects) {
      if (key.startsWith("subscription:") && (stored.raw as { schedule?: unknown }).schedule === input.scheduleId) {
        this.objects.set(key, { ...stored, raw: { ...stored.raw, schedule: null } });
      }
    }
    this.onReleaseApplied?.();
    if (this.failReleaseAfterApplying !== undefined) return Promise.reject(this.failReleaseAfterApplying);
    return Promise.resolve({ outcome: "released" });
  }

  /** Ids of schedules that have nothing left to do (a downgrade that took effect), for `releaseFinishedSchedule`. */
  readonly finishedScheduleIds = new Set<string>();
  readonly finishedReleases: FinishedScheduleInput[] = [];

  releaseFinishedSchedule(input: FinishedScheduleInput): Promise<{ readonly released: boolean; readonly finished?: boolean }> {
    if (this.failPlanChangeWith !== undefined) return Promise.reject(this.failPlanChangeWith);
    const key = `subscription:${input.subscriptionId}`;
    const stored = this.objects.get(key);
    const scheduleId = (stored?.raw as { schedule?: unknown } | undefined)?.schedule;
    if (stored === undefined || typeof scheduleId !== "string") return Promise.resolve({ released: false });
    const modelled = this.schedules.get(scheduleId);
    // The REAL predicate runs on a modelled schedule; a bare id in `finishedScheduleIds` is the shortcut the cut-over tests use.
    const finished = modelled !== undefined ? isFinishedSchedule(modelled, input.expectedPlanKey) : this.finishedScheduleIds.has(scheduleId);
    if (!finished) return Promise.resolve({ released: false, finished: false });
    if (input.dryRun === true) return Promise.resolve({ released: false, finished: true });
    this.finishedReleases.push(input);
    this.objects.set(key, { ...stored, raw: { ...stored.raw, schedule: null } });
    return Promise.resolve({ released: true });
  }

  /** Back to a clean slate between tests (the instance is shared by a whole spec file). */
  reset(): void {
    this.planPreviews.length = 0;
    this.previewAmountCents = 3850;
    this.upgradeAttempts.length = 0;
    this.upgrades.length = 0;
    this.upgradeOutcome = "applied";
    this.failPlanChangeWith = undefined;
    this.failUpgradeAfterApplying = undefined;
    this.failUpgradeWith = undefined;
    this.failDowngradeAfterApplying = undefined;
    this.failDowngradeBetweenCreateAndUpdate = undefined;
    this.schedules.clear();
    this.replacedSchedules.length = 0;
    this.fromSubscriptionCopiesMetadata = true;
    this.downgradeKeys.clear();
    this.beforePlanChangeCall = undefined;
    this.upgradeFingerprints.clear();
    this.downgradeAttempts.length = 0;
    this.downgrades.length = 0;
    this.releases.length = 0;
    this.releaseOutcome = "released";
    this.releasedScheduleIds.clear();
    this.onReleaseApplied = undefined;
    this.failReleaseAfterApplying = undefined;
    this.finishedScheduleIds.clear();
    this.finishedReleases.length = 0;
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
    this.addonRemovalDelayMs = 0;
    this.failAfterApplyingAddon = undefined;
    this.appliedAddonKeys.clear();
    this.addonFingerprints.clear();
    this.resetOffSession();
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
