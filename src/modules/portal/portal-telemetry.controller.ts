import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import {
  portalTelemetryRequestSchema,
  portalTelemetryResponseSchema,
  type PortalTelemetryRequest,
  type PortalTelemetryResponse,
} from "../../../contracts/portal/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { PortalRoute, PortalSession, type PortalSessionContext } from "../../api/decorators/portal-route.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { PortalTelemetryService } from "./portal-telemetry.service.js";

// Owner decision 71 (c) — POST /portal/telemetry. The ONE write a portal visitor can cause, and it is not a portal-role write:
// the portal transaction is READ ONLY, so the service records on the app pool in its own short tenant transaction for the
// cookie's workspace. The cookie, not the request, says whose view it is.
@Controller("portal")
export class PortalTelemetryController {
  constructor(private readonly telemetry: PortalTelemetryService) {}

  @Post("telemetry")
  @HttpCode(200)
  @PortalRoute()
  @ApiContract({ operationId: "recordPortalTelemetry", requestSchema: portalTelemetryRequestSchema, responseSchema: portalTelemetryResponseSchema })
  record(
    @PortalSession() session: PortalSessionContext,
    @Body(new ZodValidationPipe(portalTelemetryRequestSchema)) body: PortalTelemetryRequest,
  ): Promise<PortalTelemetryResponse> {
    return this.telemetry.record(session, body.tab);
  }
}
