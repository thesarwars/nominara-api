import { Controller, Get, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { engineStatusResponseSchema, type EngineStatusResponse } from "../../../contracts/engines/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { HealthService } from "./health.service.js";

// STORY-031 AC11 - the customer-facing per-engine status read, so a customer can tell a platform problem from a vendor one
// (EC-06: "the engine renders with a warning glyph everywhere it appears"). Any member (`workspace:read`); the body is global, so
// it is cacheable per viewer for a short while. The realtime `engine.degraded` event stays the push channel; this is first paint.
// Not on HealthController: that one is @Public and unenveloped, and this is an ordinary authenticated, enveloped product route.
@Controller("engines")
export class EnginesStatusController {
  constructor(private readonly health: HealthService) {}

  @Get("status")
  @RequirePermission("workspace:read")
  @ApiContract({ operationId: "getEngineStatus", responseSchema: engineStatusResponseSchema })
  async status(@Res({ passthrough: true }) reply: FastifyReply): Promise<EngineStatusResponse> {
    reply.header("Cache-Control", "private, max-age=30");
    return this.health.engineStatus();
  }
}
