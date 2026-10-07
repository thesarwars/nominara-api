import { Controller, HttpCode, Post, Req } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import type { StripeWebhookResponse } from "../../../contracts/billing/index.js";
import { stripeWebhookResponseSchema } from "../../../contracts/billing/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import type { RawBodyRequest } from "../../api/stripe-raw-body.js";
import { StripeWebhookService } from "./stripe-webhook.service.js";

// NEW-D-2 — STORY-075 AC2. Public (Stripe has no session) and tenant-less (the
// workspace is resolved from the re-fetched object, inside the service). The
// authentication IS the signature over the raw body — see StripeWebhookService.
@Controller("webhooks")
export class StripeWebhookController {
  constructor(private readonly service: StripeWebhookService) {}

  @Post("stripe")
  @HttpCode(200)
  @Public()
  @SkipTenantContext()
  @RouteConfig({ rawBody: true })
  @ApiContract({ operationId: "receiveStripeWebhook", responseSchema: stripeWebhookResponseSchema })
  receive(@Req() req: RawBodyRequest): Promise<StripeWebhookResponse> {
    const signature = req.headers["stripe-signature"];
    return this.service.handle(req.rawBody, typeof signature === "string" ? signature : undefined);
  }
}
