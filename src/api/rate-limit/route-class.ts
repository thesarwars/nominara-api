import { SetMetadata } from "@nestjs/common";
import type { RateLimitRouteClass } from "../../../contracts/common/rate-limit.schema.js";

// STORY-025 T17 — deciding which of §12's thirteen rows a request belongs to.
//
// Three of the rows are DEFAULTS keyed on the request itself — §12 names them
// "Auth (`/auth/*`)", "Reads (`GET /*`)" and "Writes". The other ten name a
// specific path, and none of those paths exists in this repository yet: there
// are no runs, no aux audits, no GEO alignment, no command surface, no credit
// packs, no portal and no public reports until EPIC-04 and later.
//
// So classification is DERIVED for the three, DECLARED for the ten. A route
// that needs a specific class says so with `@RateLimitClass()`, and gets it
// whatever its method; everything else falls to the default its method
// implies. That way the ten arrive as one decorator on a route rather than as
// a path-matching table that would have to be kept in step with a router.

export const RATE_LIMIT_CLASS_KEY = "rateLimitClass";

export const RateLimitClass = (routeClass: RateLimitRouteClass): MethodDecorator =>
  SetMetadata(RATE_LIMIT_CLASS_KEY, routeClass);

/**
 * The default class for a request that declares none.
 *
 * Auth first: §12 lists `/auth/*` as its own row, and those routes are `POST`,
 * so a method-first reading would put sign-in under "Writes" at 60/min per
 * user instead of 10/min — six times the reference, on the surface most worth
 * limiting.
 *
 * `GET` is the only method treated as a read. `HEAD` and `OPTIONS` are not in
 * §12 at all; classing them as writes is the conservative reading, and being
 * conservative about a limit is the right direction to be wrong in.
 */
export function defaultRouteClass(method: string, path: string): RateLimitRouteClass {
  if (path.includes("/auth/")) return "auth";
  return method.toUpperCase() === "GET" ? "reads" : "writes";
}
