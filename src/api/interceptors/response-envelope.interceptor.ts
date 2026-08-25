import { randomUUID } from "node:crypto";
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply } from "fastify";
import type { Observable } from "rxjs";
import { map } from "rxjs/operators";
import type { EnvelopeMeta } from "../../../contracts/common/envelope.schema.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { NO_ENVELOPE_KEY } from "../decorators/no-envelope.decorator.js";
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

// §1's example prints `"scoring_version": "v1"`, and `v1` is the DEFAULT on
// every scoring_version column in the schema (six tables, migrations 0002-0004).
// A per-response scoring version arrives with the analytics endpoints, which
// pin reads via the `X-Nominara-Scoring-Version` request header (§1); until
// one exists there is exactly one value the API computes under, and claiming
// otherwise would be a fiction.
export const SCORING_VERSION = "v1";

/** §1: "`X-Request-Id` — optional. Echoed in responses and logs; generated if absent." */
function requestIdOf(request: AuthenticatedRequest & { id?: string | number }): string {
  const supplied = request.headers?.["x-request-id"];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  if (typeof value === "string" && value.length > 0) return value;
  if (request.id !== undefined) return String(request.id);
  return randomUUID();
}

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Method first, then class: HealthController carries the marker at class
    // level so all three probes are exempt as a group.
    const exempt =
      this.reflector.getAllAndOverride<boolean>(NO_ENVELOPE_KEY, [context.getHandler(), context.getClass()]) === true;

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest & { id?: string | number }>();
    const reply = http.getResponse<FastifyReply>();
    const requestId = requestIdOf(request);

    // Echoed whether or not the body is wrapped: a liveness probe that fails
    // is still worth correlating, and §1 makes the echo unconditional.
    reply.header("x-request-id", requestId);

    if (exempt) {
      incrementCounter("nominara_api_response_envelope_total", { wrapped: "false" });
      return next.handle();
    }

    return next.handle().pipe(
      map((body: unknown) => {
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
          return { data: body.items, pagination: body.pagination, meta };
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
