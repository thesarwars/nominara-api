import Stripe from "stripe";
import {
  STRIPE_ERROR_TYPES,
  StripeSignatureError,
  StripeUpstreamError,
  type AddonChangeInput,
  type AddonRemovalInput,
  type ClosedCheckoutSession,
  type CreditPackCheckoutInput,
  type FetchedStripeObject,
  type HostedSession,
  type OffSessionPaymentInput,
  type OffSessionPaymentState,
  type OffSessionPaymentResult,
  type PlanChangePreviewInput,
  type PlanChangePreviewResult,
  type PlanDowngradeInput,
  type PlanDowngradeReleaseInput,
  type PlanPrice,
  type PlanUpgradeInput,
  type PlanUpgradeResult,
  type SavedPaymentMethod,
  type StripeGateway,
  type StripeObjectKind,
  type SubscriptionCheckoutInput,
  type VerifiedStripeEvent,
} from "./stripe-gateway.js";
import { buildTwoPhaseSchedule, phaseLinesOf, stringMetadataOf, type PhaseItem, type PhaseLine } from "./schedule-phases.js";

// NEW-D-2 — the real adapter, over the official `stripe` SDK. The only file
// that holds `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`.
//
// ⚠ NOTHING THIS CLASS THROWS OR LOGS CONTAINS EITHER SECRET. SDK errors are
// caught and re-thrown as `StripeSignatureError` / `StripeUpstreamError`, which
// carry a status code and nothing else: the SDK's own messages can echo the
// header or the (partial) key. stripe-gateway.spec.ts asserts it.

/** Seconds a signed timestamp may differ from now. Stripe's own default, stated so a change is a diff. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface StripeHttpGatewayConfig {
  readonly secretKey: string | undefined;
  readonly webhookSecret: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PaymentIntent statuses that took no money and will not: the charge was refused, abandoned or cancelled. */
const DEAD_INTENT_STATUSES: ReadonlySet<string> = new Set(["requires_payment_method", "requires_action", "canceled"]);

function stringMetadata(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === "string") out[key] = entry;
    }
  }
  return out;
}

export class StripeHttpGateway implements StripeGateway {
  private readonly client: Stripe | undefined;
  private readonly webhookSecret: string | undefined;

  constructor(config: StripeHttpGatewayConfig) {
    this.webhookSecret = config.webhookSecret;
    // maxNetworkRetries: 0 — the webhook handler's own at-least-once redelivery
    // is the retry; a hidden SDK retry loop inside a request would stack on it.
    this.client = config.secretKey === undefined ? undefined : new Stripe(config.secretKey, { maxNetworkRetries: 0, timeout: 10_000 });
  }

  isConfigured(): boolean {
    return this.client !== undefined && this.webhookSecret !== undefined;
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): VerifiedStripeEvent {
    if (this.webhookSecret === undefined || signatureHeader === undefined || signatureHeader.length === 0) {
      throw new StripeSignatureError();
    }
    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret, WEBHOOK_TOLERANCE_SECONDS);
    } catch {
      throw new StripeSignatureError();
    }
    const object = event.data?.object as { id?: unknown } | undefined;
    if (typeof event.id !== "string" || typeof event.type !== "string" || typeof object?.id !== "string") {
      throw new StripeSignatureError();
    }
    return { id: event.id, type: event.type, objectId: object.id };
  }

  async createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<HostedSession> {
    const client = this.requireClient();
    try {
      const session = await client.checkout.sessions.create({
        mode: "subscription",
        client_reference_id: input.workspaceId,
        ...(input.customerId === undefined ? {} : { customer: input.customerId }),
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.unitAmountCents,
              recurring: { interval: input.billingInterval === "annual" ? "year" : "month" },
              // `nominara_kind` is how the reconciler tells the plan item from
              // an add-on item on the fetched subscription (STORY-076b).
              product_data: { name: input.productName, metadata: { nominara_kind: "plan" } },
            },
          },
        ],
        // The workspace is found from THIS metadata on the re-fetched
        // subscription — never from an event payload.
        subscription_data: {
          metadata: {
            workspace_id: input.workspaceId,
            plan_key: input.planKey,
            billing_interval: input.billingInterval,
            // The lookup key for the price frozen at checkout (not authority).
            checkout_intent_id: input.intentId,
          },
        },
        metadata: { workspace_id: input.workspaceId },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      }, { idempotencyKey: input.idempotencyKey });
      if (typeof session.url !== "string") throw new StripeUpstreamError(undefined);
      return { id: session.id, url: session.url };
    } catch (error) {
      throw this.asUpstream(error);
    }
  }

  async createCreditPackCheckout(input: CreditPackCheckoutInput): Promise<HostedSession> {
    const client = this.requireClient();
    try {
      const metadata = { workspace_id: input.workspaceId, purchase_id: input.purchaseId, pack_key: input.packKey };
      const session = await client.checkout.sessions.create(
        {
          mode: "payment",
          client_reference_id: input.workspaceId,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: input.currency.toLowerCase(),
                unit_amount: input.unitAmountCents,
                product_data: { name: input.productName, metadata: { nominara_kind: "credit_pack" } },
              },
            },
          ],
          // Both objects carry the ids, so payment_intent.* events resolve the
          // purchase from their own fresh fetch.
          // NEW-D-7 — only when the workspace has auto-top-up enabled, the card is saved
          // under a customer for off-session reuse. Checkout shows Stripe's own reuse notice.
          ...(input.saveCard ? { customer_creation: "always" as const } : {}),
          payment_intent_data: { metadata, ...(input.saveCard ? { setup_future_usage: "off_session" as const } : {}) },
          metadata,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
        },
        { idempotencyKey: `credit-pack-${input.purchaseId}` },
      );
      if (typeof session.url !== "string") throw new StripeUpstreamError(undefined);
      return { id: session.id, url: session.url };
    } catch (error) {
      throw this.asUpstream(error);
    }
  }

  async findSavedPaymentMethod(referencePaymentIntentId: string): Promise<SavedPaymentMethod | null> {
    const client = this.requireClient();
    try {
      const intent = await client.paymentIntents.retrieve(referencePaymentIntentId);
      const customerId = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
      const paymentMethodId = typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id;
      if (intent.setup_future_usage !== "off_session" || customerId === undefined || paymentMethodId === undefined) return null;
      return { customerId, paymentMethodId };
    } catch (error) {
      throw this.asUpstream(error);
    }
  }

  async createOffSessionPayment(input: OffSessionPaymentInput): Promise<OffSessionPaymentResult> {
    const client = this.requireClient();
    try {
      const intent = await client.paymentIntents.create(
        {
          amount: input.unitAmountCents,
          currency: input.currency.toLowerCase(),
          customer: input.customerId,
          payment_method: input.paymentMethodId,
          off_session: true,
          confirm: true,
          description: input.productName,
          metadata: { workspace_id: input.workspaceId, purchase_id: input.purchaseId, pack_key: input.packKey, source: "auto_topup" },
        },
        { idempotencyKey: `auto-topup-${input.purchaseId}` },
      );
      // `requires_action` / `requires_payment_method`: the customer is needed. Never retried.
      if (intent.status === "succeeded" || intent.status === "processing") return { outcome: "submitted", paymentIntentId: intent.id };
      return { outcome: "declined" };
    } catch (error) {
      if (error instanceof Stripe.errors.StripeCardError) return { outcome: "declined" };
      throw this.asUpstream(error);
    }
  }

  async findOffSessionPayment(purchaseId: string): Promise<OffSessionPaymentState> {
    const client = this.requireClient();
    // The id is interpolated into a search query: only a UUID may be.
    if (!UUID.test(purchaseId)) throw new StripeUpstreamError(undefined);
    try {
      const found = await client.paymentIntents.search({ query: `metadata['purchase_id']:'${purchaseId}' AND metadata['source']:'auto_topup'`, limit: 10 });
      const statuses = found.data.map((intent) => intent.status as string);
      if (statuses.length === 0) return "none";
      if (statuses.includes("succeeded")) return "succeeded";
      // Doubt blocks: anything not known to be dead is still in progress.
      if (statuses.some((s) => !DEAD_INTENT_STATUSES.has(s))) return "in_progress";
      return "failed";
    } catch (error) {
      throw this.asUpstream(error);
    }
  }

  async closeCheckoutSession(sessionId: string): Promise<ClosedCheckoutSession> {
    const client = this.requireClient();
    try {
      const expand = { expand: ["subscription"] };
      let session = await client.checkout.sessions.retrieve(sessionId, expand);
      if (session.status === "open") {
        try {
          session = await client.checkout.sessions.expire(sessionId, expand);
        } catch (error) {
          // Paid or expired between the read and the expire: the truth is on the session.
          if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) throw error;
          session = await client.checkout.sessions.retrieve(sessionId, expand);
        }
      }
      if (session.status === "expired") return { status: "expired" };
      if (session.status === "complete") {
        const subscription = session.subscription;
        const status = subscription !== null && typeof subscription === "object" ? subscription.status : undefined;
        // Unknown means live: this answer blocks a second purchase, so doubt blocks.
        return { status: "complete", subscriptionLive: !(status === "canceled" || status === "incomplete_expired" || status === "unpaid" || status === "paused") };
      }
      // Still open after an expire that did not throw: it was not closed.
      throw new StripeUpstreamError(undefined);
    } catch (error) {
      throw this.asUpstream(error);
    }
  }

  async createPortalSession(input: { readonly customerId: string; readonly returnUrl: string }): Promise<{ readonly url: string }> {
    const client = this.requireClient();
    try {
      const session = await client.billingPortal.sessions.create({ customer: input.customerId, return_url: input.returnUrl });
      return { url: session.url };
    } catch (error) {
      throw this.asUpstream(error);
    }
  }

  async updateCustomerBillingEmail(input: { readonly customerId: string; readonly email: string }): Promise<void> {
    const client = this.requireClient();
    try {
      await client.customers.update(input.customerId, { email: input.email });
    } catch (error) {
      throw this.asUpstream(error);
    }
  }

  async changeAddonQuantity(input: AddonChangeInput): Promise<void> {
    const client = this.requireClient();
    try {
      if (input.existingItemId !== null) {
        await client.subscriptionItems.update(
          input.existingItemId,
          { quantity: input.quantity, proration_behavior: input.proration },
          { idempotencyKey: input.idempotencyKey },
        );
        return;
      }
      // A subscription item's inline price_data needs a Product ID (only Checkout
      // accepts product_data), so the add-on's product is created once under a
      // fixed id and reused. `nominara_kind` is how the reconciler finds the line.
      const product = await this.addonProductId(client, input);
      await client.subscriptionItems.create(
        {
          subscription: input.subscriptionId,
          quantity: input.quantity,
          proration_behavior: input.proration,
          price_data: {
            currency: input.currency.toLowerCase(),
            product,
            unit_amount: input.unitAmountCents,
            recurring: { interval: input.interval },
          },
        },
        { idempotencyKey: input.idempotencyKey },
      );
    } catch (error) {
      throw this.asUpstream(error);
    }
  }

  private async addonProductId(client: Stripe, input: AddonChangeInput): Promise<string> {
    const id = `nominara_addon_${input.kind}`;
    try {
      await client.products.create({ id, name: input.productName, metadata: { nominara_kind: input.kind } });
    } catch (error) {
      // Already created by an earlier purchase (or a concurrent one): that is the product we want.
      if (!(error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_already_exists")) throw error;
    }
    return id;
  }

  async scheduleAddonRemoval(input: AddonRemovalInput): Promise<void> {
    const client = this.requireClient();
    try {
      const subscription = await client.subscriptions.retrieve(input.subscriptionId);
      const item = subscription.items.data.find((line) => line.id === input.itemId);
      // Already gone from the subscription: nothing to schedule (a redelivered DELETE).
      if (item === undefined) return;
      const removedPrice = item.price.id;
      // One more billing cycle, then the schedule is released and the subscription carries on as normal.
      const cycle = item.price.recurring?.interval === "year" ? "year" : "month";

      const scheduleId = await this.scheduleIdOf(client, subscription, input.subscriptionId, `${input.idempotencyKey}-schedule`);
      const schedule = await client.subscriptionSchedules.retrieve(scheduleId);
      const current = schedule.phases[0];
      if (current === undefined) throw new StripeUpstreamError(undefined);

      // ⚠ BOTH PHASES CARRY THE SUBSCRIPTION'S METADATA, and the plan line travels with them (STORY-184). The phase after
      // the removal is the same items without the add-on (the second one, if a change is already scheduled, is rewritten
      // rather than appended to); its metadata is that phase's own over the subscription's.
      const next = schedule.phases[1];
      const live = stringMetadataOf(subscription.metadata);
      const keep = (lines: PhaseLine[]): PhaseLine[] => lines.filter((line) => line.price !== removedPrice);
      await client.subscriptionSchedules.update(
        scheduleId,
        buildTwoPhaseSchedule({
          current: { items: phaseLinesOf(current.items), startDate: current.start_date, endDate: current.end_date, metadata: live },
          next: { items: keep(phaseLinesOf((next ?? current).items)), metadata: { ...live, ...stringMetadataOf(next?.metadata) }, interval: cycle },
        }),
        { idempotencyKey: input.idempotencyKey },
      );
    } catch (error) {
      throw this.asUpstream(error);
    }
  }

  /** The schedule a subscription already has, else a new one created from it. */
  private async scheduleIdOf(client: Stripe, subscription: Stripe.Subscription, subscriptionId: string, createKey: string): Promise<string> {
    const existing = subscription.schedule;
    if (typeof existing === "string") return existing;
    if (existing !== null && existing !== undefined) return existing.id;
    return (await client.subscriptionSchedules.create({ from_subscription: subscriptionId }, { idempotencyKey: createKey })).id;
  }

  /**
   * STORY-184 — the target plan's product, created once under a fixed id (an item's inline `price_data` takes a product
   * ID, and only Checkout accepts `product_data`). `nominara_kind=plan` is how the reconciler tells the plan line from an
   * add-on line on the fetched subscription.
   */
  private async planProductId(client: Stripe, target: PlanPrice): Promise<string> {
    const id = `nominara_plan_${target.planKey}`;
    try {
      await client.products.create({ id, name: target.productName, metadata: { nominara_kind: "plan" } });
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_already_exists")) throw error;
    }
    return id;
  }

  private planPriceData(target: PlanPrice, product: string) {
    return { currency: target.currency.toLowerCase(), product, unit_amount: target.unitAmountCents, recurring: { interval: target.interval } } as const;
  }

  async previewPlanChange(input: PlanChangePreviewInput): Promise<PlanChangePreviewResult> {
    const client = this.requireClient();
    try {
      const product = await this.planProductId(client, input.target);
      const preview = await client.invoices.createPreview({
        customer: input.customerId,
        subscription: input.subscriptionId,
        subscription_details: {
          items: [{ id: input.planItemId, price_data: this.planPriceData(input.target, product) }],
          proration_behavior: "always_invoice",
          proration_date: input.prorationDate,
        },
      });
      // Fail closed: a preview with no amount is not a free upgrade.
      if (typeof preview.amount_due !== "number" || !Number.isSafeInteger(preview.amount_due) || typeof preview.currency !== "string") throw new StripeUpstreamError(undefined);
      return { amountDueCents: preview.amount_due, currency: preview.currency };
    } catch (error) {
      throw this.asUpstream(error);
    }
  }

  async applyPlanUpgrade(input: PlanUpgradeInput): Promise<PlanUpgradeResult> {
    const client = this.requireClient();
    try {
      const product = await this.planProductId(client, input.target);
      await client.subscriptions.update(
        input.subscriptionId,
        {
          // ONLY the plan item is listed: the add-on items are left exactly as they are.
          items: [{ id: input.planItemId, price_data: this.planPriceData(input.target, product) }],
          proration_behavior: "always_invoice",
          proration_date: input.prorationDate,
          // The proration is paid now or the update is not applied: a decline leaves the subscription untouched.
          payment_behavior: "error_if_incomplete",
          metadata: { ...input.metadata },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { outcome: "applied" };
    } catch (error) {
      // A declined card, or one that needs the customer present (3-D Secure, also a card error): Stripe applied nothing.
      if (error instanceof Stripe.errors.StripeCardError) return { outcome: "payment_failed" };
      throw this.asUpstream(error);
    }
  }

  async schedulePlanDowngrade(input: PlanDowngradeInput): Promise<{ readonly scheduleId: string }> {
    const client = this.requireClient();
    try {
      const subscription = await client.subscriptions.retrieve(input.subscriptionId);
      const product = await this.planProductId(client, input.target);
      const scheduleId = await this.scheduleIdOf(client, subscription, input.subscriptionId, `${input.idempotencyKey}-schedule`);
      const schedule = await client.subscriptionSchedules.retrieve(scheduleId);
      const current = schedule.phases[0];
      if (current === undefined) throw new StripeUpstreamError(undefined);
      const items: PhaseItem[] = [
        { price_data: this.planPriceData(input.target, product), quantity: 1 },
        ...input.keepAddons.map((addon) => ({ price: addon.priceId, quantity: addon.quantity })),
      ];
      await client.subscriptionSchedules.update(
        scheduleId,
        buildTwoPhaseSchedule({
          // Phase 0 keeps the subscription's OWN metadata, explicitly: omitting it would strip it at the cut-over.
          current: { items: phaseLinesOf(current.items), startDate: current.start_date, endDate: current.end_date, metadata: stringMetadataOf(subscription.metadata) },
          next: { items, metadata: input.metadata, interval: input.target.interval },
        }),
        { idempotencyKey: input.idempotencyKey },
      );
      return { scheduleId };
    } catch (error) {
      throw this.asUpstream(error);
    }
  }

  async releasePlanDowngrade(input: PlanDowngradeReleaseInput): Promise<{ readonly outcome: "released" | "already_effective" }> {
    const client = this.requireClient();
    try {
      const schedule = await client.subscriptionSchedules.retrieve(input.scheduleId);
      const second = schedule.phases[1];
      const inSecondPhase = second !== undefined && schedule.current_phase !== null && schedule.current_phase.start_date >= second.start_date;
      // Only a schedule still in its first phase can be cancelled; completed, released, canceled or already running the
      // second phase means the downgrade has taken effect (or there is nothing left to cancel).
      if ((schedule.status !== "active" && schedule.status !== "not_started") || inSecondPhase) return { outcome: "already_effective" };
      await client.subscriptionSchedules.release(input.scheduleId, {}, { idempotencyKey: input.idempotencyKey });
      return { outcome: "released" };
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_missing") return { outcome: "already_effective" };
      throw this.asUpstream(error);
    }
  }

  private requireClient(): Stripe {
    if (this.client === undefined) throw new StripeUpstreamError(undefined);
    return this.client;
  }

  private asUpstream(error: unknown): StripeUpstreamError {
    if (error instanceof StripeUpstreamError) return error;
    const { statusCode, rawType } = error as { statusCode?: unknown; rawType?: unknown };
    const errorType = STRIPE_ERROR_TYPES.find((type) => type === rawType);
    return new StripeUpstreamError(typeof statusCode === "number" ? statusCode : undefined, errorType);
  }

  async fetchObject(kind: StripeObjectKind, objectId: string): Promise<FetchedStripeObject | null> {
    const client = this.client;
    if (client === undefined) throw new StripeUpstreamError(undefined);
    try {
      switch (kind) {
        case "subscription": {
          // The product is expanded so the reconciler can tell the plan item
          // from add-on items (`product.metadata.nominara_kind`).
          const object = await client.subscriptions.retrieve(objectId, { expand: ["items.data.price.product"] });
          return this.shape(kind, object);
        }
        case "checkout_session": {
          const object = await client.checkout.sessions.retrieve(objectId);
          return this.shape(kind, object);
        }
        case "payment_intent": {
          const object = await client.paymentIntents.retrieve(objectId);
          return this.shape(kind, object);
        }
        case "invoice": {
          const object = await client.invoices.retrieve(objectId);
          // An invoice carries no workspace of its own; the subscription's
          // metadata (copied onto the invoice by Stripe) is where it lives.
          const raw = object as unknown as Record<string, unknown>;
          const parent = raw.parent as { subscription_details?: { metadata?: unknown } } | null | undefined;
          const metadata = { ...stringMetadata(parent?.subscription_details?.metadata), ...stringMetadata(raw.metadata) };
          return { kind, id: object.id as string, metadata, raw };
        }
      }
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_missing") return null;
      const status = (error as { statusCode?: unknown }).statusCode;
      throw new StripeUpstreamError(typeof status === "number" ? status : undefined);
    }
  }

  private shape(kind: StripeObjectKind, object: { id: string; metadata?: unknown }): FetchedStripeObject {
    return {
      kind,
      id: object.id,
      metadata: stringMetadata(object.metadata),
      raw: object as unknown as Record<string, unknown>,
    };
  }
}
