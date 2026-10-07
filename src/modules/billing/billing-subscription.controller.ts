import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import {
  checkoutSessionRequestSchema,
  checkoutSessionResponseSchema,
  portalSessionRequestSchema,
  portalSessionResponseSchema,
  subscriptionSchema,
  type CheckoutSessionRequest,
  type CheckoutSessionResponse,
  type PortalSessionResponse,
  type Subscription,
} from "../../../contracts/billing/index.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { BillingSubscriptionService } from "./billing-subscription.service.js";

// STORY-075a — api-specification.md §3's subscription routes. Both session
// routes are billing:write (owner and admin); the read is billing:read.
@Controller("billing")
export class BillingSubscriptionController {
  constructor(private readonly service: BillingSubscriptionService) {}

  @Get("subscription")
  @RequirePermission("billing:read")
  @ApiContract({ operationId: "getSubscription", responseSchema: subscriptionSchema })
  subscription(): Promise<Subscription> {
    return this.service.subscription();
  }

  @Post("checkout-session")
  @HttpCode(200)
  @Idempotent()
  @RequirePermission("billing:write")
  @Audit({ action: "billing.checkout_session.created", resourceType: "workspace", resourceIdFrom: "workspace" })
  @ApiContract({
    operationId: "createCheckoutSession",
    requestSchema: checkoutSessionRequestSchema,
    responseSchema: checkoutSessionResponseSchema,
  })
  checkout(@Body(new ZodValidationPipe(checkoutSessionRequestSchema)) body: CheckoutSessionRequest): Promise<CheckoutSessionResponse> {
    return this.service.checkout(body);
  }

  @Post("portal-session")
  @HttpCode(200)
  @RequirePermission("billing:write")
  @Audit({ action: "billing.portal_session.created", resourceType: "workspace", resourceIdFrom: "workspace" })
  @ApiContract({
    operationId: "createPortalSession",
    requestSchema: portalSessionRequestSchema,
    responseSchema: portalSessionResponseSchema,
  })
  portal(@Body(new ZodValidationPipe(portalSessionRequestSchema)) _body: Record<string, never>): Promise<PortalSessionResponse> {
    return this.service.portal();
  }
}
