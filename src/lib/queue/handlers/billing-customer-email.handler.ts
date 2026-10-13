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

// STORY-021 (ownership transfer) — `billing.customer_email`: point the workspace's Stripe customer at its CURRENT owner's
// email. The customer is the same customer; nothing else about the subscription changes.
//
// A SIGNED TENANT job: `createJobProcessor` verified the signature before this ran and before any context was set, so
// `payload.workspaceId` is the only workspace this handler acts on. The payload is `.strict()` and carries IDS ONLY —
// never an address. The address and the customer are read here, live, so:
//   * a redelivery converges (setting the same email twice is a no-op at Stripe);
//   * a job that outlived a SECOND transfer sees that the owner is no longer the one it was enqueued for and does
//     nothing — the newer transfer has its own job — rather than writing a stale address over the current one.
//
// ⚠ `tx` IS DELIBERATELY NOT USED, as in billing.auto_topup: the two reads run in their own short tenant transaction,
// which is released BEFORE the Stripe call (KAD-06: no transaction held across an external call).

const payloadSchema = z.object({ workspaceId: z.string().uuid(), kid: z.string(), ownerUserId: z.string().uuid() }).strict();

export type BillingCustomerEmailOutcome = "updated" | "stale_owner" | "no_stripe_customer" | "no_owner";

export interface BillingCustomerEmailDeps {
  readonly gateway?: Pick<StripeGateway, "updateCustomerBillingEmail">;
}

/** The deterministic placeholder `WorkspacesService.create` writes for a workspace that has never been to Stripe. */
const LOCAL_CUSTOMER_PREFIX = "local_cus_";

async function readOwnerAndCustomer(pool: Pool, workspaceId: string): Promise<{ ownerId: string; email: string; customerId: string } | "no_owner" | "no_customer"> {
  const client = await pool.connect();
  try {
    return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx: ClientBase) => {
      const owner = await tx.query<{ user_id: string; email: string }>(
        `SELECT m.user_id, u.email::text AS email FROM workspace_members m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1 AND m.role = 'owner' AND m.status = 'active' AND u.deleted_at IS NULL`,
        [workspaceId],
      );
      const subscription = await tx.query<{ stripe_customer_id: string }>(
        `SELECT stripe_customer_id FROM subscriptions WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [workspaceId],
      );
      const o = owner.rows[0];
      if (o === undefined) return "no_owner" as const;
      const customerId = subscription.rows[0]?.stripe_customer_id;
      if (customerId === undefined || customerId.startsWith(LOCAL_CUSTOMER_PREFIX)) return "no_customer" as const;
      return { ownerId: o.user_id, email: o.email, customerId };
    });
  } finally {
    client.release();
  }
}

export function createBillingCustomerEmailHandler(context: QueueHandlerContext, deps: BillingCustomerEmailDeps = {}): JobProcessor {
  const logger = new Logger("billing.customer_email");
  // Built on the first job, not at boot: a worker group whose Stripe key is absent must still boot.
  let gateway = deps.gateway;
  const gatewayFor = (): Pick<StripeGateway, "updateCustomerBillingEmail"> => {
    gateway ??= new StripeHttpGateway({ secretKey: context.env.STRIPE_SECRET_KEY, webhookSecret: context.env.STRIPE_WEBHOOK_SECRET });
    return gateway;
  };

  return async (_tx: ClientBase, job: Job): Promise<BillingCustomerEmailOutcome> => {
    const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);
    const found = await readOwnerAndCustomer(context.pool, payload.workspaceId);
    const outcome: BillingCustomerEmailOutcome =
      found === "no_owner" ? "no_owner" : found === "no_customer" ? "no_stripe_customer" : found.ownerId !== payload.ownerUserId ? "stale_owner" : "updated";

    if (outcome === "updated" && typeof found === "object") {
      await gatewayFor().updateCustomerBillingEmail({ customerId: found.customerId, email: found.email });
    }
    incrementCounter("nominara_billing_customer_email_jobs_total", { outcome });
    logger.log({ event: "billing.customer_email.job_done", workspace_id: payload.workspaceId, outcome });
    return outcome;
  };
}
