import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { LivenessResponse, ReadinessResponse } from "../../../contracts/common/health.schema.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { HealthService } from "./health.service.js";

// STORY-022 — HealthModule. @Public() on the whole controller: probes are
// unauthenticated, so WorkspaceGuard never populates req.tenant for them,
// and TenantContextInterceptor must not fail-closed on that (E-3).
@Controller("health")
@Public()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // Scenario 1 — liveness never touches Postgres; it only answers "is the process up".
  @Get("live")
  liveness(): LivenessResponse {
    return this.health.liveness();
  }

  // Scenario 2 — readiness fails (503) until the applied migration set matches this build's.
  @Get("ready")
  async readiness(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessResponse> {
    const result = await this.health.readiness();
    reply.status(result.status === "ready" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }

  // Full detail (dependencies + the reserved-empty queues array, STORY-022-E-5) at the bare path.
  @Get()
  async index(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessResponse> {
    return this.readiness(reply);
  }
}
