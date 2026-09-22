import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { canonicalUuid, isNonCanonicalUuidSpelling } from "../canonical-uuid.js";
import { ValidationFailedError } from "../errors/domain-errors.js";

// STORY-150 — one canonical form for a uuid path parameter, decided once,
// before anything reads it.
//
// ⚠ RFC 4122 UUIDS ARE CASE-INSENSITIVE ON INPUT AND LOWERCASE ON OUTPUT, and
// this codebase had no place that said so. Postgres knows it — a `uuid` column
// lowercases whatever it is given — so the database and the application
// disagreed about what a request's id WAS, and everything that compared,
// hashed or keyed on the raw path param inherited the disagreement:
//
//   · `assertMatchesTenant` (src/tenancy/assert-matches-tenant.ts) compares the
//     url's workspace id to the token's with `!==`. The token's comes from the
//     database and is canonical, so an uppercase workspace id in the path gave
//     a caller 404 ON THEIR OWN WORKSPACE. Four live callers in
//     workspaces.controller.ts. THIS IS THE ONE LIVE HTTP INSTANCE, and the
//     review found that the first draft of this comment named two that were
//     not: `EntitlementGuard` hands its param to Postgres as a bind parameter
//     against a `uuid` column, where case never mattered, and `AuditInterceptor`
//     was already made safe by STORY-149's `$3::uuid::text`. Both are real
//     readers of a raw param; neither was ever broken by it.
//   · `RbacGuard.assertInScope` compares against a canonical scope list, so an
//     uppercase param refuses a member their own project — but `@ProjectParam`
//     appears on ZERO production controllers, so this is unreachable over HTTP.
//     Its one live path is the realtime gateway, which does not run this chain
//     and canonicalises at its own entry instead (realtime.gateway.ts's
//     joinProject). Said plainly because the first draft led with this one.
//   · The idempotency fingerprint, which this does NOT fix: it is built from
//     the url, never from `req.params`. Fixed in src/api/idempotency/key.ts,
//     and it needed a different mechanism — see the note there.
//
// ⚠ A GUARD, WHICH IS NOT WHERE THIS OBVIOUSLY BELONGS, FOR A REASON WORTH
// WRITING DOWN. The natural home is a Fastify `preHandler` hook — but
// `fastifyServerOptions()` cannot carry a hook, and this repository constructs
// `new FastifyAdapter(...)` in dozens of places, of which main.ts is one. A
// hook registered at the bootstrap would be absent from all the others, so
// every test would exercise a configuration production does not have. That is
// the STORY-140 defect exactly: boot wiring nothing can fail on.
//
// Nest's guard chain is the only PRE-HANDLER stage that `ApiModule` itself
// registers, so every app built from this module gets this whether its
// bootstrap knows about it or not. It must be FIRST in the APP_GUARD array —
// `api.module.spec.ts` asserts that, because being second to `RbacGuard` would
// make it silently useless.
//
// ⚠ ONLY AN EXACT UUID IS TOUCHED. Other path params are slugs, provider names
// and share tokens, and lowercasing one of those would change what it
// identifies. This lowercases a value only when the whole value is a uuid, in
// which case the lowercase form denotes the same id by definition.

/**
 * Canonicalises in place, or throws for a spelling we will not interpret.
 *
 * Exported so a test can assert on the object a handler will actually see —
 * the boolean this used to return was read by nothing, and an assertion on a
 * value production discards is an assertion with no subject.
 */
export function canonicaliseParams(params: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== "string") continue;
    if (isNonCanonicalUuidSpelling(value)) {
      throw new ValidationFailedError({
        message: `path parameter "${name}" is a uuid written in a form this API does not accept; use the canonical 8-4-4-4-12 form`,
        details: { issues: [{ path: [name], message: "must be a canonical 8-4-4-4-12 uuid" }] },
      });
    }
    params[name] = canonicalUuid(value);
  }
}

@Injectable()
export class CanonicalParamsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // ⚠ HTTP ONLY. The realtime gateway builds its own `request.params`
    // (src/gateway/room-authorization.service.ts) and does not run this chain;
    // a ws context has no `switchToHttp().getRequest()` shaped like this.
    if (context.getType() !== "http") return true;

    const request = context.switchToHttp().getRequest<{ params?: Record<string, unknown> }>();
    if (request.params) canonicaliseParams(request.params);
    // Refuses nothing. A uuid in the wrong case is a valid uuid, and RFC 4122
    // says so — rejecting it would break a correct client to fix our own
    // inconsistency.
    return true;
  }
}
