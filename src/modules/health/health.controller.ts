import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { LivenessResponse, ReadinessResponse } from "../../../contracts/common/health.schema.js";
import { NoEnvelope } from "../../api/decorators/no-envelope.decorator.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { HealthService } from "./health.service.js";

// STORY-022 — HealthModule. @Public() on the whole controller: probes are
// unauthenticated, so WorkspaceGuard never populates req.tenant for them,
// and TenantContextInterceptor must not fail-closed on that (E-3).
// STORY-024 T10 — @NoEnvelope() is the response envelope's ONLY exemption,
// and these three probes are the only routes that carry it. An orchestrator
// reads `status` at the TOP level; livenessResponseSchema is `.strict()` with
// exactly `{status}`, so a wrapped body is not a cosmetic difference — it is
// a probe that never reports healthy again, which would break EPIC-03's own
// first acceptance criterion.
//
// The marker is deliberately NOT keyed on @Public() above it: @Public() sits
// on seven real authentication routes whose responses §1 requires to carry
// the envelope. See test/integration/envelope-scope-and-probe-exemption.spec.ts,
// which asserts both halves.
@Controller("health")
@Public()
@NoEnvelope()
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
