import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { canonicalUuid } from "../canonical-uuid.js";

// STORY-150 — one canonical form for a uuid path parameter, decided once,
// before anything reads it.
//
// ⚠ RFC 4122 UUIDS ARE CASE-INSENSITIVE ON INPUT AND LOWERCASE ON OUTPUT, and
// this codebase had no place that said so. Postgres knows it — a `uuid` column
// lowercases whatever it is given — so the database and the application
// disagreed about what a request's id WAS, and everything that compared,
// hashed or keyed on the raw path param inherited the disagreement:
//
//   · `RbacGuard` checks `scope.includes(projectId)` against a scope list read
//     from the database, which is canonical. An uppercase path param misses
//     it, so a project-scoped member is refused their OWN project. Fail-closed,
//     so not a hole — but a 403 on a legitimate request, and a confusing one.
//   · `EntitlementGuard` reads the same param for project-scoped entitlements.
//   · `AuditInterceptor` reads it for `resource_id`. STORY-149 stopped that
//     from breaking a tenant's hash chain by canonicalising inside the append;
//     this stops the wrong value reaching it in the first place.
//   · The idempotency fingerprint is built from the raw URL — see
//     `routeIdentity` in src/api/idempotency/key.ts, which this does NOT fix
//     because it reads the url rather than the params. That one is fixed there.
//
// ⚠ A GUARD, WHICH IS NOT WHERE THIS OBVIOUSLY BELONGS, FOR A REASON WORTH
// WRITING DOWN. The natural home is a Fastify `preHandler` hook — but
// `fastifyServerOptions()` cannot carry a hook, and there are FORTY-ONE
// `new FastifyAdapter(...)` constructions in this repository, of which main.ts
// is one. A hook registered at the bootstrap would be absent from the other
// forty, so every test would exercise a configuration production does not
// have. That is the STORY-140 defect exactly: boot wiring nothing can fail on.
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

/** Canonicalises in place and reports whether anything changed — exported so a test can assert on the object a handler will see. */
export function canonicaliseParams(params: Record<string, unknown>): boolean {
  let changed = false;
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== "string") continue;
    const canonical = canonicalUuid(value);
    if (canonical !== value) {
      params[name] = canonical;
      changed = true;
    }
  }
  return changed;
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
