import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { connect, withKeepalives } from "../../../db/client.js";
import { runStripeDriftCheck, type DriftResult, type LocalStripeSubscription } from "../../billing/stripe-drift.js";
import { StripeHttpGateway } from "../../billing/stripe/stripe-http.gateway.js";
import type { StripeGateway } from "../../billing/stripe/stripe-gateway.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import type { QueueHandlerContext } from "../handlers.js";
import { withoutPooledClient, type JobProcessor } from "../worker-factory.js";

// STORY-075 AC11 / owner decision 2026-10-28 section 100(e) - `billing.stripe_drift`: the nightly Stripe-versus-local drift check.
// ALERT ONLY, NEVER WRITES (see `lib/billing/stripe-drift.ts`).
//
// THE OWNER CONNECTION, read-only, one short connection PER PAGE and released before any Stripe call: `subscriptions` carries
// FORCE ROW LEVEL SECURITY, so the pooled runtime role would see zero rows and report a clean estate. Nothing is held across the
// ALERT HOOKS: the repo keeps no ops alert-rule definitions (`alert-rules/` is the product-alert catalog, scoring-models section 15), so as with `credit.verify`
// the hooks are the metrics and error-level logs: `nominara_billing_stripe_drift_total{field}` > 0, `nominara_billing_stripe_drift_runs_total{outcome="degraded"}`,
// and the `stripe_drift_skipped` / `stripe_drift_degraded` error lines. Wire them when the pager exists (decision 45).
// network (KAD-06), and the processor opts OUT of the worker factory's pre-acquired pooled client (`withoutPooledClient`), so no pooled connection
// is pinned for the run either. Not signed-tenant: the tick names no workspace. Idempotent by construction (reads and counters only).

export interface BillingStripeDriftDeps {
  readonly gateway?: Pick<StripeGateway, "fetchObject" | "isConfigured">;
}

interface Row {
  id: string;
  workspace_id: string;
  stripe_subscription_id: string;
  plan_key: string;
  status: string;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  trial_ends_at: Date | null;
  billing_interval: string;
  seats_purchased: number;
  projects_purchased: number;
}

export function createBillingStripeDriftHandler(context: QueueHandlerContext, deps: BillingStripeDriftDeps = {}): JobProcessor {
  const logger = new Logger("billing.stripe_drift");
  let gateway = deps.gateway;
  const gatewayFor = (): Pick<StripeGateway, "fetchObject" | "isConfigured"> => {
    gateway ??= new StripeHttpGateway({ secretKey: context.env.STRIPE_SECRET_KEY, webhookSecret: context.env.STRIPE_WEBHOOK_SECRET });
    return gateway;
  };

  const loadPage = async (afterId: string | null, limit: number): Promise<LocalStripeSubscription[]> => {
    const client = await connect(withKeepalives(context.env.DATABASE_URL));
    try {
      // `local_sub_*` is the placeholder a workspace that never reached Stripe carries; migration 0026: filter provider = 'stripe'.
      const result = await client.query<Row>(
        `SELECT id, workspace_id, stripe_subscription_id, plan_key, status, current_period_start, current_period_end,
                cancel_at_period_end, trial_ends_at, billing_interval, seats_purchased, projects_purchased
           FROM subscriptions
          WHERE provider = 'stripe' AND stripe_subscription_id NOT LIKE 'local\\_sub\\_%' AND ($1::uuid IS NULL OR id > $1::uuid)
          ORDER BY id LIMIT $2`,
        [afterId, limit],
      );
      return result.rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        planKey: row.plan_key,
        status: row.status,
        currentPeriodStart: row.current_period_start,
        currentPeriodEnd: row.current_period_end,
        cancelAtPeriodEnd: row.cancel_at_period_end,
        trialEndsAt: row.trial_ends_at,
        billingInterval: row.billing_interval,
        seatsPurchased: row.seats_purchased,
        projectsPurchased: row.projects_purchased,
      }));
    } finally {
      await client.end();
    }
  };

  return withoutPooledClient(async (_client: ClientBase, _job: Job): Promise<DriftResult | null> => {
    const port = gatewayFor();
    if (!port.isConfigured()) {
      incrementCounter("nominara_billing_stripe_drift_skipped_total", { reason: "stripe_not_configured" });
      // In production a silently skipped drift check is a blind spot, not a configuration choice: error level, so it pages.
      const line = { event: "stripe_drift_skipped", reason: "stripe_not_configured" };
      if (context.env.NODE_ENV === "production") logger.error(line);
      else logger.warn(line);
      return null;
    }
    return runStripeDriftCheck({ loadPage, gateway: port });
  });
}
