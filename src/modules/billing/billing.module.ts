import { Module } from "@nestjs/common";
import { loadEnv } from "../../config/env.js";
import { STRIPE_GATEWAY, type StripeGateway } from "../../lib/billing/stripe/stripe-gateway.js";
import { StripeHttpGateway } from "../../lib/billing/stripe/stripe-http.gateway.js";
import { BillingSubscriptionController } from "./billing-subscription.controller.js";
import { BillingSubscriptionService } from "./billing-subscription.service.js";
import { BillingController } from "./billing.controller.js";
import { BillingService } from "./billing.service.js";
import { STRIPE_EVENT_HANDLERS, type StripeEventHandler } from "./stripe-event-handler.js";
import { StripeSubscriptionHandler } from "./stripe-subscription.handler.js";
import { StripeWebhookController } from "./stripe-webhook.controller.js";
import { StripeWebhookService } from "./stripe-webhook.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
@Module({
  controllers: [BillingController, BillingSubscriptionController, StripeWebhookController],
  providers: [
    BillingService,
    BillingSubscriptionService,
    StripeSubscriptionHandler,
    StripeWebhookService,
    {
      provide: STRIPE_GATEWAY,
      useFactory: (): StripeGateway => {
        const env = loadEnv();
        return new StripeHttpGateway({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
      },
    },
    // The webhook's effects. STORY-076a adds its handler to this list.
    {
      provide: STRIPE_EVENT_HANDLERS,
      useFactory: (subscriptions: StripeSubscriptionHandler): StripeEventHandler[] => [subscriptions],
      inject: [StripeSubscriptionHandler],
    },
  ],
  exports: [STRIPE_GATEWAY],
})
export class BillingModule {}
