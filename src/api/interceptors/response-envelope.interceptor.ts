import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply } from "fastify";
import type { Observable } from "rxjs";
import { map } from "rxjs/operators";
import type { EnvelopeMeta } from "../../../contracts/common/envelope.schema.js";
import { SCORING_VERSION } from "../../lib/scoring/index.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { requestIdOf } from "../../lib/telemetry/tracing.js";
import { NO_ENVELOPE_KEY } from "../decorators/no-envelope.decorator.js";
import { STREAMING_KEY } from "../decorators/streaming.decorator.js";
import { Page } from "../pagination/page.js";
import type { AuthenticatedRequest } from "../guards/auth.guard.js";

// STORY-024 T10 — AC5: api-specification.md §1's response envelope,
// `{ data, pagination?, meta: { request_id, scoring_version, computed_at } }`,
// applied at the composition root so no controller builds it by hand.
//
// *** REGISTRATION POSITION IS LOAD-BEARING — index 1, and only index 1 ***
// NestJS runs APP_INTERCEPTOR "before" logic in registration order and
// "after" logic in REVERSE. With [Idempotency, ResponseEnvelope,
// TenantContext, Audit, Credit] the "after" order is Credit, Audit,
// TenantContext, ResponseEnvelope, Idempotency, which buys exactly two
// things:
//
//   INNER to IdempotencyInterceptor — its "after" runs last and therefore
//   sees the ENVELOPE. STORY-025 requires "the store holds the response
//   envelope, not just a marker", so a replayed request returns a body
//   byte-identical to the original.
//
//   OUTER to AuditInterceptor — its "after" runs first and therefore sees
//   the RAW handler result. `resourceIdFromResponse(body)` reads `body.id`;
//   handing it `{data: {...}}` would make every audited mutation fail with
//   AuditResourceIdUnresolvedError.
//
// This ADDS to the array; it reorders nothing. composition-root.spec.ts and
// api.module.spec.ts lock the whole order.
const logger = new Logger("response-envelope");

// STORY-136 AC9 — `meta.scoring_version` is the SCORING LIBRARY's `SCORING_VERSION`, imported rather than restated.
// This file used to declare its own `"v1"`, which agreed with the library only by coincidence: bumping the library
// would have left every response claiming the old version. §1's example prints `"v1"`, which is today's value of
// the one constant. A per-request pin via `X-Nominara-Scoring-Version` (§1) is not built.

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Method first, then class: HealthController carries the marker at class
    // level so all three probes are exempt as a group.
    // STORY-026 T23 — a streaming route writes its own body to reply.raw and
    // returns nothing. Enveloping that would append a JSON object to a
    // text/event-stream response that has already been written.
    const exempt =
      this.reflector.getAllAndOverride<boolean>(NO_ENVELOPE_KEY, [context.getHandler(), context.getClass()]) === true ||
      this.reflector.getAllAndOverride<boolean>(STREAMING_KEY, [context.getHandler(), context.getClass()]) === true;

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest & { id?: string | number }>();
    const reply = http.getResponse<FastifyReply>();
    // STORY-024 AC9 — the request identifier IS the OpenTelemetry trace id;
    // an inbound `X-Request-Id` / `traceparent` does not choose it.
    const requestId = requestIdOf(request);

    // Sent whether or not the body is wrapped: a liveness probe that fails
    // is still worth correlating, and §1 makes it unconditional.
    reply.header("x-request-id", requestId);

    if (exempt) {
      incrementCounter("nominara_api_response_envelope_total", { wrapped: "false" });
      return next.handle();
    }

    return next.handle().pipe(
      map((body: unknown) => {
        // STORY-078 - a 304 Not Modified has no message body by definition (RFC 9110 section 15.4.5). Wrapping `null` in an envelope would
        // put a body on a response that must not have one and defeat the revalidation it exists for.
        if (reply.statusCode === 304) return undefined;

        const meta: EnvelopeMeta = {
          request_id: requestId,
          scoring_version: SCORING_VERSION,
          computed_at: new Date().toISOString(),
        };

        incrementCounter("nominara_api_response_envelope_total", { wrapped: "true" });

        // coding-standards.md §7 — the workspace ID, never the workspace
        // name. Names are customer data; IDs are not. There is no body
        // content in this line at all: an envelope log that echoed the
        // payload would defeat the redaction transport it sits behind.
        logger.log({
          message: "response enveloped",
          request_id: requestId,
          workspace_id: request.auth?.ws ?? null,
        });

        // STORY-117 — a list handler returns a Page, and the `pagination`
        // member §1 shows is filled in HERE, from it. Before this the member
        // was declared in the envelope schema and populated by nothing: every
        // list route sent an unbounded array and no cursor, so `NFR-API-03`
        // was unmet on every one of them while the envelope advertised the
        // shape that would have satisfied it.
        //
        // `pagination` appears on a list response and NOWHERE else — never as
        // an empty or null placeholder on a single resource, which would be a
        // member a consumer has to write a dead branch against.
        if (body instanceof Page) {
          return { data: body.data, pagination: body.pagination, meta };
        }

        // A handler returning `Promise<void>` (auth/refresh, auth/logout,
        // both verify routes, and the workspaces mutations) has no resource
        // to carry, but §1 still requires the identifier — so `data` is
        // explicitly null rather than the member being dropped, which would
        // make the envelope's own shape vary by route.
        return { data: body ?? null, meta };
      }),
    );
  }
}
