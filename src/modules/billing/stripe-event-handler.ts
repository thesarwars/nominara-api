import type { ClientBase } from "pg";
import type { FetchedStripeObject, VerifiedStripeEvent } from "../../lib/billing/stripe/stripe-gateway.js";

// NEW-D-2 — the seam STORY-075a (subscriptions) and STORY-076a (credit packs)
// plug their effects into. This story ships the ingress with NO handler, so
// every verified event is acknowledged and recorded; each later story adds its
// own provider to STRIPE_EVENT_HANDLERS.

export const STRIPE_EVENT_HANDLERS = Symbol("STRIPE_EVENT_HANDLERS");

export interface StripeEventContext {
  /** The open tenant-context transaction. The de-duplication claim is already in it. */
  readonly tx: ClientBase;
  /** Resolved from the re-fetched object's `metadata.workspace_id` — never from the event payload. */
  readonly workspaceId: string;
  readonly event: VerifiedStripeEvent;
  /** Stripe's CURRENT state of the object. Write it wholesale; never apply the event as a delta. */
  readonly object: FetchedStripeObject;
  /** When the fetch that produced `object` STARTED. A write whose fetch began before a newer committed one is stale. */
  readonly fetchStartedAt: Date;
  /**
   * NEW-D-7 — work to run AFTER the transaction commits (a notification email):
   * it must not hold the claim's transaction open across a call to an external
   * service, and it must not run if the transaction rolls back. A failure here
   * is logged by the caller and never fails the event: the effect is committed.
   */
  readonly afterCommit: Array<() => Promise<void>>;
}

export interface StripeEventHandler {
  /** Exact Stripe event types this handler consumes. */
  readonly types: readonly string[];
  /** Runs inside the claim's transaction: a throw rolls back the claim AND the effect, and Stripe retries. */
  handle(context: StripeEventContext): Promise<void>;
}
