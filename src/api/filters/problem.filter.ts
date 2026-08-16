import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { FastifyReply } from "fastify";

// STORY-022 — minimal stub only. The full ISO-08 problem-details taxonomy
// (402 insufficient_credits, 403 entitlement_exceeded, 403
// feature_not_in_plan, 429 quota_exceeded, 429 daily_limit_reached, 403
// naming the permission never 404, ...) needs real Auth/Workspace/Rbac/
// Entitlement guard logic to have anything to map FROM — deferred to
// STORY-018/019 and the guards' own future stories (E-3). This stub only
// makes the composition root's `handler -> ... -> ProblemFilter` slot exist
// and return a well-formed body, so nothing downstream needs to change
// shape when the real mapping lands.
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const detail = exception instanceof HttpException ? exception.message : "internal server error";

    reply.status(status).send({
      type: "about:blank",
      status,
      title: HttpStatus[status] ?? "error",
      detail,
    });
  }
}
