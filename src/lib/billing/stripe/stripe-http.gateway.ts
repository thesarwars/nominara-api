import Stripe from "stripe";
import {
  StripeSignatureError,
  StripeUpstreamError,
  type ClosedCheckoutSession,
  type FetchedStripeObject,
  type HostedSession,
  type StripeGateway,
  type StripeObjectKind,
  type SubscriptionCheckoutInput,
  type VerifiedStripeEvent,
} from "./stripe-gateway.js";

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
          metadata: { workspace_id: input.workspaceId, plan_key: input.planKey, billing_interval: input.billingInterval },
        },
        metadata: { workspace_id: input.workspaceId },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      });
      if (typeof session.url !== "string") throw new StripeUpstreamError(undefined);
      return { id: session.id, url: session.url };
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

  private requireClient(): Stripe {
    if (this.client === undefined) throw new StripeUpstreamError(undefined);
    return this.client;
  }

  private asUpstream(error: unknown): StripeUpstreamError {
    if (error instanceof StripeUpstreamError) return error;
    const status = (error as { statusCode?: unknown }).statusCode;
    return new StripeUpstreamError(typeof status === "number" ? status : undefined);
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
