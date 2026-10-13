import { Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";
import { loadEnv } from "../../config/env.js";
import { STRIPE_GATEWAY, type StripeGateway } from "../../lib/billing/stripe/stripe-gateway.js";
import { StripeHttpGateway } from "../../lib/billing/stripe/stripe-http.gateway.js";
import { BILLING_WRITE_POOL, createBillingWritePool } from "./billing-write-pool.js";
import { BillingAddonsController } from "./billing-addons.controller.js";
import { BillingAddonsService } from "./billing-addons.service.js";
import { BillingInvoicesController } from "./billing-invoices.controller.js";
import { BillingInvoicesService } from "./billing-invoices.service.js";
import { IdentityModule } from "../identity/identity.module.js";
import { AutoTopupService } from "./auto-topup.service.js";
import { BillingSubscriptionController } from "./billing-subscription.controller.js";
import { BillingSubscriptionService } from "./billing-subscription.service.js";
import { CreditPacksController } from "./credit-packs.controller.js";
import { CreditPacksService } from "./credit-packs.service.js";
import { BillingUsageController } from "./billing-usage.controller.js";
import { BillingController } from "./billing.controller.js";
import { BillingService } from "./billing.service.js";
import { STRIPE_EVENT_HANDLERS, type StripeEventHandler } from "./stripe-event-handler.js";
import { StripeCreditPackHandler } from "./stripe-credit-pack.handler.js";
import { StripeInvoiceHandler } from "./stripe-invoice.handler.js";
import { StripeSubscriptionHandler } from "./stripe-subscription.handler.js";
import { StripeWebhookController } from "./stripe-webhook.controller.js";
import { StripeWebhookService } from "./stripe-webhook.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
@Module({
  imports: [IdentityModule],
  controllers: [BillingController, BillingUsageController, CreditPacksController, BillingSubscriptionController, BillingInvoicesController, BillingAddonsController, StripeWebhookController],
  providers: [
    // The short independent writes of checkout, the credit-pack purchase and add-ons run here, never on the
    // main pool their request already holds a connection of (hold-and-wait).
    { provide: BILLING_WRITE_POOL, useFactory: (): Pool => createBillingWritePool(loadEnv().DATABASE_URL_POOLED) },
    BillingService,
    BillingSubscriptionService,
    CreditPacksService,
    BillingInvoicesService,
    BillingAddonsService,
    StripeInvoiceHandler,
    AutoTopupService,
    StripeSubscriptionHandler,
    StripeCreditPackHandler,
    StripeWebhookService,
    {
      provide: STRIPE_GATEWAY,
      useFactory: (): StripeGateway => {
        const env = loadEnv();
        return new StripeHttpGateway({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
      },
    },
    // The webhook's effects: subscriptions (075a), credit packs (076a), invoices (075b).
    {
      provide: STRIPE_EVENT_HANDLERS,
      useFactory: (subscriptions: StripeSubscriptionHandler, creditPacks: StripeCreditPackHandler, invoices: StripeInvoiceHandler): StripeEventHandler[] => [
        subscriptions,
        creditPacks,
        invoices,
      ],
      inject: [StripeSubscriptionHandler, StripeCreditPackHandler, StripeInvoiceHandler],
    },
  ],
  exports: [BillingService, AutoTopupService, BillingInvoicesService, STRIPE_GATEWAY],
})
export class BillingModule implements OnModuleDestroy {
  constructor(@Inject(BILLING_WRITE_POOL) private readonly writePool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.writePool.end();
  }
}
