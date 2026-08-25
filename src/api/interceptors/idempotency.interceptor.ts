import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply } from "fastify";
import { from, lastValueFrom, of, type Observable } from "rxjs";
import {
  IDEMPOTENCY_REPLAYED_HEADER,
  idempotencyKeySchema,
} from "../../../contracts/common/idempotency.schema.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { IDEMPOTENT_KEY } from "../decorators/idempotent.decorator.js";
import { ConflictError, IdempotencyConflictError, ValidationFailedError } from "../errors/domain-errors.js";
import type { AuthenticatedRequest } from "../guards/auth.guard.js";
import { identifyIdempotentRequest } from "../idempotency/key.js";
import { IdempotencyStore } from "../idempotency/store.js";

// STORY-025 T16 — replaces STORY-022's pass-through no-op.
//
// `NFR-API-07`: "`Idempotency-Key` is ENFORCED, not merely accepted, on every
// endpoint that spends credits, calls an external system, or mints a secret.
// A replayed credit-spending request returns the original result and debits
// NOTHING additional."
//
// *** REGISTRATION POSITION IS LOAD-BEARING — index 0, and only index 0. ***
// NestJS runs APP_INTERCEPTOR "before" logic in registration order and
// "after" logic in REVERSE, so registering first buys two things that nothing
// else can:
//
//   The "after" runs LAST, so what is stored is the finished ENVELOPE rather
//   than the handler's return value. STORY-025 AC2 requires a replay to be
//   byte-identical, and byte-identical means the bytes the client received.
//
//   The "before" runs FIRST, so a replay short-circuits before
//   ResponseEnvelopeInterceptor is ever reached. The stored body is returned
//   exactly as recorded — re-enveloping it would stamp a fresh request_id and
//   computed_at into a body that is supposed to be a recording.
//
// api.module.spec.ts and composition-root.spec.ts lock the whole order.

const logger = new Logger("idempotency");

/** §1's header name, lower-cased because that is how Fastify presents it. */
const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

interface IdempotentRequest extends AuthenticatedRequest {
  url?: string;
  body?: unknown;
}

function headerValue(request: IdempotentRequest, name: string): string | undefined {
  const raw = request.headers?.[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: IdempotencyStore,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const required =
      this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [context.getHandler(), context.getClass()]) === true;
    if (!required) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<IdempotentRequest>();
    const reply = http.getResponse<FastifyReply>();

    const key = headerValue(request, IDEMPOTENCY_KEY_HEADER);
    const parsedKey = idempotencyKeySchema.safeParse(key);
    if (!parsedKey.success) {
      // ENFORCED, not accepted: a billable route reached without a key is
      // refused rather than executed unprotected. §2 has no code for "a
      // required header is missing", and inventing one would put a value on
      // the wire the specification does not contain — so this is the ordinary
      // request-validation failure it actually is, naming the header.
      incrementCounter("nominara_api_idempotency_replay_total", { outcome: "key_missing" });
      throw new ValidationFailedError({
        message: `${IDEMPOTENCY_KEY_HEADER} is required on this route and must be 1-255 characters`,
        details: { issues: [{ path: [IDEMPOTENCY_KEY_HEADER], message: "required" }] },
      });
    }

    const workspaceId = request.auth?.ws;
    const userId = request.auth?.sub;
    if (!workspaceId || !userId) {
      // Fail closed, the same stance TenantContextInterceptor takes. The
      // record lives under a tenant-scoped key; without a workspace there is
      // no key to write that is not a cross-tenant key, and executing the
      // request unprotected would be worse than refusing it.
      incrementCounter("nominara_api_idempotency_replay_total", { outcome: "unscoped" });
      throw new ConflictError({
        message: "an idempotent route requires an authenticated workspace-scoped caller",
        details: { current_state: "unscoped" },
      });
    }

    const identity = identifyIdempotentRequest(
      {
        env: process.env.NODE_ENV ?? "development",
        workspaceId,
        userId,
        method: request.method ?? "POST",
        url: request.url ?? "",
        body: request.body,
      },
      parsedKey.data,
    );

    const startedAt = new Date().toISOString();
    const claimed = await this.store.claim(identity.cacheKey, identity.requestHash, startedAt);

    if (claimed) {
      return from(this.runAndRecord(identity.cacheKey, identity.requestHash, reply, next));
    }

    const stored = await this.store.read(identity.cacheKey);

    if (stored === undefined) {
      // The record was evicted between the failed claim and this read — the
      // cache runs allkeys-lru, so this is possible rather than theoretical.
      // Degrade to executing: at-least-once beats refusing a request whose
      // record simply is not there any more. Logged because a burst of these
      // means the cache is undersized, which is an operational fact worth
      // seeing rather than a silent loss of protection.
      logger.warn({
        message: "idempotency record vanished between claim and read",
        workspace_id: workspaceId,
        key_hash: identity.keyHash,
      });
      incrementCounter("nominara_api_idempotency_replay_total", { outcome: "record_evicted" });
      return next.handle();
    }

    if (stored.request_hash !== identity.requestHash) {
      // §1: "identical key + different body is `409 idempotency_conflict`."
      // The detail carries HASHES only — the first request under this key may
      // belong to a different session, and echoing its body back to whoever
      // presents the key would make this response an oracle.
      incrementCounter("nominara_api_idempotency_replay_total", { outcome: "conflict" });
      logger.warn({
        message: "idempotency key reused with a different body",
        workspace_id: workspaceId,
        key_hash: identity.keyHash,
      });
      throw new IdempotencyConflictError({
        message: "this Idempotency-Key was already used with a different request body",
        details: {
          key_hash: identity.keyHash,
          original_request_hash: stored.request_hash,
          original_recorded_at: stored.state === "completed" ? stored.recorded_at : stored.started_at,
        },
      });
    }

    if (stored.state === "in_flight") {
      // The original is still running. Refusing is the honest answer: holding
      // this request open would tie up a connection for the original's whole
      // duration, and returning a fabricated success would be a lie about an
      // effect that has not happened yet. The client retries and gets the
      // recorded response.
      incrementCounter("nominara_api_idempotency_replay_total", { outcome: "in_flight" });
      throw new ConflictError({
        message: "a request with this Idempotency-Key is already in flight; retry shortly",
        details: { current_state: "in_flight" },
      });
    }

    // A genuine replay. Decision D6's header is what lets a client tell "my
    // retry was absorbed" from "it ran again and produced the same answer" —
    // those call for different reporting in a UI.
    //
    // The body is returned EXACTLY as recorded, so `meta.request_id` inside it
    // is the ORIGINAL request's trace, not this one's. That is deliberate and
    // is the point of AC2: it is a recording. The current request's own
    // identifier still reaches the client on `x-request-id`, so both traces
    // are reachable, and `Idempotency-Replayed` says which is which.
    incrementCounter("nominara_api_idempotency_replay_total", { outcome: "replayed" });
    reply.header(IDEMPOTENCY_REPLAYED_HEADER, "true");
    reply.status(stored.status_code);
    return of(stored.response_body);
  }

  private async runAndRecord(
    cacheKey: string,
    requestHash: string,
    reply: FastifyReply,
    next: CallHandler,
  ): Promise<unknown> {
    try {
      const body = await lastValueFrom(next.handle());
      await this.store.complete(cacheKey, {
        requestHash,
        statusCode: reply.statusCode,
        responseBody: body,
        recordedAt: new Date().toISOString(),
      });
      incrementCounter("nominara_api_idempotency_replay_total", { outcome: "recorded" });
      return body;
    } catch (error) {
      // A failed request has no response worth replaying, and leaving the
      // claim would lock the key for the full 24-hour window — so a client
      // retrying after a transient failure would be refused for a day.
      await this.store.release(cacheKey);
      incrementCounter("nominara_api_idempotency_replay_total", { outcome: "released" });
      throw error;
    }
  }
}
