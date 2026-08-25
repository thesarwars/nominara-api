import { SetMetadata } from "@nestjs/common";

// STORY-024 T8 — the response envelope's ONLY exemption marker.
//
// It exists as its own decorator, rather than the envelope interceptor
// keying off `@Public()`, because `@Public()` is not probe-specific: it sits
// on seven real authentication routes (passkey options/verify, refresh, both
// OAuth start routes, the OAuth callback, and STORY-016's two OTP routes),
// every one of which api-specification.md §1 requires to carry the envelope.
// Keying the exemption on `@Public()` would fix the orchestrator probe and
// silently drop the envelope across the whole authentication surface —
// see test/integration/envelope-scope-and-probe-exemption.spec.ts, which
// asserts both halves.
//
// MethodDecorator & ClassDecorator: HealthController already carries a
// class-level `@Public()`, and marking its probes as a group is the intent.
export const NO_ENVELOPE_KEY = "noEnvelope";

export const NoEnvelope = (): MethodDecorator & ClassDecorator => SetMetadata(NO_ENVELOPE_KEY, true);
