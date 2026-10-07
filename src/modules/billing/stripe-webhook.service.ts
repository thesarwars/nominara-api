import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { z } from "zod";
import type { StripeWebhookResponse } from "../../../contracts/billing/index.js";
import { DegradedError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { PG_POOL } from "../../db/pg-pool.js";
import {
  objectKindForEventType,
  StripeSignatureError,
  StripeUpstreamError,
  STRIPE_GATEWAY,
  type FetchedStripeObject,
  type StripeGateway,
  type StripeObjectKind,
  type VerifiedStripeEvent,
} from "../../lib/billing/stripe/stripe-gateway.js";
import { claimWebhookEvent, webhookEventSeen } from "../../lib/billing/stripe/webhook-events.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { STRIPE_EVENT_HANDLERS, type StripeEventHandler } from "./stripe-event-handler.js";

const workspaceIdSchema = z.uuid();

function subscriptionIdOf(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value !== null && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  return null;
}

// NEW-D-2 — STORY-075's webhook ingress. The order below is the design:
//
//   1. configured?            no  -> 503 degraded (the API boots without Stripe)
//   2. verify the signature   bad -> 400, nothing written, nothing fetched
//   3. any handler for this type?  no -> record the event, acknowledge
//   4. already seen?          yes -> acknowledge (a spared fetch, not the guarantee)
//   5. RE-FETCH the object from Stripe        (outside any transaction — KAD-06)
//   6. workspace := fetched.metadata.workspace_id
//        absent / not a uuid / unknown workspace -> warn, record, 2xx
//   7. ONE tenant-context transaction as that workspace:
//        claim the event id  ->  handlers' effects  ->  COMMIT
//
// ⚠ THE WORKSPACE IS NEVER READ FROM THE EVENT, AND NEVER FOUND BY SCANNING
// `subscriptions`. The event body is signed by Stripe but is a pointer, and a
// cross-tenant scan would read every tenant's rows outside any tenant context
// to answer "whose is this?". The re-fetched object's metadata was written by
// OUR checkout (075a) and is the one place the answer lives.
//
// ⚠ 2xx FOR AN UNKNOWN SUBJECT, 5xx ONLY FOR A REAL FAILURE. A non-2xx makes
// Stripe retry for days; a test-mode event at a live endpoint would retry
// forever and fill the dead-letter queue. A handler that throws, or a Stripe
// outage during the re-fetch, IS a real failure: nothing was recorded (the
// claim rolls back with the effect), so Stripe's retry gets a clean attempt.
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    @Inject(STRIPE_GATEWAY) private readonly gateway: StripeGateway,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(STRIPE_EVENT_HANDLERS) private readonly handlers: readonly StripeEventHandler[],
  ) {}

  async handle(rawBody: Buffer | undefined, signatureHeader: string | undefined): Promise<StripeWebhookResponse> {
    if (!this.gateway.isConfigured()) {
      incrementCounter("nominara_billing_stripe_webhook_events_total", { outcome: "not_configured" });
      throw new DegradedError({ message: "payment provider is not configured" });
    }

    let event: VerifiedStripeEvent;
    try {
      if (rawBody === undefined) throw new StripeSignatureError();
      event = this.gateway.verifyWebhook(rawBody, signatureHeader);
    } catch (error) {
      if (!(error instanceof StripeSignatureError)) throw error;
      incrementCounter("nominara_billing_stripe_webhook_events_total", { outcome: "bad_signature" });
      this.logger.warn({ message: "stripe webhook refused: signature did not verify" });
      throw new ValidationFailedError({
        message: "webhook signature verification failed",
        details: { issues: [{ path: ["stripe-signature"], message: "signature verification failed" }] },
      });
    }

    const response = await this.dispatch(event);
    incrementCounter("nominara_billing_stripe_webhook_events_total", { outcome: response.outcome });
    return response;
  }

  private async dispatch(event: VerifiedStripeEvent): Promise<StripeWebhookResponse> {
    const handlers = this.handlers.filter((h) => h.types.includes(event.type));
    const kind = objectKindForEventType(event.type);
    if (handlers.length === 0 || kind === null) {
      return await this.acknowledgeOnly(event, "no handler consumes this event type", "log");
    }

    if (await this.alreadySeen(event.id)) return { received: true, outcome: "duplicate" };

    let fetchStartedAt = new Date();
    let object = await this.fetch(event, kind, event.objectId);
    if (object === null) return await this.acknowledgeOnly(event, "stripe has no such object");

    // STORY-075a — a completed subscription-mode Checkout is a POINTER to the
    // subscription, which holds the state and the workspace metadata. Follow
    // it, still outside any transaction. Payment-mode sessions (credit packs,
    // STORY-076a) are left exactly as fetched.
    if (object.kind === "checkout_session" && object.raw.mode === "subscription") {
      const subscriptionId = subscriptionIdOf(object.raw.subscription);
      if (subscriptionId === null) return await this.acknowledgeOnly(event, "checkout session carries no subscription");
      fetchStartedAt = new Date();
      object = await this.fetch(event, "subscription", subscriptionId);
      if (object === null) return await this.acknowledgeOnly(event, "stripe has no such subscription");
    }

    const parsed = workspaceIdSchema.safeParse(object.metadata.workspace_id);
    if (!parsed.success) return await this.acknowledgeOnly(event, "object carries no resolvable workspace_id");
    const workspaceId = parsed.data;

    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        if (!(await claimWebhookEvent(tx, event.id, event.type))) return { received: true, outcome: "duplicate" } as const;

        // RLS answers "does this workspace exist": `workspaces` is scoped by
        // its own id, so a workspace that does not exist yields no row.
        const exists = await tx.query("SELECT 1 FROM workspaces WHERE id = $1 AND deleted_at IS NULL", [workspaceId]);
        if (exists.rowCount === 0) {
          this.logger.warn({ message: "stripe webhook acknowledged: workspace does not exist", event_id: event.id, event_type: event.type, workspace_id: workspaceId });
          return { received: true, outcome: "ignored" } as const;
        }

        for (const handler of handlers) await handler.handle({ tx, workspaceId, event, object, fetchStartedAt });
        return { received: true, outcome: "processed" } as const;
      });
    } finally {
      client.release();
    }
  }

  /** The re-fetch. A Stripe outage is a real failure: nothing is recorded and Stripe retries. */
  private async fetch(event: VerifiedStripeEvent, kind: StripeObjectKind, objectId: string): Promise<FetchedStripeObject | null> {
    try {
      return await this.gateway.fetchObject(kind, objectId);
    } catch (error) {
      if (!(error instanceof StripeUpstreamError)) throw error;
      this.logger.error({ message: "stripe re-fetch failed", event_id: event.id, event_type: event.type, status: error.statusCode });
      throw new DegradedError({ message: "payment provider is unavailable" });
    }
  }

  private async alreadySeen(eventId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      return await webhookEventSeen(client, eventId);
    } finally {
      client.release();
    }
  }

  /** Records the event (global table, no tenant context) and answers 2xx. A warn log, never an error. */
  private async acknowledgeOnly(event: VerifiedStripeEvent, reason: string, level: "log" | "warn" = "warn"): Promise<StripeWebhookResponse> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const claimed = await claimWebhookEvent(client, event.id, event.type);
        await client.query("COMMIT");
        if (!claimed) return { received: true, outcome: "duplicate" };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
    this.logger[level]({ message: `stripe webhook acknowledged without effect: ${reason}`, event_id: event.id, event_type: event.type });
    return { received: true, outcome: "ignored" };
  }
}
