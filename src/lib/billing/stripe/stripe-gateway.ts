// NEW-D-2 — the Stripe port. Everything the product asks of Stripe goes
// through this interface so that (a) no unit or integration test ever calls the
// real Stripe API — they bind `FakeStripeGateway` — and (b) the credentials
// live in exactly one adapter.
//
// This story needs two operations: verify a webhook delivery, and re-fetch the
// object it points at. Checkout, portal and charge operations are added to this
// interface by STORY-075a / STORY-076a, which depend on this one.

/** DI token. A symbol, not the interface: interfaces do not exist at runtime. */
export const STRIPE_GATEWAY = Symbol("STRIPE_GATEWAY");

/**
 * What a verified delivery tells us — and ONLY that. An event is a pointer
 * ("this object changed"), never the state: Stripe delivers out of order and
 * more than once, so the handler re-fetches and writes the whole record
 * (STORY-075's fresh-fetch reconciliation). Nothing here carries a workspace.
 */
export interface VerifiedStripeEvent {
  readonly id: string;
  readonly type: string;
  /** The id of `data.object` — what to re-fetch. */
  readonly objectId: string;
}

export type StripeObjectKind = "subscription" | "checkout_session" | "invoice" | "payment_intent";

/** The object as Stripe holds it NOW, not as the event described it. */
export interface FetchedStripeObject {
  readonly kind: StripeObjectKind;
  readonly id: string;
  /** Always a flat string map; `workspace_id` is the only key this ingress reads. */
  readonly metadata: Readonly<Record<string, string>>;
  /** The full object, for the handler that owns this event type. Never logged. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * STORY-075a — everything Stripe needs to host a subscription checkout. Built
 * by the service from OUR plan catalog and the caller's workspace; the client
 * supplies neither a price nor a redirect.
 */
export interface SubscriptionCheckoutInput {
  readonly workspaceId: string;
  readonly planKey: string;
  readonly billingInterval: "monthly" | "annual";
  readonly productName: string;
  /** Integer minor units, from the plan's `numeric(12,2)` price. Never a float. */
  readonly unitAmountCents: number;
  readonly currency: string;
  /** An existing Stripe customer to reuse, or undefined to let Checkout create one. */
  readonly customerId?: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export interface HostedSession {
  readonly id: string;
  readonly url: string;
}

/**
 * What closing a Checkout session found. `expired`: it can no longer be paid.
 * `complete`: it was ALREADY paid, and `subscriptionLive` says whether the
 * subscription it bought is still entitled (so the webhook has yet to apply it).
 */
export type ClosedCheckoutSession = { readonly status: "expired" } | { readonly status: "complete"; readonly subscriptionLive: boolean };

export interface StripeGateway {
  /** False when the secret key or the webhook secret is absent; Stripe routes then answer 503. */
  isConfigured(): boolean;

  /**
   * Verifies the `Stripe-Signature` header against the RAW bytes. Throws
   * `StripeSignatureError` for a missing, malformed, wrong or stale signature
   * (default tolerance 300 s). Never returns an unverified event.
   */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): VerifiedStripeEvent;

  /**
   * Hosted Checkout, mode=subscription. Sets `client_reference_id` and
   * `subscription_data.metadata.workspace_id` — the metadata the webhook reads
   * back from the FRESHLY FETCHED subscription to find the workspace. No card
   * data touches this system. Throws `StripeUpstreamError`.
   */
  createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<HostedSession>;

  /**
   * Makes a Checkout session unpayable, or reports that it already was paid.
   * Idempotent for an already-expired session. Throws `StripeUpstreamError`.
   */
  closeCheckoutSession(sessionId: string): Promise<ClosedCheckoutSession>;

  /** Hosted billing portal for an existing customer. Throws `StripeUpstreamError`. */
  createPortalSession(input: { readonly customerId: string; readonly returnUrl: string }): Promise<{ readonly url: string }>;

  /** `null` when Stripe has no such object (deleted, or a test-mode id at a live endpoint). */
  fetchObject(kind: StripeObjectKind, objectId: string): Promise<FetchedStripeObject | null>;
}

/** Which object a given event type points at, or null for a type this product does not consume. */
export function objectKindForEventType(type: string): StripeObjectKind | null {
  if (type.startsWith("customer.subscription.")) return "subscription";
  if (type.startsWith("checkout.session.")) return "checkout_session";
  if (type.startsWith("invoice.")) return "invoice";
  if (type.startsWith("payment_intent.")) return "payment_intent";
  return null;
}

/** The signature did not verify. Deliberately carries no detail of WHY — that is an oracle for a forger. */
export class StripeSignatureError extends Error {
  constructor() {
    super("stripe webhook signature verification failed");
    this.name = "StripeSignatureError";
  }
}

/** Stripe answered, but not with an object (network, 5xx, auth). Retry-worthy; carries no Stripe text. */
export class StripeUpstreamError extends Error {
  constructor(readonly statusCode: number | undefined) {
    super(`stripe request failed${statusCode === undefined ? "" : ` (${statusCode})`}`);
    this.name = "StripeUpstreamError";
  }
}
