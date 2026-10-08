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
  /**
   * NEW-D-2 audit — the checkout intent (`subscriptions.pending_checkout.id`),
   * written to the subscription's metadata so the webhook can find the price
   * frozen for THIS session. Not a secret and not authority: it is a lookup key.
   */
  readonly intentId: string;
  /**
   * NEW-D-2 audit — the Stripe `Idempotency-Key`. The same key with the same
   * body returns the SAME session, so a retry after a crash can recover the
   * session the crashed request created (and expire it) instead of minting a
   * second payable one.
   */
  readonly idempotencyKey: string;
}

/**
 * STORY-076a — everything Stripe needs to host a one-time credit-pack payment.
 * The price comes from OUR `credit_purchases` row, written before this call; the
 * client supplies neither a price nor a redirect.
 */
export interface CreditPackCheckoutInput {
  readonly workspaceId: string;
  /** `credit_purchases.id` — travels as metadata on the session AND the PaymentIntent. */
  readonly purchaseId: string;
  readonly packKey: string;
  readonly productName: string;
  readonly credits: number;
  /** Integer minor units, from the purchase row's `numeric(12,2)`. Never a float. */
  readonly unitAmountCents: number;
  readonly currency: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Owner decision 4 — save the card for off-session reuse only when the workspace has auto-top-up enabled. */
  readonly saveCard: boolean;
}

/**
 * STORY-076b — set an add-on's subscription item to a TOTAL quantity, pro-rated
 * by Stripe. With no `existingItemId` a new item is created from inline
 * `price_data` (owner decision: no Stripe catalog to keep in step with ours).
 * The caller computed `quantity` from a FRESH fetch, so this is a set, not a delta.
 */
export interface AddonChangeInput {
  readonly subscriptionId: string;
  readonly kind: "extra_project" | "extra_seat";
  /** The new total, 1..100. */
  readonly quantity: number;
  readonly existingItemId: string | null;
  readonly productName: string;
  /** Integer minor units, from the catalog's `numeric(12,2)` text. Never a float. */
  readonly unitAmountCents: number;
  readonly currency: string;
  /** An item's interval must equal the plan item's. */
  readonly interval: "month" | "year";
  readonly proration: "create_prorations";
  readonly idempotencyKey: string;
}

/** STORY-076b — drop an add-on's item at the end of the current period (STORY-076 AC13), not now. */
export interface AddonRemovalInput {
  readonly subscriptionId: string;
  readonly itemId: string;
  readonly idempotencyKey: string;
}
/** NEW-D-7 — a card the customer agreed to have reused off-session (a Checkout with `setup_future_usage`). */
export interface SavedPaymentMethod {
  readonly customerId: string;
  readonly paymentMethodId: string;
}

/**
 * NEW-D-7 — one auto-top-up charge. The amount is the integer-cents price of
 * the pack frozen on OUR `credit_purchases` row; nothing here comes from the
 * client. `purchaseId` travels as metadata and keys Stripe's Idempotency-Key.
 */
export interface OffSessionPaymentInput {
  readonly workspaceId: string;
  readonly purchaseId: string;
  readonly packKey: string;
  readonly productName: string;
  readonly unitAmountCents: number;
  readonly currency: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
}

/**
 * `declined`: the card was refused, or the charge needs the customer present
 * (3-D Secure) — neither can succeed without them, so neither is retried.
 * `submitted`: Stripe accepted the charge; credits still land only on the webhook.
 */
export type OffSessionPaymentResult = { readonly outcome: "submitted"; readonly paymentIntentId: string } | { readonly outcome: "declined" };

/**
 * NEW-D-7 audit 1 — what Stripe holds for one auto-top-up purchase id.
 * `none`: no PaymentIntent exists. `in_progress`: one exists and may still be
 * taken (processing — a bank debit stays so for days). `succeeded`: taken.
 * `failed`: every PaymentIntent ended without taking money.
 */
export type OffSessionPaymentState = "none" | "in_progress" | "succeeded" | "failed";

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
   * Hosted Checkout, mode=payment, for one credit pack. Sets `metadata`
   * (`workspace_id`, `purchase_id`) on the session AND on the PaymentIntent, so
   * either event's FRESH fetch names the purchase. The Stripe idempotency key
   * is the purchase id: a retried call cannot mint a second payable session.
   * Throws `StripeUpstreamError`.
   */
  createCreditPackCheckout(input: CreditPackCheckoutInput): Promise<HostedSession>;

  /**
   * NEW-D-7 — the card a PREVIOUS pack purchase saved for off-session reuse, or
   * `null` when that PaymentIntent was not saved (no customer, no method, or no
   * `setup_future_usage=off_session`). Throws `StripeUpstreamError`.
   */
  findSavedPaymentMethod(referencePaymentIntentId: string): Promise<SavedPaymentMethod | null>;

  /**
   * NEW-D-7 — an off-session, immediately confirmed charge of the saved method,
   * with `workspace_id`, `purchase_id`, `pack_key` and `source=auto_topup` as
   * PaymentIntent metadata so the webhook's re-fetch finds the purchase. The
   * Idempotency-Key is the purchase id. Throws `StripeUpstreamError`.
   */
  createOffSessionPayment(input: OffSessionPaymentInput): Promise<OffSessionPaymentResult>;

  /**
   * NEW-D-7 audit 1 — asks Stripe whether the charge for this purchase id exists
   * and how it ended (PaymentIntent search on `metadata.purchase_id`). A
   * purchase may be expired ONLY on `none` or `failed`; `in_progress` and
   * `succeeded` mean the money may be taken. Search is eventually consistent
   * (about a minute), so ask only about a purchase older than that. Throws
   * `StripeUpstreamError` — and the caller must then leave the purchase pending.
   */
  findOffSessionPayment(purchaseId: string): Promise<OffSessionPaymentState>;

  /**
   * Makes a Checkout session unpayable, or reports that it already was paid.
   * Idempotent for an already-expired session. Throws `StripeUpstreamError`.
   */
  closeCheckoutSession(sessionId: string): Promise<ClosedCheckoutSession>;

  /** Hosted billing portal for an existing customer. Throws `StripeUpstreamError`. */
  createPortalSession(input: { readonly customerId: string; readonly returnUrl: string }): Promise<{ readonly url: string }>;

  /**
   * STORY-076b — set an add-on item's quantity with proration (creating the
   * item when there is none). Throws `StripeUpstreamError`. Writes NOTHING
   * local: the add-on rows change only when the webhook reconciles.
   */
  changeAddonQuantity(input: AddonChangeInput): Promise<void>;

  /**
   * STORY-076b — schedules the item's removal at the current period end.
   * Idempotent for an already-scheduled removal. Throws `StripeUpstreamError`.
   */
  scheduleAddonRemoval(input: AddonRemovalInput): Promise<void>;

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
