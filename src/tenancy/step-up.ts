import { ACCEPTABLE_STEP_UP_METHODS, STEP_UP_WINDOW_MS } from "./constants.js";
import { StepUpRequiredException } from "./errors.js";

// security-and-tenancy.md §5 / NFR-SEC-12 — "a fresh WebAuthn or OTP within 5
// minutes". ONE definition of "fresh", shared by RbacGuard (privileged
// workspace actions) and IdentityService (adding a passkey, STORY-173), so the
// two can never disagree about the window or its edge.
//
// Closed interval: exactly STEP_UP_WINDOW_MS old still passes, refused only
// once strictly older. A session that never re-authenticated strongly
// (lastStrongAuthAt null) is infinitely old — fail closed.
export function assertStepUpFresh(lastStrongAuthAt: Date | null, now: number = Date.now()): void {
  const ageMs = lastStrongAuthAt ? now - lastStrongAuthAt.getTime() : Number.POSITIVE_INFINITY;
  if (ageMs > STEP_UP_WINDOW_MS) {
    throw new StepUpRequiredException(ACCEPTABLE_STEP_UP_METHODS);
  }
}
