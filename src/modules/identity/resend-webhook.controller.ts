import { Controller, HttpCode, Post, Req } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import { resendWebhookResponseSchema, type ResendWebhookResponse } from "../../../contracts/identity/resend-webhook.schema.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import type { RawBodyRequest } from "../../api/stripe-raw-body.js";
import { ResendWebhookService } from "./resend-webhook.service.js";

const headerOf = (value: string | string[] | undefined): string | undefined => (typeof value === "string" ? value : undefined);

// STORY-178 AC1 — Public (Resend has no session) and tenant-less (an address bounced for the platform, not for a workspace).
// The authentication IS the Svix signature over the raw body — see ResendWebhookService. No logic here.
@Controller("webhooks")
export class ResendWebhookController {
  constructor(private readonly service: ResendWebhookService) {}

  @Post("resend")
  @HttpCode(200)
  @Public()
  @SkipTenantContext()
  @RouteConfig({ rawBody: true })
  @ApiContract({ operationId: "receiveResendWebhook", responseSchema: resendWebhookResponseSchema })
  receive(@Req() req: RawBodyRequest): Promise<ResendWebhookResponse> {
    return this.service.handle(req.rawBody, {
      id: headerOf(req.headers["svix-id"]),
      timestamp: headerOf(req.headers["svix-timestamp"]),
      signature: headerOf(req.headers["svix-signature"]),
    });
  }
}
