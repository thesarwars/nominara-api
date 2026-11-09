import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase, Pool } from "pg";
import { z } from "zod";
import { StripeHttpGateway } from "../../billing/stripe/stripe-http.gateway.js";
import type { StripeGateway } from "../../billing/stripe/stripe-gateway.js";
import { SYSTEM_ACTOR_ID } from "../../../tenancy/constants.js";
import { withTenantContext } from "../../../tenancy/tenant-context.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// Decision 83(a) (batch 6, 2026-11-09) — `billing.cancel_on_deletion`: after a workspace deletion request commits, set the
// workspace's Stripe subscription to cancel at period end, so a deleted workspace is not billed through the 30-day grace and
// beyond. No refund, no immediate cancel.
//
// A SIGNED TENANT job: `createJobProcessor` verified the signature before this ran and before any context was set, so
// `workspaceId` is the only workspace this handler acts on. The payload carries NOTHING else (`.strict()`): the subscription id
// is read here, live, so a redelivery converges and a forged id is not a thing the job can carry.
//
// ⚠ `tx` IS DELIBERATELY NOT USED, as in billing.customer_email: the reads run in their own short tenant transaction, released
// BEFORE the Stripe call (KAD-06 / ADR-0003: no transaction held across an external call).
//
// Idempotent under at-least-once delivery: setting a boolean twice is a no-op at Stripe, and a replay that finds the local flag
// already set (the webhook reconciled) skips the call. NO Stripe idempotency key (stripe-subscriptions trap 9: a key on a toggle
// is replayed without re-applying it). A workspace that is not (or is no longer) `pending_deletion` is left alone.

const payloadSchema = z.object({ workspaceId: z.string().uuid(), kid: z.string() }).strict();

export type BillingCancelOnDeletionOutcome = "cancel_scheduled" | "no_subscription" | "not_pending_deletion" | "already_cancelling";

export interface BillingCancelOnDeletionDeps {
  readonly gateway?: Pick<StripeGateway, "setSubscriptionCancelAtPeriodEnd">;
}

/** The deterministic placeholder `WorkspacesService.create` writes for a workspace that has never been to Stripe. */
const LOCAL_SUBSCRIPTION_PREFIX = "local_sub_";

type Found = { readonly kind: "not_pending_deletion" } | { readonly kind: "no_subscription" } | { readonly kind: "already_cancelling" } | { readonly kind: "cancel"; readonly subscriptionId: string };

async function readState(pool: Pool, workspaceId: string): Promise<Found> {
  const client = await pool.connect();
  try {
    return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx: ClientBase): Promise<Found> => {
      const workspace = await tx.query<{ status: string }>("SELECT status FROM workspaces WHERE id = $1", [workspaceId]);
      if (workspace.rows[0]?.status !== "pending_deletion") return { kind: "not_pending_deletion" };
      const subscription = await tx.query<{ stripe_subscription_id: string; cancel_at_period_end: boolean }>(
        `SELECT stripe_subscription_id, cancel_at_period_end FROM subscriptions
          WHERE workspace_id = $1 AND provider = 'stripe' AND status IN ('trialing','active','past_due')
          ORDER BY created_at DESC LIMIT 1`,
        [workspaceId],
      );
      const row = subscription.rows[0];
      if (row === undefined || row.stripe_subscription_id.startsWith(LOCAL_SUBSCRIPTION_PREFIX)) return { kind: "no_subscription" };
      if (row.cancel_at_period_end) return { kind: "already_cancelling" };
      return { kind: "cancel", subscriptionId: row.stripe_subscription_id };
    });
  } finally {
    client.release();
  }
}

export function createBillingCancelOnDeletionHandler(context: QueueHandlerContext, deps: BillingCancelOnDeletionDeps = {}): JobProcessor {
  const logger = new Logger("billing.cancel_on_deletion");
  // Built on the first job, not at boot: a worker group whose Stripe key is absent must still boot.
  let gateway = deps.gateway;
  const gatewayFor = (): Pick<StripeGateway, "setSubscriptionCancelAtPeriodEnd"> => {
    gateway ??= new StripeHttpGateway({ secretKey: context.env.STRIPE_SECRET_KEY, webhookSecret: context.env.STRIPE_WEBHOOK_SECRET });
    return gateway;
  };

  return async (_tx: ClientBase, job: Job): Promise<BillingCancelOnDeletionOutcome> => {
    const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);
    const found = await readState(context.pool, payload.workspaceId);
    if (found.kind === "cancel") await gatewayFor().setSubscriptionCancelAtPeriodEnd({ subscriptionId: found.subscriptionId });
    const outcome: BillingCancelOnDeletionOutcome = found.kind === "cancel" ? "cancel_scheduled" : found.kind;
    incrementCounter("nominara_billing_cancel_on_deletion_jobs_total", { outcome });
    logger.log({ event: "billing.cancel_on_deletion.job_done", workspace_id: payload.workspaceId, outcome });
    return outcome;
  };
}
