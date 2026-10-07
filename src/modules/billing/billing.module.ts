import { Module } from "@nestjs/common";
import { loadEnv } from "../../config/env.js";
import { STRIPE_GATEWAY, type StripeGateway } from "../../lib/billing/stripe/stripe-gateway.js";
import { StripeHttpGateway } from "../../lib/billing/stripe/stripe-http.gateway.js";
import { BillingController } from "./billing.controller.js";
import { BillingService } from "./billing.service.js";
import { STRIPE_EVENT_HANDLERS, type StripeEventHandler } from "./stripe-event-handler.js";
import { StripeWebhookController } from "./stripe-webhook.controller.js";
import { StripeWebhookService } from "./stripe-webhook.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
@Module({
  controllers: [BillingController, StripeWebhookController],
  providers: [
    BillingService,
    StripeWebhookService,
    {
      provide: STRIPE_GATEWAY,
      useFactory: (): StripeGateway => {
        const env = loadEnv();
        return new StripeHttpGateway({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
      },
    },
    // NEW-D-2 ships the ingress with no effect. STORY-075a / 076a replace this
    // with a factory that collects their handlers.
    { provide: STRIPE_EVENT_HANDLERS, useValue: [] satisfies StripeEventHandler[] },
  ],
  exports: [STRIPE_GATEWAY],
})
export class BillingModule {}
