import { SetMetadata } from "@nestjs/common";

// STORY-025 T16 — marks a route as requiring `Idempotency-Key`.
//
// `NFR-API-07`: the header is "ENFORCED, not merely accepted, on every
// endpoint that spends credits, calls an external system, or mints a secret."
// None of those endpoints exists yet — there is no credit ledger until
// EPIC-10, no engine adapter until EPIC-04, and no API-key mint until
// STORY-021's follow-on. So the marker is the deliverable, and the routes
// that need it inherit an enforced mechanism rather than a convention.
//
// A MARKER, not a configuration. There is deliberately nothing to tune here:
// no per-route window, no per-route key derivation. A route that needed its
// own window would be a route whose replay semantics differ from every other,
// and that is a specification change, not a decorator argument.
//
// Method-only, for the same reason `@ApiContract()` is: a class-level
// application would silently mark every route on a controller, and enforcing
// idempotency on a plain GET would refuse ordinary reads.
export const IDEMPOTENT_KEY = "idempotent";

export const Idempotent = (): MethodDecorator => SetMetadata(IDEMPOTENT_KEY, true);
